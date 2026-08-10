/**
 * Maintenance job recovery redesign ("Option C").
 *
 * Three prior attempts at a custom boot-time recovery pass for jobs orphaned
 * by a crash each fixed one bug and introduced a subtler one: multi-instance
 * double-processing, a TOCTOU race between reading a lock and acting on it,
 * and an async recovery call blocking `app.listen()` behind BullMQ's
 * infinite-retry connection. That custom recovery is gone. Recovery is now
 * BullMQ's own stalled-job detection, tuned to be timely (lockDuration down
 * from 1h to 5m). These tests prove that's actually safe:
 *
 * - a crashed job's lock genuinely expires and gets reclaimed within a
 *   bounded window, not before
 * - a live job that renews its lock is never falsely swept as stalled
 * - a job that loses its lock (stolen, or a false-positive stall) aborts at
 *   the next lock check instead of racing its replacement to completion
 * - the one non-idempotent writer (backfill_library_snapshots) can't create
 *   duplicate rows even when two runs genuinely overlap, because the
 *   uniqueness is enforced at the database, not just checked in application code
 * - nothing between buildApp() and app.listen() can hang on a BullMQ
 *   connection retry anymore
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- maintenanceQueueRecovery
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Queue, Worker, type Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { getRedisPrefix } from '@tracearr/shared';
import { createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { libraryItems } from '../../src/db/schema.js';
import { extendJobLock } from '../../src/jobs/lockUtils.js';
import {
  initMaintenanceQueue,
  startMaintenanceWorker,
  enqueueMaintenanceJob,
  getMaintenanceJobStatus,
  clearStuckMaintenanceJobs,
  obliterateMaintenanceQueue,
  shutdownMaintenanceQueue,
  processBackfillLibrarySnapshotsJob,
  processRebuildTimescaleViewsJob,
  type MaintenanceJobData,
} from '../../src/jobs/maintenanceQueue.js';

// Only rebuildTimescaleViews is stubbed here - everything else the module
// exports stays real, since other describes in this file exercise real
// handlers that don't touch TimescaleDB views at all.
vi.mock('../../src/db/timescale.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/db/timescale.js')>();
  return {
    ...actual,
    rebuildTimescaleViews: vi.fn(),
  };
});

import { rebuildTimescaleViews } from '../../src/db/timescale.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const BULL_PREFIX = `${getRedisPrefix()}bull`;
// Must match the private QUEUE_NAME in maintenanceQueue.ts - there's no
// exported constant, so this pins the coupling explicitly instead of quietly.
const QUEUE_NAME = 'maintenance';

/**
 * Grabs whatever job is currently at the front of the maintenance queue with
 * a real BullMQ worker (moving it to "active" and taking its lock), then
 * force-closes that worker before it finishes - a real crashed process, not
 * a hand-rolled Redis write.
 */
async function crashViaWorker(): Promise<void> {
  let markActive: () => void;
  const becameActive = new Promise<void>((resolve) => {
    markActive = resolve;
  });

  const crashedWorker = new Worker(
    QUEUE_NAME,
    () => new Promise(() => {}), // never resolves - the job stays "active" until we kill the worker
    { connection: { url: REDIS_URL }, prefix: BULL_PREFIX }
  );
  crashedWorker.on('active', () => markActive());

  await becameActive;
  await crashedWorker.close(true);
}

async function crashActiveJob(): Promise<string> {
  const jobId = await enqueueMaintenanceJob('normalize_players', randomUUID());
  await crashViaWorker();
  return jobId;
}

describe('maintenance queue: clearStuckMaintenanceJobs on an active job', () => {
  afterEach(async () => {
    await obliterateMaintenanceQueue();
    await shutdownMaintenanceQueue();
  });

  it('moves the active job to failed instead of throwing on a lock-token mismatch', async () => {
    initMaintenanceQueue(REDIS_URL);
    const jobId = await crashActiveJob();

    await expect(clearStuckMaintenanceJobs()).resolves.toEqual({ cleared: 1 });

    const status = await getMaintenanceJobStatus(jobId);
    expect(status?.state).toBe('failed');
  });
});

