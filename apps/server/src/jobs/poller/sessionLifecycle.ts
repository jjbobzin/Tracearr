/**
 * Session Lifecycle Operations
 *
 * Shared atomic operations for session creation and termination.
 * Used by both the Poller and SSE processor to ensure consistent handling.
 */

import {
  SESSION_WRITE_RETRY,
  TIME_MS,
  type ActiveSession,
  type RuleV2,
  type Server,
  type ServerUser,
  type Session,
  type StreamDetailFields,
} from '@tracearr/shared';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { serverUsers, sessions, violations } from '../../db/schema.js';
import type { GeoLocation } from '../../services/geoip.js';
import {
  evaluateRulesAsync,
  hasPauseConditions,
  hasTranscodeConditions,
} from '../../services/rules/engine.js';
import { executeActions, type ActionResult } from '../../services/rules/executors/index.js';
import type { EvaluationContext, EvaluationResult } from '../../services/rules/types.js';
import { storeActionResults } from '../../services/rules/v2Integration.js';
import { clearDbWriteTracking } from './dbWriteThrottle.js';
import { pickStreamDetailFields } from './sessionMapper.js';
import {
  calculateStopDuration,
  checkWatchCompletion,
  shouldRecordSession,
} from './stateTracker.js';
import type {
  CompositeSessionIdentity,
  MediaChangeInput,
  MediaChangeResult,
  PauseReEvalInput,
  PendingSessionData,
  QualityChangeResult,
  SessionCreationInput,
  SessionCreationResult,
  SessionIdentity,
  SessionStopInput,
  SessionStopResult,
  TranscodeReEvalInput,
} from './types.js';
import type { ViolationInsertResult } from './violations.js';

// ============================================================================
// Serialization Retry Logic
// ============================================================================

// Constants for serializable transaction retry logic
const MAX_SERIALIZATION_RETRIES = 3;
const SERIALIZATION_RETRY_BASE_MS = 50; // P2-7: Increased from 10ms for better backoff
const TRANSACTION_TIMEOUT_MS = 10000; // P2-8: 10 second timeout for transactions

// Time bound for active session queries to limit TimescaleDB chunk scanning.
// Active sessions should only exist in recent chunks - anything older would have
// been force-stopped by the stale session sweep. 7 days gives ample buffer.
const ACTIVE_SESSION_CHUNK_BOUND_MS = 7 * 24 * 60 * 60 * 1000;

// Bound for the STEP 2 resume-detection query below. A resumable session's
// startedAt can precede the 24h stoppedAt resume window by up to its own
// wall-clock duration (e.g. a live TV session kept alive for days by polling),
// so the bound has to cover the resume window plus the max in-scope duration.
const RESUME_CHUNK_BOUND_MS = ACTIVE_SESSION_CHUNK_BOUND_MS + TIME_MS.DAY;

/**
 * Check if an error is a PostgreSQL serialization failure.
 * These occur when SERIALIZABLE transactions conflict.
 */
function isSerializationError(error: unknown): boolean {
  if (error instanceof Error) {
    // PostgreSQL error code 40001 = serialization_failure
    // The error message typically contains "could not serialize access"
    const message = error.message.toLowerCase();
    return (
      message.includes('could not serialize access') ||
      message.includes('serialization') ||
      (error as { code?: string }).code === '40001'
    );
  }
  return false;
}

// ============================================================================
// ActiveSession Builder
// ============================================================================

/**
 * Input for building an ActiveSession object
 */
export interface BuildActiveSessionInput {
  /** Session data from database (inserted or existing) */
  session: {
    id: string;
    startedAt: Date;
    lastPausedAt: Date | null;
    pausedDurationMs: number | null;
    referenceId: string | null;
    watched: boolean;
    externalSessionId?: string | null;
  };

  /** Processed session data from media server (extends StreamDetailFields for DRY) */
  processed: StreamDetailFields & {
    sessionKey: string;
    /** Plex Session.id - required for termination (some clients like Plexamp may not have this) */
    plexSessionId?: string;
    state: 'playing' | 'paused';
    mediaType: 'movie' | 'episode' | 'track' | 'live' | 'photo' | 'unknown';
    mediaTitle: string;
    grandparentTitle: string;
    seasonNumber: number | null;
    episodeNumber: number | null;
    year: number;
    thumbPath: string;
    ratingKey: string;
    totalDurationMs: number;
    progressMs: number;
    ipAddress: string;
    playerName: string;
    deviceId: string;
    product: string;
    device: string;
    platform: string;
    quality: string;
    isTranscode: boolean;
    videoDecision: string;
    audioDecision: string;
    bitrate: number;
    // Live TV specific fields
    channelTitle: string | null;
    channelIdentifier: string | null;
    channelThumb: string | null;
    // Music track metadata
    artistName: string | null;
    albumName: string | null;
    trackNumber: number | null;
    discNumber: number | null;
  };

  /** Server user info */
  user: {
    id: string;
    username: string;
    thumbUrl: string | null;
    identityName: string | null;
  };

  /** GeoIP location data */
  geo: GeoLocation;

  /** Server info */
  server: {
    id: string;
    name: string;
    type: 'plex' | 'jellyfin' | 'emby';
  };

  /** Optional overrides for update scenarios */
  overrides?: {
    state?: 'playing' | 'paused';
    lastPausedAt?: Date | null;
    pausedDurationMs?: number;
    watched?: boolean;
  };
}

/**
 * Build an ActiveSession object for cache and broadcast.
 */
export function buildActiveSession(input: BuildActiveSessionInput): ActiveSession {
  const { session, processed, user, geo, server, overrides } = input;

  return {
    // Core identifiers
    id: session.id,
    serverId: server.id,
    serverUserId: user.id,
    sessionKey: processed.sessionKey,

    // State (can be overridden for updates)
    state: overrides?.state ?? processed.state,

    // Media metadata
    mediaType: processed.mediaType,
    mediaTitle: processed.mediaTitle,
    grandparentTitle: processed.grandparentTitle || null,
    seasonNumber: processed.mediaType === 'episode' ? processed.seasonNumber : null,
    episodeNumber: processed.mediaType === 'episode' ? processed.episodeNumber : null,
    year: processed.year || null,
    thumbPath: processed.thumbPath || null,
    ratingKey: processed.ratingKey || null,

    // External session ID (for Plex API calls)
    externalSessionId: session.externalSessionId ?? null,

    // Timing
    startedAt: session.startedAt,
    stoppedAt: null, // Active sessions never have stoppedAt
    durationMs: null, // Calculated on stop

    // Progress
    totalDurationMs: processed.totalDurationMs || null,
    progressMs: processed.progressMs || null,

    // Pause tracking (can be overridden for updates)
    lastPausedAt:
      overrides?.lastPausedAt !== undefined ? overrides.lastPausedAt : session.lastPausedAt,
    pausedDurationMs:
      overrides?.pausedDurationMs !== undefined
        ? overrides.pausedDurationMs
        : (session.pausedDurationMs ?? 0),

    // Resume tracking
    referenceId: session.referenceId,

    // Watch status (can be overridden for updates)
    watched: overrides?.watched !== undefined ? overrides.watched : session.watched,

    // Network/device info
    ipAddress: processed.ipAddress,
    geoLocationName: geo.locationName ?? null,
    geoCity: geo.city,
    geoRegion: geo.region,
    geoCountry: geo.countryCode ?? geo.country,
    geoContinent: geo.continent,
    geoPostal: geo.postal,
    geoLat: geo.lat,
    geoLon: geo.lon,
    geoAsnNumber: geo.asnNumber,
    geoAsnOrganization: geo.asnOrganization,
    playerName: processed.playerName,
    deviceId: processed.deviceId || null,
    product: processed.product || null,
    device: processed.device || null,
    platform: processed.platform,

    // Quality/transcode info
    quality: processed.quality,
    isTranscode: processed.isTranscode,
    videoDecision: processed.videoDecision,
    audioDecision: processed.audioDecision,
    bitrate: processed.bitrate,

    // Stream details (source media, stream output, transcode/subtitle info)
    ...pickStreamDetailFields(processed),

    // Live TV specific fields
    channelTitle: processed.channelTitle,
    channelIdentifier: processed.channelIdentifier,
    channelThumb: processed.channelThumb,
    // Music track metadata
    artistName: processed.artistName,
    albumName: processed.albumName,
    trackNumber: processed.trackNumber,
    discNumber: processed.discNumber,

    // Relationships
    user,
    server: { id: server.id, name: server.name, type: server.type },

    // Termination capability - Plex requires Session.id, some clients (like Plexamp) don't provide it
    canTerminate: server.type !== 'plex' || !!processed.plexSessionId,
  };
}

