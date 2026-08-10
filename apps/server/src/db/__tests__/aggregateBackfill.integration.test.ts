/**
 * Aggregate Backfill Integration Tests
 *
 * Covers the startup version-mismatch path added to fix the release blocker
 * where a schema version bump used to run an unbounded synchronous rebuild
 * of all continuous aggregates before the server started listening. That
 * blocked startup long enough to trip the deploy platform's startup probe on
 * large installs, and since the schema version was only stored on success,
 * every crash-triggered restart repeated the same slow rebuild forever.
 *
 * Verifies:
 * - A version mismatch at startup only performs the cheap DDL rebuild
 *   (drop/recreate aggregate definitions + refresh policies) synchronously,
 *   leaves a backfill marker, and returns quickly.
 * - A leftover marker from a previous boot is picked back up on the next
 *   startup even when the stored version already matches.
 * - runAggregateBackfill() clears the marker and stores the schema version
 *   on success.
 * - runAggregateBackfill() retries with backoff and leaves the marker in
 *   place (never silently drops it) when every attempt fails.
 *
 * Run with: pnpm test:integration
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../client.js';
import {
  initTimescaleDB,
  getBackfillMarker,
  runAggregateBackfill,
  AGGREGATE_SCHEMA_VERSION,
} from '../timescale.js';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';

const SCHEMA_VERSION_KEY = 'aggregate_schema_version';
const BACKFILL_MARKER_KEY = 'aggregate_backfill_pending';

async function setStoredVersionRaw(version: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO timescale_metadata (key, value, updated_at)
    VALUES (${SCHEMA_VERSION_KEY}, ${version.toString()}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `);
}

async function getStoredVersionRaw(): Promise<number | null> {
  const result = await db.execute(sql`
    SELECT value FROM timescale_metadata WHERE key = ${SCHEMA_VERSION_KEY}
  `);
  const value = (result.rows[0] as { value: string } | undefined)?.value;
  return value ? parseInt(value, 10) : null;
}

async function setBackfillMarkerRaw(targetVersion: number): Promise<void> {
  const marker = { targetVersion, startedAt: new Date().toISOString() };
  await db.execute(sql`
    INSERT INTO timescale_metadata (key, value, updated_at)
    VALUES (${BACKFILL_MARKER_KEY}, ${JSON.stringify(marker)}, NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `);
}

async function clearBackfillMarkerRaw(): Promise<void> {
  await db.execute(sql`DELETE FROM timescale_metadata WHERE key = ${BACKFILL_MARKER_KEY}`);
}

/** All continuous aggregate view names, across both the sessions and
 * library_snapshots hypertables (getTimescaleStatus only reports the former). */