/**
 * Uses a throwaway queue (not the shared "maintenance" queue) with short
 * lockDuration/stalledInterval so the test doesn't have to wait on
 * production-scale timings, while exercising the exact same BullMQ
 * mechanism the tuned production Worker options rely on.
 */
describe('BullMQ native stalled detection: recovery latency', () => {
  it('reclaims a crashed job within lockDuration + 2*stalledInterval, not before', async () => {
    const queueName = `maintenance-recovery-latency-${randomUUID()}`;
    const LOCK_DURATION_MS = 3000;
    const STALLED_INTERVAL_MS = 500;
    const connection = { url: REDIS_URL };

    const queue = new Queue(queueName, { connection, prefix: BULL_PREFIX });

    let markActiveA: () => void;
    const becameActiveA = new Promise<void>((resolve) => {
      markActiveA = resolve;
    });
    const workerA = new Worker(
      queueName,
      () => new Promise(() => {}), // never resolves - stays "active" until reclaimed
      {
        connection,
        prefix: BULL_PREFIX,
        lockDuration: LOCK_DURATION_MS,
        stalledInterval: STALLED_INTERVAL_MS,
        maxStalledCount: 2,
      }
    );
    workerA.on('active', () => markActiveA());

    let markActiveB: (() => void) | null = null;
    const becameActiveB = new Promise<void>((resolve) => {
      markActiveB = resolve;
    });
    // autorun: false so B can't race A for the initial pickup - B's instant
    // processor would otherwise complete the job before A ever goes active,
    // leaving becameActiveA pending forever. B may only ever reclaim.
    const workerB = new Worker(queueName, async () => 'done-by-b', {
      connection,
      prefix: BULL_PREFIX,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: 2,
      autorun: false,
    });
    workerB.on('active', ({ id }) => {
      if (id === job.id) markActiveB?.();
    });

    const job = await queue.add('never-resolves', {});
    await becameActiveA;
    void workerB.run();

    // Simulate a crash: destroy worker A's Redis connection directly,
    // without ever calling worker.close(). The lock key it holds is left
    // behind in Redis with time still on its TTL - exactly what a killed
    // process leaves.
    const clientA = await workerA.client;
    const crashTime = Date.now();
    clientA.disconnect();

    // Not reclaimed while the lock TTL is still live.
    await new Promise((resolve) => setTimeout(resolve, LOCK_DURATION_MS / 2));
    expect(await job.getState()).toBe('active');

    // Reclaimed once the lock actually expires and the next stalled sweep runs.
    await Promise.race([
      becameActiveB,
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('timed out waiting for worker B to reclaim the job')),
          LOCK_DURATION_MS + 3 * STALLED_INTERVAL_MS + 3000
        )
      ),
    ]);
    const reclaimedMs = Date.now() - crashTime;

    expect(reclaimedMs).toBeGreaterThanOrEqual(LOCK_DURATION_MS - STALLED_INTERVAL_MS);
    expect(reclaimedMs).toBeLessThanOrEqual(LOCK_DURATION_MS + 2 * STALLED_INTERVAL_MS + 2500);

    await workerA.close(true).catch(() => {});
    await workerB.close();
    await queue.obliterate({ force: true });
    await queue.close();
  }, 20000);
});