/**
 * Build an ActiveSession from PendingSessionData for display in Now Playing.
 *
 * Pending sessions are displayed immediately while awaiting confirmation threshold.
 * The session ID is pre-generated when the pending session is created, ensuring
 * the same UUID is used throughout the session lifecycle (pending → confirmed).
 * This eliminates UI flicker and session detail page breaks during transition.
 */
export function buildPendingActiveSession(pendingData: PendingSessionData): ActiveSession {
  const { processed, serverUser, geo, server } = pendingData;

  return {
    // Core identifiers - use pre-generated UUID (stable from creation to DB persistence)
    id: pendingData.id,
    serverId: server.id,
    serverUserId: serverUser.id,
    sessionKey: processed.sessionKey,

    // State
    state: pendingData.currentState,

    // Media metadata
    mediaType: processed.mediaType,
    mediaTitle: processed.mediaTitle,
    grandparentTitle: processed.grandparentTitle || null,
    seasonNumber: processed.mediaType === 'episode' ? processed.seasonNumber : null,
    episodeNumber: processed.mediaType === 'episode' ? processed.episodeNumber : null,
    year: processed.year || null,
    thumbPath: processed.thumbPath || null,
    ratingKey: processed.ratingKey || null,

    // External session ID (for Plex API calls)
    externalSessionId: processed.plexSessionId ?? null,

    // Timing - use pending data timestamps
    startedAt: new Date(pendingData.startedAt),
    stoppedAt: null,
    durationMs: null,

    // Progress
    totalDurationMs: processed.totalDurationMs || null,
    progressMs: processed.progressMs || null,

    // Pause tracking
    lastPausedAt: pendingData.lastPausedAt ? new Date(pendingData.lastPausedAt) : null,
    pausedDurationMs: pendingData.pausedDurationMs,

    // Resume tracking - pending sessions don't have reference ID yet
    referenceId: null,

    // Watch status - not yet determined
    watched: false,

    // Network/device info
    ipAddress: processed.ipAddress,
    geoLocationName: geo.locationName ?? null,
    geoCity: geo.city,
    geoRegion: geo.region,
    geoCountry: geo.countryCode ?? geo.country,
    geoContinent: geo.continent,
    geoPostal: geo.postal,
    geoLat: geo.lat,
    geoLon: geo.lon,
    geoAsnNumber: geo.asnNumber,
    geoAsnOrganization: geo.asnOrganization,
    playerName: processed.playerName,
    deviceId: processed.deviceId || null,
    product: processed.product || null,
    device: processed.device || null,
    platform: processed.platform,

    // Quality/transcode info
    quality: processed.quality,
    isTranscode: processed.isTranscode,
    videoDecision: processed.videoDecision,
    audioDecision: processed.audioDecision,
    bitrate: processed.bitrate,

    // Stream details
    ...pickStreamDetailFields(processed),

    // Live TV specific fields
    channelTitle: processed.channelTitle,
    channelIdentifier: processed.channelIdentifier,
    channelThumb: processed.channelThumb,
    // Music track metadata
    artistName: processed.artistName,
    albumName: processed.albumName,
    trackNumber: processed.trackNumber,
    discNumber: processed.discNumber,

    // Relationships
    user: {
      id: serverUser.id,
      username: serverUser.username,
      thumbUrl: serverUser.thumbUrl,
      identityName: serverUser.identityName,
    },
    server: { id: server.id, name: server.name, type: server.type },

    // Termination capability
    canTerminate: server.type !== 'plex' || !!processed.plexSessionId,

    // Unconfirmed; excludeUncountableSessions drops this from rule evaluation
    pending: true,
  };
}

// ============================================================================
// Session Query Helpers
// ============================================================================

/**
 * Find an active (not stopped) session by SessionIdentity.
 * When ratingKey is provided and non-null, validates the session has matching ratingKey.
 */
export async function findActiveSession(
  identity: SessionIdentity
): Promise<typeof sessions.$inferSelect | null> {
  const { serverId, sessionKey, ratingKey } = identity;
  // Time bound reduces TimescaleDB chunk scanning (only recent chunks can have active sessions)
  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

  // Build conditions array
  const conditions = [
    eq(sessions.serverId, serverId),
    eq(sessions.sessionKey, sessionKey),
    isNull(sessions.stoppedAt),
    gte(sessions.startedAt, chunkBound),
  ];

  // Add ratingKey validation if provided and non-null
  if (ratingKey != null) {
    conditions.push(eq(sessions.ratingKey, ratingKey));
  }

  const rows = await db
    .select()
    .from(sessions)
    .where(and(...conditions))
    .limit(1);

  return rows[0] || null;
}

/** Find an active session by composite identity (JF/Emby). */
export async function findActiveSessionByComposite(
  identity: CompositeSessionIdentity
): Promise<typeof sessions.$inferSelect | null> {
  const { serverId, serverUserId, deviceId, ratingKey } = identity;
  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        eq(sessions.serverUserId, serverUserId),
        deviceId ? eq(sessions.deviceId, deviceId) : isNull(sessions.deviceId),
        eq(sessions.ratingKey, ratingKey),
        isNull(sessions.stoppedAt),
        gte(sessions.startedAt, chunkBound)
      )
    )
    .limit(1);

  return rows[0] || null;
}

/**
 * Find all active (not stopped) sessions matching SessionIdentity.
 * When ratingKey is provided and non-null, validates sessions have matching ratingKey.
 * Use when handling potential duplicates.
 */
export async function findActiveSessionsAll(
  identity: SessionIdentity
): Promise<(typeof sessions.$inferSelect)[]> {
  const { serverId, sessionKey, ratingKey } = identity;
  // Time bound reduces TimescaleDB chunk scanning (only recent chunks can have active sessions)
  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

  // Build conditions array
  const conditions = [
    eq(sessions.serverId, serverId),
    eq(sessions.sessionKey, sessionKey),
    isNull(sessions.stoppedAt),
    gte(sessions.startedAt, chunkBound),
  ];

  // Add ratingKey validation if provided and non-null
  if (ratingKey != null) {
    conditions.push(eq(sessions.ratingKey, ratingKey));
  }

  return db
    .select()
    .from(sessions)
    .where(and(...conditions));
}

function groupActiveSessionRow(
  map: Map<string, (typeof sessions.$inferSelect)[]>,
  key: string,
  row: typeof sessions.$inferSelect
): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(row);
  else map.set(key, [row]);
}

/** Batch equivalent of findActiveSession for a whole poll tick, grouped by sessionKey. */
export async function batchFindActiveSessionsByKey(
  serverId: string,
  sessionKeys: string[]
): Promise<Map<string, (typeof sessions.$inferSelect)[]>> {
  const result = new Map<string, (typeof sessions.$inferSelect)[]>();
  if (sessionKeys.length === 0) return result;

  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        inArray(sessions.sessionKey, [...new Set(sessionKeys)]),
        isNull(sessions.stoppedAt),
        gte(sessions.startedAt, chunkBound)
      )
    )
    .orderBy(desc(sessions.startedAt));

  for (const row of rows) groupActiveSessionRow(result, row.sessionKey, row);
  return result;
}