async function getContinuousAggregateNames(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT view_name FROM timescaledb_information.continuous_aggregates
  `);
  return (result.rows as { view_name: string }[]).map((r) => r.view_name);
}

/** Seed sessions spread across many weekly chunks (chunk_time_interval is 7 days). */
async function seedMultiChunkSessions(
  serverId: string,
  serverUserId: string,
  count: number,
  stepDays: number
): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    await createTestSession({
      serverId,
      serverUserId,
      mediaType: 'movie',
      startedAt: new Date(now - i * stepDays * 24 * 60 * 60 * 1000),
      durationMs: 600_000,
      totalDurationMs: 7_200_000,
    });
  }
}

describe('aggregate backfill (version-mismatch startup path)', () => {
  beforeEach(async () => {
    await clearBackfillMarkerRaw();
    await setStoredVersionRaw(AGGREGATE_SCHEMA_VERSION);
  });

  it('performs a DDL-only rebuild synchronously and defers the historical backfill to the background', async () => {
    const server = await createTestServer();
    const user = await createTestUser();
    const serverUser = await createTestServerUser({ serverId: server.id, userId: user.id });
    // 40 sessions, 10 days apart, span ~400 days -> well over 50 weekly chunks.
    await seedMultiChunkSessions(server.id, serverUser.id, 40, 10);

    // Simulate a deployed schema bump.
    await setStoredVersionRaw(AGGREGATE_SCHEMA_VERSION - 1);

    const start = Date.now();
    const result = await initTimescaleDB();
    const elapsedMs = Date.now() - start;
    console.log(`[aggregateBackfill test] DDL-only rebuild (initTimescaleDB) took ${elapsedMs}ms`);

    expect(result.success).toBe(true);
    expect(result.backfillPending?.targetVersion).toBe(AGGREGATE_SCHEMA_VERSION);
    expect(result.actions.some((a) => a.includes('recreating aggregate definitions'))).toBe(true);

    // Aggregate view definitions exist immediately, even though history hasn't
    // been backfilled yet. getTimescaleStatus() only reports aggregates on
    // the sessions hypertable; library_stats_daily/content_quality_daily
    // live on library_snapshots and are checked separately below.
    expect(result.status.continuousAggregates).toEqual(
      expect.arrayContaining(['daily_content_engagement', 'daily_bandwidth_by_user'])
    );
    expect(await getContinuousAggregateNames()).toEqual(
      expect.arrayContaining([
        'daily_content_engagement',
        'daily_bandwidth_by_user',
        'library_stats_daily',
        'content_quality_daily',
      ])
    );

    const marker = await getBackfillMarker();
    expect(marker?.targetVersion).toBe(AGGREGATE_SCHEMA_VERSION);

    // The schema version is intentionally NOT advanced yet - only the
    // background backfill (runAggregateBackfill) advances it, so a
    // crash-triggered restart before it completes will resume rather than
    // silently believing the upgrade already finished.
    expect(await getStoredVersionRaw()).toBe(AGGREGATE_SCHEMA_VERSION - 1);

    // Evidence for the "startup impact is seconds" claim: this rebuild does
    // DDL plus a bounded recent-window refresh only, never an unbounded scan
    // across the 40+ chunks seeded above.
    expect(elapsedMs).toBeLessThan(15_000);
  });

  it('resumes a leftover backfill marker on the next boot without needing a version mismatch', async () => {
    // Simulates a previous boot that completed the DDL rebuild + background
    // backfill's version bump race losing to a crash: marker still present.
    await setStoredVersionRaw(AGGREGATE_SCHEMA_VERSION);
    await setBackfillMarkerRaw(AGGREGATE_SCHEMA_VERSION);

    const result = await initTimescaleDB();

    expect(result.backfillPending?.targetVersion).toBe(AGGREGATE_SCHEMA_VERSION);
    expect(result.actions.some((a) => a.includes('Found pending aggregate backfill'))).toBe(true);
  });

  it('does not report a pending backfill when up to date with no leftover marker', async () => {
    const result = await initTimescaleDB();

    expect(result.backfillPending).toBeUndefined();
    expect(await getBackfillMarker()).toBeNull();
  });

  it('resumes instead of re-dropping definitions when a version-mismatch retry finds a marker already targeting the current version', async () => {
    // Simulates a boot that already ran the DDL rebuild for the current
    // target version and left a marker before the background backfill
    // failed. The stored version is still the old one, so this boot sees
    // the same version mismatch again.
    await setStoredVersionRaw(AGGREGATE_SCHEMA_VERSION - 1);
    await setBackfillMarkerRaw(AGGREGATE_SCHEMA_VERSION);

    const result = await initTimescaleDB();

    expect(result.success).toBe(true);
    expect(result.backfillPending?.targetVersion).toBe(AGGREGATE_SCHEMA_VERSION);
    expect(
      result.actions.some((a) => a.includes('resuming pending backfill instead of recreating'))
    ).toBe(true);
    expect(result.actions.some((a) => a.includes('recreating aggregate definitions'))).toBe(false);
  });

  it('still drops and recreates when the leftover marker targets an older version than the current mismatch', async () => {
    const server = await createTestServer();
    const user = await createTestUser();
    const serverUser = await createTestServerUser({ serverId: server.id, userId: user.id });
    await seedMultiChunkSessions(server.id, serverUser.id, 10, 10);

    await setStoredVersionRaw(AGGREGATE_SCHEMA_VERSION - 1);
    await setBackfillMarkerRaw(AGGREGATE_SCHEMA_VERSION - 1);

    const result = await initTimescaleDB();

    expect(result.success).toBe(true);
    expect(result.backfillPending?.targetVersion).toBe(AGGREGATE_SCHEMA_VERSION);
    expect(result.actions.some((a) => a.includes('recreating aggregate definitions'))).toBe(true);
  });
});

describe('runAggregateBackfill', () => {
  beforeEach(async () => {
    await setBackfillMarkerRaw(AGGREGATE_SCHEMA_VERSION);
    await setStoredVersionRaw(AGGREGATE_SCHEMA_VERSION - 1);
  });

  it('clears the marker and stores the new schema version on success', async () => {
    const result = await runAggregateBackfill(AGGREGATE_SCHEMA_VERSION, {
      // No sessions seeded in this test - keep the refresh itself out of
      // scope and focus on the marker/version state machine.
      refreshFn: () => Promise.resolve(),
    });

    expect(result).toEqual({ success: true, attempts: 1 });
    expect(await getBackfillMarker()).toBeNull();
    expect(await getStoredVersionRaw()).toBe(AGGREGATE_SCHEMA_VERSION);
  });

  it('retries with backoff and leaves the marker in place when every attempt fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sleepCalls: number[] = [];

    const result = await runAggregateBackfill(AGGREGATE_SCHEMA_VERSION, {
      maxAttempts: 3,
      initialDelayMs: 1000,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      refreshFn: async () => {
        throw new Error('simulated refresh failure');
      },
    });

    expect(result).toEqual({ success: false, attempts: 3 });
    // Backoff doubles between attempts; no sleep after the final attempt.
    expect(sleepCalls).toEqual([1000, 2000]);
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(errorSpy.mock.calls[2]?.join(' ')).toMatch(/Giving up for this boot/);

    // Never silently dropped: the marker stays so the next server startup
    // resumes the backfill (see initTimescaleDB's leftover-marker branch).
    const marker = await getBackfillMarker();
    expect(marker?.targetVersion).toBe(AGGREGATE_SCHEMA_VERSION);
    // Version must not advance since the backfill never actually succeeded.
    expect(await getStoredVersionRaw()).toBe(AGGREGATE_SCHEMA_VERSION - 1);
  });

  it('stops retrying and clears the marker as soon as an attempt succeeds', async () => {
    let attempts = 0;
    const sleepCalls: number[] = [];

    const result = await runAggregateBackfill(AGGREGATE_SCHEMA_VERSION, {
      maxAttempts: 3,
      initialDelayMs: 1000,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      refreshFn: async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error('transient failure');
        }
      },
    });

    expect(result).toEqual({ success: true, attempts: 2 });
    expect(sleepCalls).toEqual([1000]);
    expect(await getBackfillMarker()).toBeNull();
    expect(await getStoredVersionRaw()).toBe(AGGREGATE_SCHEMA_VERSION);
  });

  it('lets a concurrent second call skip while the first holds the advisory lock, without touching the marker', async () => {
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const holdPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstPromise = runAggregateBackfill(AGGREGATE_SCHEMA_VERSION, {
      refreshFn: async () => {
        firstStarted();
        await holdPromise;
      },
    });

    // Wait until the first call has acquired the lock and entered refreshFn
    // before racing the second call against it.
    await firstStartedPromise;

    const secondResult = await runAggregateBackfill(AGGREGATE_SCHEMA_VERSION, {
      refreshFn: () => Promise.resolve(),
    });

    expect(secondResult).toEqual({ success: true, attempts: 0, skipped: true });
    // The loser must not touch the marker - the winner clears it on success.
    const markerWhileFirstHolds = await getBackfillMarker();
    expect(markerWhileFirstHolds?.targetVersion).toBe(AGGREGATE_SCHEMA_VERSION);

    releaseFirst();
    const firstResult = await firstPromise;

    expect(firstResult).toEqual({ success: true, attempts: 1 });
    expect(await getBackfillMarker()).toBeNull();
    expect(await getStoredVersionRaw()).toBe(AGGREGATE_SCHEMA_VERSION);
  });
});