describe('BullMQ native stalled detection: no false stalls on a renewing job', () => {
  it('survives several stalledIntervals without a stalled event when it keeps renewing its lock', async () => {
    const queueName = `maintenance-no-false-stall-${randomUUID()}`;
    const LOCK_DURATION_MS = 800;
    const STALLED_INTERVAL_MS = 250;
    const BATCHES = 10; // total processing time spans ~3x lockDuration and 10 sweeps
    const connection = { url: REDIS_URL };

    const queue = new Queue(queueName, { connection, prefix: BULL_PREFIX });

    let stalledFired = false;
    const worker = new Worker(
      queueName,
      async (job) => {
        for (let i = 0; i < BATCHES; i++) {
          await new Promise((resolve) => setTimeout(resolve, STALLED_INTERVAL_MS));
          await extendJobLock(job, LOCK_DURATION_MS);
        }
        return 'ok';
      },
      {
        connection,
        prefix: BULL_PREFIX,
        lockDuration: LOCK_DURATION_MS,
        stalledInterval: STALLED_INTERVAL_MS,
        maxStalledCount: 2,
      }
    );
    worker.on('stalled', () => {
      stalledFired = true;
    });

    const job = await queue.add('batchy', {});
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('timed out waiting for the renewing job to complete')),
        BATCHES * STALLED_INTERVAL_MS + LOCK_DURATION_MS + 5000
      );
      worker.on('completed', (completed) => {
        if (completed.id === job.id) {
          clearTimeout(timeout);
          resolve();
        }
      });
      worker.on('failed', (failed, err) => {
        if (failed?.id === job.id) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });

    expect(stalledFired).toBe(false);
    expect(await job.getState()).toBe('completed');

    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  }, 20000);
});