/** Batch equivalent of findActiveSessionByComposite, grouped by serverUserId+ratingKey. */
export async function batchFindActiveSessionsByComposite(
  serverId: string,
  identities: { serverUserId: string; ratingKey: string }[]
): Promise<Map<string, (typeof sessions.$inferSelect)[]>> {
  const result = new Map<string, (typeof sessions.$inferSelect)[]>();
  if (identities.length === 0) return result;

  const serverUserIds = [...new Set(identities.map((i) => i.serverUserId))];
  const ratingKeys = [...new Set(identities.map((i) => i.ratingKey))];
  const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.serverId, serverId),
        inArray(sessions.serverUserId, serverUserIds),
        inArray(sessions.ratingKey, ratingKeys),
        isNull(sessions.stoppedAt),
        gte(sessions.startedAt, chunkBound)
      )
    )
    .orderBy(desc(sessions.startedAt));

  for (const row of rows) {
    groupActiveSessionRow(result, `${row.serverUserId}::${row.ratingKey}`, row);
  }
  return result;
}

// ============================================================================
// Session Creation
// ============================================================================

/**
 * Build the session list used for rule evaluation context.
 *
 * Excludes stoppedTwinId (the quality-change twin stopped earlier in the
 * same operation but still present in the caller's cache snapshot) and
 * appends triggeringSession unless a session with that id is already
 * present.
 */
export function buildRuleContextSessions(
  activeSessions: Session[],
  triggeringSession: Session,
  stoppedTwinId: string | null | undefined
): Session[] {
  const countableSessions = stoppedTwinId
    ? activeSessions.filter((s) => s.id !== stoppedTwinId)
    : activeSessions;
  return countableSessions.some((s) => s.id === triggeringSession.id)
    ? countableSessions
    : [...countableSessions, triggeringSession];
}

/**
 * Whether the triggering session had a kill job enqueued for it.
 *
 * Reflects enqueue, not execution: reverify can still abort the kill later
 * (session already stopped, rule gone, condition cleared), so this is only
 * ever a prediction that the session may die shortly, not a guarantee.
 */
export function wasTriggeringSessionTargetedForKill(
  actionResults: ActionResult[],
  triggeringSessionId: string
): boolean {
  return actionResults.some(
    (result) =>
      result.action.type === 'kill_stream' &&
      result.enqueuedSessionIds?.includes(triggeringSessionId)
  );
}

/**
 * Clean up the twin stopped by createSessionWithRulesAtomic's quality-change
 * detection (STEP 1): clear its DB-write throttle tracking, remove it from
 * the active-session cache, and publish its stop. Every caller of
 * createSessionWithRulesAtomic/confirmAndPersistSession that can receive a
 * non-null `qualityChange` must run this, or the twin lingers in the cache
 * until TTL with a stale throttle entry and no stop broadcast.
 */
export async function handleQualityChangeFallout(
  qualityChange: QualityChangeResult,
  cacheService: { removeActiveSession: (sessionId: string) => Promise<void> } | null,
  pubSubService: { publish: (event: string, data: unknown) => Promise<void> } | null
): Promise<void> {
  const { stoppedSession } = qualityChange;
  clearDbWriteTracking(stoppedSession.id);
  if (cacheService) {
    await cacheService.removeActiveSession(stoppedSession.id);
  }
  if (pubSubService) {
    await pubSubService.publish('session:stopped', stoppedSession.id);
  }
}

/**
 * Create a session with atomic rule evaluation and violation creation.
 * Handles quality change detection, resume tracking, and rule violations.
 */
