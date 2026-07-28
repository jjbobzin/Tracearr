/**
 * Poller Database Operations
 *
 * Database query functions used by the poller.
 * Includes batch loading for performance optimization and rule fetching.
 */

import { eq, and, desc, gte, inArray, isNotNull } from 'drizzle-orm';
import {
  TIME_MS,
  SESSION_LIMITS,
  type Session,
  type RuleV2,
  type RuleConditions,
  type RuleActions,
  type ViolationSeverity,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { sessions, rules, serverUsers, terminationLogs } from '../../db/schema.js';
import { mapSessionRow } from './sessionMapper.js';

// ============================================================================
// Session Batch Loading
// ============================================================================

/**
 * Batch load recent sessions for multiple server users (eliminates N+1 in polling loop)
 *
 * This function fetches sessions from the last N hours for a batch of server users
 * in a single query, avoiding the performance penalty of querying per-user.
 *
 * @param serverUserIds - Array of server user IDs to load sessions for
 * @param hours - Number of hours to look back (default: 24)
 * @returns Map of serverUserId -> Session[] for each server user
 *
 * @example
 * const sessionMap = await batchGetRecentUserSessions(['su-1', 'su-2', 'su-3']);
 * const user1Sessions = sessionMap.get('su-1') ?? [];
 */
export async function batchGetRecentUserSessions(
  serverUserIds: string[],
  hours = 24
): Promise<Map<string, Session[]>> {
  if (serverUserIds.length === 0) return new Map();

  const since = new Date(Date.now() - hours * TIME_MS.HOUR);
  const result = new Map<string, Session[]>();

  // Initialize empty arrays for all server users
  for (const serverUserId of serverUserIds) {
    result.set(serverUserId, []);
  }

  // Single query to get recent sessions for all server users using inArray
  const recentSessions = await db
    .select()
    .from(sessions)
    .where(and(inArray(sessions.serverUserId, serverUserIds), gte(sessions.startedAt, since)))
    .orderBy(desc(sessions.startedAt));

  // Group by server user (limit per user to prevent memory issues)
  for (const s of recentSessions) {
    const userSessions = result.get(s.serverUserId) ?? [];
    if (userSessions.length < SESSION_LIMITS.MAX_RECENT_PER_USER) {
      userSessions.push(mapSessionRow(s));
    }
    result.set(s.serverUserId, userSessions);
  }

  return result;
}

/**
 * Merge recent-session lists for a set of server_user ids belonging to one
 * identity into a single deduplicated list (by session id), so windowed rule
 * evaluators (unique_ips_in_window, unique_devices_in_window, travel_speed_kmh)
 * see the identity's cross-server activity exactly once, never twice because
 * a session surfaced under more than one of the given ids.
 *
 * @param recentSessionsMap - Map of serverUserId -> Session[] (as returned by batchGetRecentUserSessions)
 * @param identityServerUserIds - server_user ids belonging to one identity
 * @returns Combined, deduplicated Session[] across all the given ids
 */
export function mergeRecentSessionsForIdentity(
  recentSessionsMap: Map<string, Session[]>,
  identityServerUserIds: string[]
): Session[] {
  const seen = new Set<string>();
  const combined: Session[] = [];
  for (const id of identityServerUserIds) {
    for (const s of recentSessionsMap.get(id) ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      combined.push(s);
    }
  }
  return combined;
}

/**
 * Widen recentSessionsMap in place so every server_user id belonging to a
 * merged identity (an identityServerUserIdsMap entry with more than one id)
 * maps to the combined, deduplicated recent-session list of ALL of that
 * identity's server_user ids. Ids not present in identityServerUserIdsMap,
 * and ids whose identity has only one server_user, are left untouched - this
 * is what keeps sibling data from leaking into an unrelated server_user on
 * the same server.
 *
 * Only issues one supplemental query per poll tick (for whichever sibling ids
 * aren't already in recentSessionsMap), regardless of how many identities are
 * merged, so the poller hot path stays batched.
 *
 * @param recentSessionsMap - Map of serverUserId -> Session[], mutated in place
 * @param identityServerUserIdsMap - Map of identity userId -> that identity's server_user ids
 */
export async function widenRecentSessionsForMergedIdentities(
  recentSessionsMap: Map<string, Session[]>,
  identityServerUserIdsMap: Map<string, string[]>
): Promise<void> {
  const siblingIdsNeeded = new Set<string>();
  for (const ids of identityServerUserIdsMap.values()) {
    if (ids.length <= 1) continue;
    for (const id of ids) {
      if (!recentSessionsMap.has(id)) siblingIdsNeeded.add(id);
    }
  }

  if (siblingIdsNeeded.size > 0) {
    const supplemental = await batchGetRecentUserSessions([...siblingIdsNeeded]);
    for (const [id, sessionsForId] of supplemental) {
      recentSessionsMap.set(id, sessionsForId);
    }
  }

  for (const ids of identityServerUserIdsMap.values()) {
    if (ids.length <= 1) continue;
    const combined = mergeRecentSessionsForIdentity(recentSessionsMap, ids);
    for (const id of ids) {
      recentSessionsMap.set(id, combined);
    }
  }
}

/**
 * Batch load the sibling server_user ids for a set of identities in a single
 * query (eliminates a per-session/per-poll-tick lookup for cross-server rule
 * aggregation on merged identities).
 *
 * @param userIds - Array of identity (users.id) values to resolve
 * @returns Map of userId -> server_user ids belonging to that identity
 *
 * @example
 * const identityMap = await batchGetIdentityServerUserIds(['u-1', 'u-2']);
 * const idsForUser1 = identityMap.get('u-1') ?? [];
 */
export async function batchGetIdentityServerUserIds(
  userIds: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (userIds.length === 0) return result;

  const uniqueUserIds = [...new Set(userIds)];
  for (const userId of uniqueUserIds) {
    result.set(userId, []);
  }

  const rows = await db
    .select({ id: serverUsers.id, userId: serverUsers.userId })
    .from(serverUsers)
    .where(inArray(serverUsers.userId, uniqueUserIds));

  for (const row of rows) {
    const ids = result.get(row.userId) ?? [];
    ids.push(row.id);
    result.set(row.userId, ids);
  }

  return result;
}

/**
 * Resolve the local server_user id for an external account id on a server.
 * Returns null when no matching server user exists.
 *
 * Used to verify that an active session row belongs to the user of an incoming
 * event before reusing it: Plex resets sessionKey counters on PMS restart, so a
 * stale open row can carry the same sessionKey a different user's new play now
 * uses.
 */
export async function getServerUserIdByExternalId(
  serverId: string,
  externalId: string
): Promise<string | null> {
  const rows = await db
    .select({ id: serverUsers.id })
    .from(serverUsers)
    .where(and(eq(serverUsers.serverId, serverId), eq(serverUsers.externalId, externalId)))
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * Sessions already terminated (successfully) under a given violation.
 *
 * A multi-target kill_stream match fans out one job per target, all sharing the
 * violation id. As each sibling job terminates its target, that session leaves
 * the active-session cache. Re-verification of the still-pending siblings needs
 * those already-killed sessions back in the count context: a session stopped BY
 * THIS violation is action reach, not the condition clearing, so it must keep
 * counting for its siblings instead of dropping the concurrent total below the
 * threshold. Returns the mapped session rows so callers can fold them back into
 * the evaluation context. Empty when the violation is null or nothing under it
 * has been terminated yet.
 */
export async function getSessionsTerminatedByViolation(violationId: string): Promise<Session[]> {
  const logRows = await db
    .select({ sessionId: terminationLogs.sessionId })
    .from(terminationLogs)
    .where(and(eq(terminationLogs.violationId, violationId), eq(terminationLogs.success, true)));

  const ids = [...new Set(logRows.map((r) => r.sessionId))];
  if (ids.length === 0) return [];

  const sessionRows = await db.select().from(sessions).where(inArray(sessions.id, ids));
  return sessionRows.map(mapSessionRow);
}

// ============================================================================
// Rule Loading
// ============================================================================

// TTL fallback for multi-instance deployments: another instance's invalidation isn't visible here, so a rule change can take up to this long to apply.
const RULES_CACHE_TTL_MS = 10_000;

let rulesCache: { data: RuleV2[]; expiresAt: number } | null = null;

/** Invalidate the active V2 rules cache. Call from every rule create/update/delete/toggle path. */
export function invalidateRulesCache(): void {
  rulesCache = null;
}

/**
 * Get all active V2 rules (rules with conditions/actions defined).
 *
 * V2 rules use the new conditions/actions format instead of the legacy type/params.
 * These rules are evaluated by the session lifecycle event system.
 *
 * @returns Array of active RuleV2 objects
 *
 * @example
 * const rulesV2 = await getActiveRulesV2();
 * // Evaluate session events against these rules
 */
/**
 * Map a raw `rules` table row (V2 columns) to the shared RuleV2 shape.
 * Shared by getActiveRulesV2 and the kill-queue reverify path so both build
 * an identical RuleV2 from the same row.
 */
export function mapRuleRowToRuleV2(r: typeof rules.$inferSelect): RuleV2 {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    serverId: r.serverId,
    serverUserId: r.serverUserId,
    userId: r.userId,
    enforceAcrossServers: r.enforceAcrossServers,
    isActive: r.isActive,
    severity: (r.severity ?? 'warning') as ViolationSeverity,
    conditions: r.conditions as RuleConditions,
    actions: r.actions as RuleActions,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function getActiveRulesV2(): Promise<RuleV2[]> {
  const now = Date.now();
  if (rulesCache && rulesCache.expiresAt > now) {
    return rulesCache.data;
  }

  const activeRules = await db
    .select()
    .from(rules)
    .where(and(eq(rules.isActive, true), isNotNull(rules.conditions)));

  const mapped = activeRules.map(mapRuleRowToRuleV2);

  rulesCache = { data: mapped, expiresAt: now + RULES_CACHE_TTL_MS };
  return mapped;
}