describe('extendJobLock: fail-closed abort on lost lock', () => {
  it('aborts once its lock is reclaimed by a replacement worker, which completes the job exactly once', async () => {
    const queueName = `maintenance-lost-lock-${randomUUID()}`;
    const LOCK_DURATION_MS = 1200;
    const STALLED_INTERVAL_MS = 300;
    const connection = { url: REDIS_URL };

    const queue = new Queue(queueName, { connection, prefix: BULL_PREFIX });

    let completions = 0;
    const completedBy: string[] = [];
    let extendError: Error | null = null;
    let workerAWronglyFinished = false;

    let markActiveA: () => void;
    const becameActiveA = new Promise<void>((resolve) => {
      markActiveA = resolve;
    });

    const workerA = new Worker(
      queueName,
      async (job) => {
        markActiveA();
        // Simulate a job that stops making progress (hung batch, false
        // stall) rather than a clean crash: block well past lockDuration +
        // the stalled sweep window without renewing, so BullMQ's stalled
        // detection legitimately reclaims the job and a replacement worker
        // takes over with a fresh token - genuine lock theft, not a
        // hand-deleted key.
        await new Promise((resolve) =>
          setTimeout(resolve, LOCK_DURATION_MS + 2 * STALLED_INTERVAL_MS + 500)
        );
        // By now the lock key holds worker B's token, not this run's -
        // extendLock resolves to 0 (BullMQ does not throw on its own), and
        // the fail-closed check in extendJobLock must abort here.
        try {
          await extendJobLock(job, LOCK_DURATION_MS);
          workerAWronglyFinished = true; // unreachable if the abort works
        } catch (err) {
          extendError = err as Error;
          throw err;
        }
      },
      {
        connection,
        prefix: BULL_PREFIX,
        lockDuration: LOCK_DURATION_MS,
        stalledInterval: STALLED_INTERVAL_MS,
        maxStalledCount: 2,
        // BullMQ auto-renews locks for whatever a worker is actively
        // processing, independently of anything the processor itself does -
        // sleeping in the processor alone would never let the lock expire.
        // Disabling that is what actually lets the lock lapse and get
        // reclaimed, so extendJobLock's return-value check (not a connection
        // error) is what's under test. `0` does NOT disable it - bullmq's
        // own option normalization is `lockRenewTime || lockDuration / 2`,
        // and 0 is falsy, so it silently falls back to the default. A
        // negative value survives that fallback and fails the worker's own
        // `> 0` gate that starts the renewal timer.
        lockRenewTime: -1,
      }
    );
    // Worker A's own doomed cleanup attempt (moveToFailed with a token that
    // no longer owns the lock) surfaces as a benign internal error once the
    // job it was about to fail has already been completed by worker B -
    // swallow it rather than letting an unhandled 'error' event crash the test.
    workerA.on('error', () => {});
    workerA.on('completed', () => {
      completions++;
      completedBy.push('from-a');
    });

    // autorun: false so B can't win the initial pickup - the premise here is
    // that B RECLAIMS a stalled job from A, so it must not start until A
    // holds the lock (and B winning would also hang becameActiveA forever).
    const workerB = new Worker(queueName, async () => 'from-b', {
      connection,
      prefix: BULL_PREFIX,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: 2,
      autorun: false,
    });
    workerB.on('completed', (job) => {
      completions++;
      completedBy.push(job.returnvalue as string);
    });

    const job = await queue.add('lock-loss', {});
    await becameActiveA;
    void workerB.run();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('timed out waiting for worker B to reclaim and complete the job')),
        LOCK_DURATION_MS + 3 * STALLED_INTERVAL_MS + 3000
      );
      workerB.on('completed', (completed) => {
        if (completed.id === job.id) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    // Give worker A's own delayed extendJobLock call - which fires after
    // worker B has already completed the job - time to run and throw. Poll
    // rather than a single flat sleep since worker A's wake-up is only
    // loosely bounded relative to worker B's completion.
    const extendCheckDeadline = Date.now() + 3000;
    while (extendError === null && !workerAWronglyFinished && Date.now() < extendCheckDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(workerAWronglyFinished).toBe(false);
    expect(extendError).toBeInstanceOf(Error);
    expect(completions).toBe(1);
    expect(completedBy).toEqual(['from-b']);

    await workerA.close(true).catch(() => {});
    await workerB.close();
    await queue.obliterate({ force: true });
    await queue.close();
  }, 20000);
});

/**
 * backfill_library_snapshots is the one maintenance handler that isn't
 * naturally idempotent through application logic alone (the old WHERE NOT
 * EXISTS check races a concurrent run between its own check and insert). The
 * unique index on (server_id, library_id, snapshot_time) plus ON CONFLICT DO
 * NOTHING make it safe at the database instead - the only place that's
 * actually reliable under real concurrency.
 *
 * Calls processBackfillLibrarySnapshotsJob directly (not through the queue)
 * so the two runs are genuinely concurrent rather than serialized by the
 * worker's concurrency: 1 setting.
 */
describe('backfill_library_snapshots: duplicate writes blocked under concurrency', () => {
  function stubJob(id: string): Job<MaintenanceJobData> {
    return {
      id,
      token: `token-${id}`,
      data: { type: 'backfill_library_snapshots', userId: 'test-owner' },
      updateProgress: async () => undefined,
      extendLock: async () => undefined,
    } as unknown as Job<MaintenanceJobData>;
  }

  it('produces zero duplicate snapshot rows when run twice concurrently', async () => {
    const server = await createTestServer({ type: 'plex' });
    const libraryId = 'lib-dup-test';
    const days = 12;
    const now = Date.now();

    await db.insert(libraryItems).values(
      Array.from({ length: days }, (_, i) => ({
        serverId: server.id,
        libraryId,
        ratingKey: `dup-item-${i}`,
        title: `Dup Item ${i}`,
        mediaType: 'movie',
        fileSize: 1_000_000 + i,
        // Last item lands "today" (offset 0) so the backfill's date range -
        // which always runs through CURRENT_DATE, not just the newest item's
        // day - covers exactly `days` calendar days, matching the assertion below.
        createdAt: new Date(now - (days - 1 - i) * 86_400_000),
      }))
    );

    const [resultA, resultB] = await Promise.all([
      processBackfillLibrarySnapshotsJob(stubJob('dup-a')),
      processBackfillLibrarySnapshotsJob(stubJob('dup-b')),
    ]);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);

    const dupes = await db.execute(sql`
      SELECT server_id, library_id, snapshot_time, COUNT(*)::int AS c
      FROM library_snapshots
      WHERE server_id = ${server.id}::uuid AND library_id = ${libraryId}
      GROUP BY server_id, library_id, snapshot_time
      HAVING COUNT(*) > 1
    `);
    expect(dupes.rows).toHaveLength(0);

    const total = await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM library_snapshots
      WHERE server_id = ${server.id}::uuid AND library_id = ${libraryId}
    `);
    // Exactly one snapshot per day with valid items - not double-counted by
    // the second run, not undercounted either.
    expect((total.rows[0] as { c: number }).c).toBe(days);
  }, 30000);
});

/**
 * With the custom recovery pass removed, nothing between buildApp() and
 * app.listen() in index.ts awaits a BullMQ connection or a Redis round trip
 * for maintenance-job recovery anymore. startMaintenanceWorker() only builds
 * a Queue/Worker (both lazy, non-blocking BullMQ constructors) and registers
 * listeners - there is no `await` inside it. This is what makes that true at
 * both the type level (the function is sync, so it's structurally
 * impossible for it to block an awaiting caller on a slow/absent Redis) and
 * the source level (grepped directly, since index.ts self-starts a real
 * server on import and can't be safely imported in a test process).
 */
describe('boot resilience: maintenance startup cannot block app.listen()', () => {
  afterEach(async () => {
    await shutdownMaintenanceQueue();
  });

  it('startMaintenanceWorker returns synchronously, not a Promise', () => {
    initMaintenanceQueue(REDIS_URL);
    const result = startMaintenanceWorker();
    expect(result).toBeUndefined();
  });

  it('index.ts calls startMaintenanceWorker without awaiting it', () => {
    const indexPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
    const source = readFileSync(indexPath, 'utf-8');
    expect(source).toContain('startMaintenanceWorker();');
    expect(source).not.toContain('await startMaintenanceWorker()');
  });
});

/**
 * processRebuildTimescaleViewsJob is the one maintenance handler that talks
 * to BullMQ's lock through a synchronous progressCallback instead of an
 * awaited batch loop, and that wraps its own work in a result object rather
 * than throwing. Both shapes can turn a real failure into a "completed" job:
 * a lock-loss rejection fired from inside a sync callback has nowhere to be
 * awaited, and `{ success: false }` returned instead of thrown never reaches
 * BullMQ's failure path. rebuildTimescaleViews itself is stubbed so these
 * tests control exactly when the callback fires and what it reports,
 * without needing a real TimescaleDB rebuild to fail on demand.
 */
describe('processRebuildTimescaleViewsJob: fail-closed on lock loss or rebuild failure', () => {
  function stubRebuildJob(extendLockResult: number): Job<MaintenanceJobData> {
    return {
      id: `rebuild-${randomUUID()}`,
      token: `token-${randomUUID()}`,
      data: { type: 'rebuild_timescale_views', userId: 'test-owner', options: {} },
      updateProgress: async () => undefined,
      extendLock: async () => extendLockResult,
    } as unknown as Job<MaintenanceJobData>;
  }

  // Lets the extendJobLock().catch() chain kicked off inside the sync
  // progressCallback actually settle before the mock hands control back to
  // processRebuildTimescaleViewsJob - there's no real I/O or timer in that
  // chain, only a handful of promise hops, so draining microtasks is enough.
  async function flushMicrotasks(times = 10): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws instead of completing when the BullMQ lock is lost mid-rebuild', async () => {
    vi.useFakeTimers();
    const job = stubRebuildJob(0); // extendLock resolving to 0 means the lock was lost

    vi.mocked(rebuildTimescaleViews).mockImplementation(async (options) => {
      const opts = typeof options === 'function' ? { progressCallback: options } : (options ?? {});
      opts.progressCallback?.(1, 9, 'step 1');
      // Jump past the handler's 60s lock-extension interval without a real wait.
      vi.setSystemTime(Date.now() + 61_000);
      opts.progressCallback?.(2, 9, 'step 2');
      await flushMicrotasks();
      return { success: true, message: 'Rebuilt views OK' };
    });

    await expect(processRebuildTimescaleViewsJob(job)).rejects.toThrow(/Lost lock/);
  });

  it('throws instead of completing when rebuildTimescaleViews reports failure', async () => {
    const job = stubRebuildJob(1); // lock extension never triggers, stays healthy either way
    vi.mocked(rebuildTimescaleViews).mockResolvedValue({
      success: false,
      message: 'aggregate refresh failed: continuous aggregate is broken',
    });

    await expect(processRebuildTimescaleViewsJob(job)).rejects.toThrow(
      'aggregate refresh failed: continuous aggregate is broken'
    );
  });
});