export async function createSessionWithRulesAtomic(
  input: SessionCreationInput
): Promise<SessionCreationResult> {
  const {
    processed,
    server,
    serverUser,
    geo,
    activeRulesV2,
    activeSessions,
    recentSessions,
    preGeneratedId,
  } = input;

  let referenceId: string | null = null;
  let qualityChange: QualityChangeResult | null = null;

  // STEP 1: Check for quality change (active session with same user+device+ratingKey)
  if (processed.ratingKey) {
    // Time bound reduces TimescaleDB chunk scanning (only recent chunks can have active sessions)
    const chunkBound = new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);

    const deviceCondition = processed.deviceId
      ? eq(sessions.deviceId, processed.deviceId)
      : isNull(sessions.deviceId);

    const activeSameContent = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverUserId, serverUser.id),
          eq(sessions.ratingKey, processed.ratingKey),
          deviceCondition,
          isNull(sessions.stoppedAt),
          gte(sessions.startedAt, chunkBound)
        )
      )
      .orderBy(desc(sessions.startedAt))
      .limit(1);

    const existingActiveSession = activeSameContent[0];
    if (existingActiveSession) {
      // This is a quality/resolution change during playback
      // Stop the old session atomically with idempotency guard
      const now = new Date();

      // Use stopSessionAtomic for idempotency (prevents double-stop race conditions)
      // preserveWatched=true because playback continues in the new session
      const { wasUpdated } = await stopSessionAtomic({
        session: existingActiveSession,
        stoppedAt: now,
        preserveWatched: true,
      });

      // Only proceed with quality change if we actually stopped the session
      // If wasUpdated=false, another process already stopped it
      if (wasUpdated) {
        // Link to the original session chain
        referenceId = existingActiveSession.referenceId || existingActiveSession.id;

        qualityChange = {
          stoppedSession: {
            id: existingActiveSession.id,
            serverUserId: existingActiveSession.serverUserId,
            sessionKey: existingActiveSession.sessionKey,
            deviceId: existingActiveSession.deviceId,
            ratingKey: existingActiveSession.ratingKey,
          },
          referenceId,
        };

        console.log(
          `[SessionLifecycle] Quality change detected for user ${serverUser.id}, content ${processed.ratingKey}. Old session ${existingActiveSession.id} stopped.`
        );
      } else {
        console.log(
          `[SessionLifecycle] Quality change detected but session ${existingActiveSession.id} was already stopped by another process.`
        );
      }
    }
  }

  // STEP 2: Check for resume tracking (recently stopped session with same content)
  if (!referenceId && processed.ratingKey) {
    const oneDayAgo = new Date(Date.now() - TIME_MS.DAY);
    // Time bound reduces TimescaleDB chunk scanning (mirrors STEP 1 above).
    // Uses RESUME_CHUNK_BOUND_MS, not ACTIVE_SESSION_CHUNK_BOUND_MS: covers any
    // resumable session whose wall-clock duration is at most
    // ACTIVE_SESSION_CHUNK_BOUND_MS. Only live TV channels and stuck sessions
    // kept alive by polling can run longer than that; those rows lose resume
    // chaining here, an accepted tradeoff, and they are already invisible to
    // the stale sweep's own ACTIVE_SESSION_CHUNK_BOUND_MS bound.
    const chunkBound = new Date(Date.now() - RESUME_CHUNK_BOUND_MS);
    const recentSameContent = await db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.serverUserId, serverUser.id),
          eq(sessions.ratingKey, processed.ratingKey),
          gte(sessions.stoppedAt, oneDayAgo),
          gte(sessions.startedAt, chunkBound),
          eq(sessions.watched, false)
        )
      )
      .orderBy(desc(sessions.stoppedAt))
      .limit(1);

    const previousSession = recentSameContent[0];
    if (previousSession && processed.progressMs !== undefined) {
      const prevProgress = previousSession.progressMs || 0;
      if (processed.progressMs >= prevProgress) {
        // This is a resume - link to the first session in the chain
        referenceId = previousSession.referenceId || previousSession.id;
      }
    }
  }

  // STEP 3: Atomic transaction with SERIALIZABLE isolation and retry logic
  // SERIALIZABLE prevents phantom reads that cause duplicate violations
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_SERIALIZATION_RETRIES; attempt++) {
    try {
      const { insertedSession, violationResults, pendingSideEffects } = await db.transaction(
        async (tx) => {
          // Set SERIALIZABLE isolation to prevent duplicate violations from concurrent polls
          // This ensures that if two transactions read the violations table simultaneously,
          // one will be forced to retry after the other commits
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);

          // P2-8: Set transaction timeout to prevent long-running transactions
          // Note: SET LOCAL doesn't support parameterized queries, must use raw value
          await tx.execute(
            sql`SET LOCAL statement_timeout = ${sql.raw(String(TRANSACTION_TIMEOUT_MS))}`
          );

          const insertedRows = await tx
            .insert(sessions)
            .values({
              // Use pre-generated ID if provided (pending sessions), otherwise let DB generate
              ...(preGeneratedId ? { id: preGeneratedId } : {}),
              serverId: server.id,
              serverUserId: serverUser.id,
              sessionKey: processed.sessionKey,
              plexSessionId: processed.plexSessionId || null,
              // Store '' rather than null for an absent media id. Every composite
              // lookup (batchFindActiveSessionsByComposite, findActiveSessionByComposite)
              // and buildCompositeKey coerce a missing ratingKey to '', so storing
              // null here would make each tick's dedup miss the row it wrote last
              // tick and insert a duplicate until the stale sweep.
              ratingKey: processed.ratingKey ?? '',
              state: processed.state,
              mediaType: processed.mediaType,
              mediaTitle: processed.mediaTitle,
              grandparentTitle: processed.grandparentTitle || null,
              seasonNumber: processed.mediaType === 'episode' ? processed.seasonNumber : null,
              episodeNumber: processed.mediaType === 'episode' ? processed.episodeNumber : null,
              year: processed.year || null,
              thumbPath: processed.thumbPath || null,
              startedAt: new Date(),
              lastSeenAt: new Date(),
              totalDurationMs: processed.totalDurationMs || null,
              progressMs: processed.progressMs || null,
              lastPausedAt:
                processed.lastPausedDate ?? (processed.state === 'paused' ? new Date() : null),
              pausedDurationMs: 0,
              referenceId,
              watched: false,
              ipAddress: processed.ipAddress,
              geoLocationName: geo.locationName ?? null,
              geoCity: geo.city,
              geoRegion: geo.region,
              geoCountry: geo.countryCode ?? geo.country,
              geoContinent: geo.continent,
              geoPostal: geo.postal,
              geoLat: geo.lat,
              geoLon: geo.lon,
              geoAsnNumber: geo.asnNumber,
              geoAsnOrganization: geo.asnOrganization,
              playerName: processed.playerName,
              deviceId: processed.deviceId || null,
              product: processed.product || null,
              device: processed.device || null,
              platform: processed.platform,
              quality: processed.quality,
              isTranscode: processed.isTranscode,
              videoDecision: processed.videoDecision,
              audioDecision: processed.audioDecision,
              bitrate: processed.bitrate,
              // Stream details (source media, stream output, transcode/subtitle info)
              ...pickStreamDetailFields(processed),
              // Live TV specific fields
              channelTitle: processed.channelTitle,
              channelIdentifier: processed.channelIdentifier,
              channelThumb: processed.channelThumb,
              // Music track metadata
              artistName: processed.artistName,
              albumName: processed.albumName,
              trackNumber: processed.trackNumber,
              discNumber: processed.discNumber,
            })
            .returning();

          const inserted = insertedRows[0];
          if (!inserted) {
            throw new Error('Failed to insert session');
          }

          await tx
            .update(serverUsers)
            .set({
              lastActivityAt: sql`GREATEST(COALESCE(${serverUsers.lastActivityAt}, ${inserted.startedAt}), ${inserted.startedAt})`,
            })
            .where(eq(serverUsers.id, serverUser.id));

          // Build session object for rule evaluation (matches Session type)
          const session: Session = {
            id: inserted.id,
            serverId: server.id,
            serverUserId: serverUser.id,
            sessionKey: processed.sessionKey,
            state: processed.state,
            mediaType: processed.mediaType,
            mediaTitle: processed.mediaTitle,
            grandparentTitle: processed.grandparentTitle || null,
            seasonNumber: processed.mediaType === 'episode' ? processed.seasonNumber : null,
            episodeNumber: processed.mediaType === 'episode' ? processed.episodeNumber : null,
            year: processed.year || null,
            thumbPath: processed.thumbPath || null,
            ratingKey: processed.ratingKey || null,
            externalSessionId: null,
            startedAt: inserted.startedAt,
            stoppedAt: null,
            durationMs: null,
            totalDurationMs: processed.totalDurationMs || null,
            progressMs: processed.progressMs || null,
            lastPausedAt: inserted.lastPausedAt,
            pausedDurationMs: inserted.pausedDurationMs,
            referenceId: inserted.referenceId,
            watched: inserted.watched,
            ipAddress: processed.ipAddress,
            geoLocationName: geo.locationName ?? null,
            geoCity: geo.city,
            geoRegion: geo.region,
            geoCountry: geo.countryCode ?? geo.country,
            geoContinent: geo.continent,
            geoPostal: geo.postal,
            geoLat: geo.lat,
            geoLon: geo.lon,
            geoAsnNumber: geo.asnNumber,
            geoAsnOrganization: geo.asnOrganization,
            playerName: processed.playerName,
            deviceId: processed.deviceId || null,
            product: processed.product || null,
            device: processed.device || null,
            platform: processed.platform,
            quality: processed.quality,
            isTranscode: processed.isTranscode,
            videoDecision: processed.videoDecision,
            audioDecision: processed.audioDecision,
            bitrate: processed.bitrate,
            // Stream details (source media, stream output, transcode/subtitle info)
            ...pickStreamDetailFields(processed),
            // Live TV specific fields
            channelTitle: processed.channelTitle,
            channelIdentifier: processed.channelIdentifier,
            channelThumb: processed.channelThumb,
            // Music track metadata
            artistName: processed.artistName,
            albumName: processed.albumName,
            trackNumber: processed.trackNumber,
            discNumber: processed.discNumber,
          };

          // Build V2 evaluation context
          const serverObj: Server = {
            id: server.id,
            name: server.name,
            type: server.type,
            url: '', // Not needed for rule evaluation
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const serverUserObj: ServerUser = {
            id: serverUser.id,
            userId: serverUser.userId,
            serverId: server.id,
            externalId: '',
            username: serverUser.username,
            email: null,
            thumbUrl: serverUser.thumbUrl,
            isServerAdmin: false,
            trustScore: serverUser.trustScore,
            sessionCount: serverUser.sessionCount,
            joinedAt: null,
            lastActivityAt: serverUser.lastActivityAt,
            createdAt: serverUser.createdAt,
            removedAt: null,
            updatedAt: new Date(),
            identityName: serverUser.identityName,
          };

          // The quality-change twin was stopped in STEP 1 but still sits in the
          // caller's cache snapshot; counting it doubles this viewer.
          const activeSessionsWithNew = buildRuleContextSessions(
            activeSessions,
            session,
            qualityChange?.stoppedSession.id
          );

          const baseContext: Omit<EvaluationContext, 'rule'> = {
            session,
            serverUser: serverUserObj,
            server: serverObj,
            activeSessions: activeSessionsWithNew,
            recentSessions,
            identityServerUserIds: serverUser.identityServerUserIds,
          };

          // Evaluate V2 rules
          const ruleResults = await evaluateRulesAsync(baseContext, activeRulesV2);

          // Process matched rules - create violations within transaction, queue side effects
          const createdViolations: ViolationInsertResult[] = [];
          const pendingSideEffects: Array<{
            context: EvaluationContext;
            result: EvaluationResult;
            rule: RuleV2;
          }> = [];

          for (const result of ruleResults) {
            if (!result.matched) continue;

            // Find the rule that produced this result
            const rule = activeRulesV2.find((r) => r.id === result.ruleId);
            if (!rule) continue;

            // Every rule match auto-creates a violation. Severity from rule.
            {
              const severity = rule.severity ?? 'warning';

              // Collect related session IDs from evidence
              const allRelatedSessionIds = new Set<string>();
              for (const group of result.evidence ?? []) {
                for (const cond of group.conditions) {
                  for (const id of cond.relatedSessionIds ?? []) {
                    allRelatedSessionIds.add(id);
                  }
                }
              }

              // Insert violation
              const insertedViolations = await tx
                .insert(violations)
                .values({
                  ruleId: rule.id,
                  serverUserId: serverUser.id,
                  sessionId: inserted.id,
                  severity,
                  ruleType: null, // V2 rules don't have a type field
                  data: {
                    evidence: result.evidence,
                    relatedSessionIds: Array.from(allRelatedSessionIds),
                    ruleName: rule.name,
                    matchedGroups: result.matchedGroups,
                    sessionKey: session.sessionKey,
                    mediaTitle: session.mediaTitle,
                    ipAddress: session.ipAddress,
                  },
                })
                .onConflictDoNothing()
                .returning();

              const violation = insertedViolations[0];

              if (violation) {
                // Create rule info for ViolationInsertResult (V2 rules don't have type)
                const ruleInfo = {
                  id: rule.id,
                  name: rule.name,
                  type: null, // V2 rules don't have a type
                };

                createdViolations.push({
                  violation,
                  rule: ruleInfo,
                });
              }
            }

            // Queue actions for execution after transaction
            if (result.actions.length > 0) {
              pendingSideEffects.push({
                context: { ...baseContext, rule },
                result,
                rule,
              });
            }
          }

          return {
            insertedSession: inserted,
            violationResults: createdViolations,
            pendingSideEffects,
          };
        }
      );

      // Execute side effect actions after transaction commits
      let wasTerminatedByRule = false;

      for (const { context, result, rule } of pendingSideEffects) {
        // Find violation ID if one was created for this rule - kill_stream needs
        // it before executing so the kill queue can attribute its eventual
        // outcome (killed/skipped/failed) back to the right violation.
        const violationId =
          violationResults.find((v) => v.rule.id === rule.id)?.violation.id ?? null;

        const actionResults: ActionResult[] = await executeActions(
          { ...context, violationId },
          result.actions
        );

        // A kill job was actually enqueued for the triggering session - not a
        // prediction made before actions ran, so it stays accurate even if
        // reverify later aborts the kill (the session just gets re-added on
        // the next poll tick since it's still in the server's response).
        if (wasTriggeringSessionTargetedForKill(actionResults, insertedSession.id)) {
          wasTerminatedByRule = true;
        }

        // Store results for UI
        await storeActionResults(violationId, result.ruleId, actionResults);
      }

      // Transaction succeeded, return result
      return {
        insertedSession,
        violationResults,
        qualityChange,
        referenceId,
        wasTerminatedByRule,
      };
    } catch (error) {
      lastError = error;

      // Check if this is a serialization error that we can retry
      if (isSerializationError(error) && attempt < MAX_SERIALIZATION_RETRIES) {
        // Exponential backoff: 10ms, 20ms, 40ms
        const delayMs = SERIALIZATION_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        console.log(
          `[SessionLifecycle] Serialization conflict on attempt ${attempt}/${MAX_SERIALIZATION_RETRIES}, retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // Not a serialization error or max retries exceeded - rethrow
      throw error;
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}

// ============================================================================
// Pending Session Confirmation
// ============================================================================

/**
 * Input for confirming a pending session (persisting from Redis to DB).
 */
export interface ConfirmPendingSessionInput {
  /** Pending session data from Redis */
  pendingData: PendingSessionData;
  /** Active V2 rules to evaluate */
  activeRulesV2: RuleV2[];
  /** Active sessions for rule context */
  activeSessions: Session[];
  /** Recent sessions for rule evaluation */
  recentSessions: Session[];
}

/**
 * Confirm and persist a pending session to the database with rule evaluation.
 *
 * Called when a pending session meets the 30s confirmation threshold.
 * This function delegates to createSessionWithRulesAtomic but ensures
 * the startedAt reflects when the session actually started (not when confirmed).
 *
 * @param input - Pending session data and rule context
 * @returns Session creation result with any violations
 */
export async function confirmAndPersistSession(
  input: ConfirmPendingSessionInput
): Promise<SessionCreationResult> {
  const { pendingData, activeRulesV2, activeSessions, recentSessions } = input;
  const { processed, server, serverUser, geo } = pendingData;

  // Delegate to createSessionWithRulesAtomic for atomic rule evaluation
  // The session will be created with current state from the pending data
  // Use the pre-generated UUID from pending data for stable ID throughout lifecycle
  const result = await createSessionWithRulesAtomic({
    processed: {
      ...processed,
      // Use the current state from pending data (may have changed from initial)
      state: pendingData.currentState as 'playing' | 'paused',
      // Pass lastPausedDate for initial pause state detection
      lastPausedDate: pendingData.lastPausedAt ? new Date(pendingData.lastPausedAt) : undefined,
    },
    server,
    serverUser,
    geo,
    activeRulesV2,
    activeSessions,
    recentSessions,
    // Use the pre-generated UUID - ensures same ID from pending to confirmed state
    preGeneratedId: pendingData.id,
  });

  // Update the session with correct timing from pending data:
  // - startedAt: When the session actually started (not when confirmed)
  // - pausedDurationMs: Accumulated pause time while pending
  // This ensures accurate watch duration calculations
  const actualStartedAt = new Date(pendingData.startedAt);
  const timeDriftMs = Date.now() - pendingData.startedAt;

  // Only update if there's meaningful drift (> 1 second)
  // This accounts for the time between session start and confirmation
  if (timeDriftMs > 1000) {
    // Use latest progress from confirmation state (may have advanced during pending phase)
    const latestProgressMs = pendingData.confirmation.maxViewOffset;

    await db
      .update(sessions)
      .set({
        startedAt: actualStartedAt,
        pausedDurationMs: pendingData.pausedDurationMs,
        lastPausedAt: pendingData.lastPausedAt ? new Date(pendingData.lastPausedAt) : null,
        ...(latestProgressMs > 0 && { progressMs: latestProgressMs }),
      })
      .where(eq(sessions.id, result.insertedSession.id));

    // Update the returned session object to reflect the correct values
    result.insertedSession.startedAt = actualStartedAt;
    result.insertedSession.pausedDurationMs = pendingData.pausedDurationMs;
    result.insertedSession.lastPausedAt = pendingData.lastPausedAt
      ? new Date(pendingData.lastPausedAt)
      : null;
    if (latestProgressMs > 0) {
      result.insertedSession.progressMs = latestProgressMs;
    }

    console.log(
      `[SessionLifecycle] Confirmed pending session ${result.insertedSession.id} ` +
        `(started ${Math.round(timeDriftMs / 1000)}s ago, paused ${Math.round(pendingData.pausedDurationMs / 1000)}s)`
    );
  }

  return result;
}

// ============================================================================
// Session Stop
// ============================================================================

/**
 * Stop a session atomically. Returns wasUpdated=false if already stopped.
 * Implements bounded retry logic for transient DB failures.
 */
export async function stopSessionAtomic(input: SessionStopInput): Promise<SessionStopResult> {
  const { session, stoppedAt, forceStopped = false, preserveWatched = false } = input;

  const { durationMs, finalPausedDurationMs } = calculateStopDuration(
    {
      startedAt: session.startedAt,
      lastPausedAt: session.lastPausedAt,
      pausedDurationMs: session.pausedDurationMs ?? 0,
      progressMs: session.progressMs,
      totalDurationMs: session.totalDurationMs,
    },
    stoppedAt
  );

  // For quality changes (preserveWatched=true), keep the existing watched status
  // since playback is continuing in a new session
  const watched = preserveWatched
    ? session.watched
    : session.watched ||
      checkWatchCompletion(durationMs, session.progressMs, session.totalDurationMs);

  const shortSession = !shouldRecordSession(durationMs);

  // Retry loop for transient DB failures (connection errors, timeouts, etc.)
  let lastError: unknown;
  for (let attempt = 1; attempt <= SESSION_WRITE_RETRY.IMMEDIATE_RETRIES; attempt++) {
    try {
      // Use conditional update for idempotency - only stop if not already stopped
      // This prevents race conditions when multiple stop events arrive concurrently
      const result = await db
        .update(sessions)
        .set({
          state: 'stopped',
          stoppedAt,
          durationMs,
          pausedDurationMs: finalPausedDurationMs,
          lastPausedAt: null,
          watched,
          shortSession,
          ...(forceStopped && { forceStopped: true }),
        })
        .where(and(eq(sessions.id, session.id), isNull(sessions.stoppedAt)))
        .returning({ id: sessions.id });

      // Return whether the update was applied (for caller to skip cache/broadcast if already stopped)
      const wasUpdated = result.length > 0;

      return { durationMs, watched, shortSession, wasUpdated };
    } catch (error) {
      lastError = error;
      if (attempt < SESSION_WRITE_RETRY.IMMEDIATE_RETRIES) {
        const delayMs = SESSION_WRITE_RETRY.IMMEDIATE_BACKOFF_MS * Math.pow(2, attempt - 1);
        console.log(
          `[SessionLifecycle] DB write failed on attempt ${attempt}/${SESSION_WRITE_RETRY.IMMEDIATE_RETRIES}, retrying in ${delayMs}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // All retries failed - return needsRetry for caller to queue for later processing
  console.error(
    `[SessionLifecycle] All ${SESSION_WRITE_RETRY.IMMEDIATE_RETRIES} attempts failed for session ${session.id}:`,
    lastError
  );

  return {
    durationMs,
    watched,
    shortSession,
    wasUpdated: false,
    needsRetry: true,
    retryData: { stoppedAt: stoppedAt.getTime(), forceStopped },
  };
}

// ============================================================================
// Media Change Handling
// ============================================================================

/**
 * Handle media change scenario: stop old session, create new session.
 *
 * Used when sessionKey is reused but content changes (e.g., Emby "Play Next Episode").
 * This is the inverse of quality change:
 * - Quality change: Same ratingKey, different sessionKey
 * - Media change: Same sessionKey, different ratingKey
 *
 * @param input - Media change input with existing session and new media data
 * @returns Result with stopped session and newly created session, or null if stop failed
 */
export async function handleMediaChangeAtomic(
  input: MediaChangeInput
): Promise<MediaChangeResult | null> {
  const {
    existingSession,
    processed,
    server,
    serverUser,
    geo,
    activeRulesV2,
    activeSessions,
    recentSessions,
  } = input;

  console.log(
    `[SessionLifecycle] Media change detected: ${existingSession.ratingKey} -> ${processed.ratingKey}`
  );

  // STEP 1: Stop the old session atomically
  const now = new Date();
  const { wasUpdated } = await stopSessionAtomic({
    session: existingSession,
    stoppedAt: now,
  });

  if (!wasUpdated) {
    console.log(
      `[SessionLifecycle] Media change detected but session ${existingSession.id} was already stopped by another process.`
    );
    return null;
  }

  // STEP 2: Create new session for the new media
  const { insertedSession, violationResults, wasTerminatedByRule, qualityChange } =
    await createSessionWithRulesAtomic({
      processed,
      server,
      serverUser,
      geo,
      activeRulesV2,
      // The old-media session was stopped above; the caller's snapshot
      // predates that stop.
      activeSessions: activeSessions.filter((s) => s.id !== existingSession.id),
      recentSessions,
    });

  return {
    stoppedSession: {
      id: existingSession.id,
      serverUserId: existingSession.serverUserId,
      sessionKey: existingSession.sessionKey,
    },
    insertedSession,
    violationResults,
    wasTerminatedByRule,
    qualityChange,
  };
}

// ============================================================================
// Poll Result Processing
// ============================================================================

/**
 * Notification types used during poll processing
 */
type PollNotification =
  | { type: 'session_started'; payload: ActiveSession }
  | { type: 'session_stopped'; payload: ActiveSession };

/**
 * Input for processing poll results
 */
export interface PollResultsInput {
  /** Newly created sessions */
  newSessions: ActiveSession[];
  /** Keys of stopped sessions in format "serverId:sessionKey" */
  stoppedKeys: string[];
  /** Sessions that were updated */
  updatedSessions: ActiveSession[];
  /** Whether any session crossed the watched-completion threshold this tick */
  watchedTransitionOccurred: boolean;
  /** Cached sessions for looking up stopped session details */
  cachedSessions: ActiveSession[];
  /** Cache service for persistence */
  cacheService: {
    incrementalSyncActiveSessions: (
      newSessions: ActiveSession[],
      stoppedIds: string[],
      updatedSessions: ActiveSession[],
      watchedTransitionOccurred?: boolean
    ) => Promise<void>;
  } | null;
  /** PubSub service for broadcasting */
  pubSubService: {
    publish: (event: string, data: unknown) => Promise<void>;
  } | null;
  /** Notification enqueue function */
  enqueueNotification: (notification: PollNotification) => Promise<unknown>;
  /**
   * IDs (subset of newSessions) confirmed from a pending entry rather than
   * created fresh. The pending create already published session:started and
   * enqueued session_started, so both are skipped here for these ids.
   */
  confirmedFromPendingIds?: Set<string>;
}

/**
 * Find a stopped session from cached sessions by serverId:sessionKey format
 */
function findStoppedSession(
  key: string,
  cachedSessions: ActiveSession[]
): ActiveSession | undefined {
  const parts = key.split(':');
  if (parts.length < 2) return undefined;
  const serverId = parts[0];
  const sessionKey = parts.slice(1).join(':');
  return cachedSessions.find((s) => s.serverId === serverId && s.sessionKey === sessionKey);
}

/**
 * Process poll results: sync cache and broadcast events.
 */
export async function processPollResults(input: PollResultsInput): Promise<void> {
  const {
    newSessions,
    stoppedKeys,
    updatedSessions,
    watchedTransitionOccurred,
    cachedSessions,
    cacheService,
    pubSubService,
    enqueueNotification,
    confirmedFromPendingIds,
  } = input;

  // Extract stopped session IDs from the key format "serverId:sessionKey"
  const stoppedSessionIds: string[] = [];
  for (const key of stoppedKeys) {
    const stoppedSession = findStoppedSession(key, cachedSessions);
    if (stoppedSession) {
      stoppedSessionIds.push(stoppedSession.id);
    }
  }

  // Update cache incrementally
  if (cacheService) {
    // Incremental sync: adds new, removes stopped, updates existing
    await cacheService.incrementalSyncActiveSessions(
      newSessions,
      stoppedSessionIds,
      updatedSessions,
      watchedTransitionOccurred
    );
  }

  // Publish events via pub/sub
  if (pubSubService) {
    for (const session of newSessions) {
      // Sessions confirmed from a pending entry already got both of these
      // at pending create - re-sending here would double the SSE event and
      // the user-facing notification.
      if (confirmedFromPendingIds?.has(session.id)) continue;
      await pubSubService.publish('session:started', session);
      await enqueueNotification({ type: 'session_started', payload: session });
    }

    // No consumer reads the payload, so one tick's updates collapse to a single publish.
    if (updatedSessions.length > 0) {
      await pubSubService.publish('session:updated', updatedSessions[0]);
    }

    for (const key of stoppedKeys) {
      const stoppedSession = findStoppedSession(key, cachedSessions);
      if (stoppedSession) {
        // Fetch the computed durationMs from DB since the cached session has stale data
        const [dbSession] = await db
          .select({ durationMs: sessions.durationMs })
          .from(sessions)
          .where(eq(sessions.id, stoppedSession.id));
        const durationMs = dbSession?.durationMs ?? stoppedSession.durationMs;
        await pubSubService.publish('session:stopped', stoppedSession.id);
        await enqueueNotification({
          type: 'session_stopped',
          payload: { ...stoppedSession, durationMs },
        });
      }
    }
  }
}

// ============================================================================
// Transcode State Change Re-evaluation
// ============================================================================

/**
 * Re-evaluate V2 rules when an existing session's transcode state changes.
 *
 * Only rules containing transcode-related conditions (is_transcoding, is_transcode_downgrade,
 * output_resolution) are evaluated. This prevents false positives from rules that only check
 * conditions like concurrent_streams which are already evaluated at session creation.
 *
 * Deduplication: checks for existing violations per (ruleId, sessionId) before inserting,
 * since the DB unique index uses ruleType which is NULL for V2 rules.
 */
export async function reEvaluateRulesOnTranscodeChange(
  input: TranscodeReEvalInput
): Promise<ViolationInsertResult[]> {
  const {
    existingSession,
    processed,
    server,
    serverUser,
    activeRulesV2,
    activeSessions,
    recentSessions,
  } = input;

  // Filter to only rules that have transcode-related conditions
  const transcodeRules = activeRulesV2.filter(hasTranscodeConditions);
  if (transcodeRules.length === 0) return [];

  // Build Session object from existing session + updated transcode fields
  const session: Session = {
    id: existingSession.id,
    serverId: existingSession.serverId,
    serverUserId: existingSession.serverUserId,
    sessionKey: existingSession.sessionKey,
    externalSessionId: existingSession.externalSessionId,
    state: processed.state,
    mediaType: processed.mediaType,
    mediaTitle: processed.mediaTitle,
    grandparentTitle: processed.grandparentTitle || null,
    seasonNumber: processed.mediaType === 'episode' ? processed.seasonNumber : null,
    episodeNumber: processed.mediaType === 'episode' ? processed.episodeNumber : null,
    year: processed.year || null,
    thumbPath: processed.thumbPath || null,
    ratingKey: existingSession.ratingKey,
    startedAt: existingSession.startedAt,
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: processed.totalDurationMs || null,
    progressMs: processed.progressMs || null,
    lastPausedAt: existingSession.lastPausedAt,
    pausedDurationMs: existingSession.pausedDurationMs,
    referenceId: existingSession.referenceId,
    watched: existingSession.watched,
    ipAddress: existingSession.ipAddress,
    geoLocationName: existingSession.geoLocationName,
    geoCity: existingSession.geoCity,
    geoRegion: existingSession.geoRegion,
    geoCountry: existingSession.geoCountry,
    geoContinent: existingSession.geoContinent,
    geoPostal: existingSession.geoPostal,
    geoLat: existingSession.geoLat,
    geoLon: existingSession.geoLon,
    geoAsnNumber: existingSession.geoAsnNumber,
    geoAsnOrganization: existingSession.geoAsnOrganization,
    playerName: processed.playerName,
    deviceId: processed.deviceId || null,
    product: processed.product || null,
    device: processed.device || null,
    platform: processed.platform,
    quality: processed.quality,
    // Updated transcode fields (the reason for re-evaluation)
    isTranscode: processed.isTranscode,
    videoDecision: processed.videoDecision,
    audioDecision: processed.audioDecision,
    bitrate: processed.bitrate,
    ...pickStreamDetailFields(processed),
    channelTitle: existingSession.channelTitle,
    channelIdentifier: existingSession.channelIdentifier,
    channelThumb: existingSession.channelThumb,
    artistName: existingSession.artistName,
    albumName: existingSession.albumName,
    trackNumber: existingSession.trackNumber,
    discNumber: existingSession.discNumber,
  };

  const serverObj: Server = {
    id: server.id,
    name: server.name,
    type: server.type as Server['type'],
    url: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const serverUserObj: ServerUser = {
    id: serverUser.id,
    userId: serverUser.userId,
    serverId: server.id,
    externalId: '',
    username: serverUser.username,
    email: null,
    thumbUrl: serverUser.thumbUrl,
    isServerAdmin: false,
    trustScore: serverUser.trustScore,
    sessionCount: serverUser.sessionCount,
    joinedAt: null,
    lastActivityAt: serverUser.lastActivityAt,
    createdAt: serverUser.createdAt,
    removedAt: null,
    updatedAt: new Date(),
    identityName: serverUser.identityName,
  };

  const baseContext: Omit<EvaluationContext, 'rule'> = {
    session,
    serverUser: serverUserObj,
    server: serverObj,
    // Append the re-evaluated session to its own context. Callers pass the
    // grace-filtered active list (excludeUncountableSessions), which drops this
    // session while it is grace-flagged, so without the append a trigger is
    // absent from its own re-eval context and self-undercounts (missed kill).
    activeSessions: buildRuleContextSessions(activeSessions, session, null),
    recentSessions,
    identityServerUserIds: serverUser.identityServerUserIds,
  };

  // Evaluate only transcode-related rules
  const ruleResults = await evaluateRulesAsync(baseContext, transcodeRules);

  const createdViolations: ViolationInsertResult[] = [];

  for (const result of ruleResults) {
    if (!result.matched) continue;

    const rule = transcodeRules.find((r) => r.id === result.ruleId);
    if (!rule) continue;

    // Every rule match auto-creates a violation. Severity from rule.
    const severity = rule.severity ?? 'warning';

    // Use a transaction with advisory lock to prevent duplicate violations.
    // The DB unique index uses ruleType (NULL for V2), and NULL != NULL in PG,
    // so onConflictDoNothing can't catch V2 duplicates. The advisory lock
    // serializes concurrent SSE + reconciliation poll attempts for the same
    // session+rule pair, and the transaction ensures atomicity of the dedup check + insert.
    const violationResult = await db.transaction(async (tx) => {
      // Advisory lock scoped to this session+rule pair.
      // Released automatically when the transaction commits/rolls back.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${existingSession.id} || '::' || ${rule.id}))`
      );

      // Dedup check (now race-free under advisory lock)
      const existing = await tx
        .select({ id: violations.id })
        .from(violations)
        .where(
          and(
            eq(violations.ruleId, rule.id),
            eq(violations.sessionId, existingSession.id),
            isNull(violations.acknowledgedAt)
          )
        )
        .limit(1);

      if (existing[0]) return null; // Already has a violation for this rule + session

      // Collect related session IDs from evidence
      const allRelatedSessionIds = new Set<string>();
      for (const group of result.evidence ?? []) {
        for (const cond of group.conditions) {
          for (const id of cond.relatedSessionIds ?? []) {
            allRelatedSessionIds.add(id);
          }
        }
      }

      const insertedViolations = await tx
        .insert(violations)
        .values({
          ruleId: rule.id,
          serverUserId: serverUser.id,
          sessionId: existingSession.id,
          severity,
          ruleType: null,
          data: {
            evidence: result.evidence,
            relatedSessionIds: Array.from(allRelatedSessionIds),
            ruleName: rule.name,
            matchedGroups: result.matchedGroups,
            sessionKey: session.sessionKey,
            mediaTitle: session.mediaTitle,
            ipAddress: session.ipAddress,
            transcodeReEval: true,
          },
        })
        .onConflictDoNothing()
        .returning();

      const violation = insertedViolations[0];
      if (!violation) return null;

      return violation;
    });

    if (violationResult) {
      const ruleInfo = {
        id: rule.id,
        name: rule.name,
        type: null,
      };

      createdViolations.push({ violation: violationResult, rule: ruleInfo });

      console.log(
        `[rules] Transcode re-eval: rule "${rule.name}" matched session ${existingSession.id}`
      );

      // Execute actions (e.g., kill_stream, send_notification) only when
      // a new violation was created. Gating here prevents actions from firing
      // on subsequent re-evaluations where the dedup check returns null.
      if (result.actions.length > 0) {
        const context: EvaluationContext = {
          ...baseContext,
          rule,
          violationId: violationResult.id,
        };
        const actionResults: ActionResult[] = await executeActions(context, result.actions);
        await storeActionResults(violationResult.id, result.ruleId, actionResults);
      }
    }
  }

  return createdViolations;
}

/**
 * Re-evaluate V2 rules that have pause-related conditions for a paused session.
 *
 * Only rules containing `current_pause_minutes` or `total_pause_minutes` conditions
 * are evaluated to minimize overhead.
 */
export async function reEvaluateRulesOnPauseState(
  input: PauseReEvalInput
): Promise<ViolationInsertResult[]> {
  const {
    existingSession,
    processed,
    pauseData,
    server,
    serverUser,
    activeRulesV2,
    activeSessions,
    recentSessions,
  } = input;

  // Filter to only rules that have pause-related conditions
  const pauseRules = activeRulesV2.filter(hasPauseConditions);
  if (pauseRules.length === 0) return [];

  // Build Session object with updated pause fields
  const session: Session = {
    id: existingSession.id,
    serverId: existingSession.serverId,
    serverUserId: existingSession.serverUserId,
    sessionKey: existingSession.sessionKey,
    externalSessionId: existingSession.externalSessionId,
    state: processed.state,
    mediaType: processed.mediaType,
    mediaTitle: processed.mediaTitle,
    grandparentTitle: processed.grandparentTitle || null,
    seasonNumber: processed.mediaType === 'episode' ? processed.seasonNumber : null,
    episodeNumber: processed.mediaType === 'episode' ? processed.episodeNumber : null,
    year: processed.year || null,
    thumbPath: processed.thumbPath || null,
    ratingKey: existingSession.ratingKey,
    startedAt: existingSession.startedAt,
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: processed.totalDurationMs || null,
    progressMs: processed.progressMs || null,
    lastPausedAt: pauseData.lastPausedAt,
    pausedDurationMs: pauseData.pausedDurationMs,
    referenceId: existingSession.referenceId,
    watched: existingSession.watched,
    ipAddress: existingSession.ipAddress,
    geoLocationName: existingSession.geoLocationName,
    geoCity: existingSession.geoCity,
    geoRegion: existingSession.geoRegion,
    geoCountry: existingSession.geoCountry,
    geoContinent: existingSession.geoContinent,
    geoPostal: existingSession.geoPostal,
    geoLat: existingSession.geoLat,
    geoLon: existingSession.geoLon,
    geoAsnNumber: existingSession.geoAsnNumber,
    geoAsnOrganization: existingSession.geoAsnOrganization,
    playerName: processed.playerName,
    deviceId: processed.deviceId || null,
    product: processed.product || null,
    device: processed.device || null,
    platform: processed.platform,
    quality: processed.quality,
    isTranscode: processed.isTranscode,
    videoDecision: processed.videoDecision,
    audioDecision: processed.audioDecision,
    bitrate: processed.bitrate,
    ...pickStreamDetailFields(processed),
    channelTitle: existingSession.channelTitle,
    channelIdentifier: existingSession.channelIdentifier,
    channelThumb: existingSession.channelThumb,
    artistName: existingSession.artistName,
    albumName: existingSession.albumName,
    trackNumber: existingSession.trackNumber,
    discNumber: existingSession.discNumber,
  };

  const serverObj: Server = {
    id: server.id,
    name: server.name,
    type: server.type as Server['type'],
    url: '',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const serverUserObj: ServerUser = {
    id: serverUser.id,
    userId: serverUser.userId,
    serverId: server.id,
    externalId: '',
    username: serverUser.username,
    email: null,
    thumbUrl: serverUser.thumbUrl,
    isServerAdmin: false,
    trustScore: serverUser.trustScore,
    sessionCount: serverUser.sessionCount,
    joinedAt: null,
    lastActivityAt: serverUser.lastActivityAt,
    createdAt: serverUser.createdAt,
    removedAt: null,
    updatedAt: new Date(),
    identityName: serverUser.identityName,
  };

  const baseContext: Omit<EvaluationContext, 'rule'> = {
    session,
    serverUser: serverUserObj,
    server: serverObj,
    // Append the re-evaluated session to its own context. Callers pass the
    // grace-filtered active list (excludeUncountableSessions), which drops this
    // session while it is grace-flagged, so without the append a trigger is
    // absent from its own re-eval context and self-undercounts (missed kill).
    activeSessions: buildRuleContextSessions(activeSessions, session, null),
    recentSessions,
    identityServerUserIds: serverUser.identityServerUserIds,
  };

  // Evaluate only pause-related rules
  const ruleResults = await evaluateRulesAsync(baseContext, pauseRules);

  const createdViolations: ViolationInsertResult[] = [];

  for (const result of ruleResults) {
    if (!result.matched) continue;

    const rule = pauseRules.find((r) => r.id === result.ruleId);
    if (!rule) continue;

    // Every rule match auto-creates a violation. Severity from rule.
    const severity = rule.severity ?? 'warning';

    const violationResult = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${existingSession.id} || '::' || ${rule.id}))`
      );

      // Dedup check, prevents duplicate violation for same session+rule
      const existing = await tx
        .select({ id: violations.id })
        .from(violations)
        .where(
          and(
            eq(violations.ruleId, rule.id),
            eq(violations.sessionId, existingSession.id),
            isNull(violations.acknowledgedAt)
          )
        )
        .limit(1);

      if (existing[0]) return null;

      // Collect related session IDs from evidence
      const allRelatedSessionIds = new Set<string>();
      for (const group of result.evidence ?? []) {
        for (const cond of group.conditions) {
          for (const id of cond.relatedSessionIds ?? []) {
            allRelatedSessionIds.add(id);
          }
        }
      }

      const insertedViolations = await tx
        .insert(violations)
        .values({
          ruleId: rule.id,
          serverUserId: serverUser.id,
          sessionId: existingSession.id,
          severity,
          ruleType: null,
          data: {
            evidence: result.evidence,
            relatedSessionIds: Array.from(allRelatedSessionIds),
            ruleName: rule.name,
            matchedGroups: result.matchedGroups,
            sessionKey: session.sessionKey,
            mediaTitle: session.mediaTitle,
            ipAddress: session.ipAddress,
            pauseReEval: true,
          },
        })
        .onConflictDoNothing()
        .returning();

      const violation = insertedViolations[0];
      if (!violation) return null;

      return violation;
    });

    if (violationResult) {
      const ruleInfo = {
        id: rule.id,
        name: rule.name,
        type: null,
      };

      createdViolations.push({ violation: violationResult, rule: ruleInfo });

      console.log(
        `[rules] Pause re-eval: rule "${rule.name}" matched session ${existingSession.id}`
      );

      // Execute actions (e.g., kill_stream, send_notification) only when
      // a new violation was created. The dedup check returns null on subsequent
      // polls, so gating here prevents kill_stream from firing every poll cycle.
      if (result.actions.length > 0) {
        const context: EvaluationContext = {
          ...baseContext,
          rule,
          violationId: violationResult.id,
        };
        const actionResults: ActionResult[] = await executeActions(context, result.actions);
        await storeActionResults(violationResult.id, result.ruleId, actionResults);
      }
    }
  }

  return createdViolations;
}
