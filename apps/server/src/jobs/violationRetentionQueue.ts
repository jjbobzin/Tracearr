/**
 * Violation Retention Queue - BullMQ-based daily purge of soft-deleted rows
 *
 * Dismiss keeps the violation row (dismissedAt) so session and inactivity
 * dedup can keep blocking re-creation, which means nothing else ever removes
 * rows from the table. This job is the eviction path: dismissed SESSION
 * violations older than the retention window are hard-deleted
 * (rule_action_results cascade; termination_logs keep their row but lose the
 * violation link, SET NULL). Acknowledged violations are history the user
 * chose to keep and are never touched.
 *
 * Session-less rows (inactivity violations) are excluded: their dedup blocks
 * on ANY row for user+rule, and a dismissed account is usually still dormant,
 * so purging the row would re-create the violation and re-run its actions
 * every retention period. A dismissed inactivity violation is a permanent
 * admin decision and the row is its record.
 *
 * Deleting an old dismissed session row re-arms its session+rule dedup, which
 * is harmless: the session ended months earlier and can never re-evaluate.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { getRedisPrefix, TIME_MS } from '@tracearr/shared';
import { sql } from 'drizzle-orm';
import { isMaintenance } from '../serverState.js';
import { db } from '../db/client.js';

const QUEUE_NAME = 'violation-retention';

const PURGE_INTERVAL_MS = TIME_MS.DAY;
const DISMISSED_RETENTION_DAYS = 90;
// Delete in batches so the first run after upgrade cannot hold a long lock
const DELETE_BATCH_SIZE = 5000;

interface ViolationRetentionJobData {
  type: 'purge';
}

let connectionOptions: ConnectionOptions | null = null;
let retentionQueue: Queue<ViolationRetentionJobData> | null = null;
let retentionWorker: Worker<ViolationRetentionJobData> | null = null;

/**
 * Initialize the violation retention queue with Redis connection
 */
export function initViolationRetentionQueue(redisUrl: string): void {
  if (retentionQueue) {
    console.log('[ViolationRetention] Queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  const bullPrefix = `${getRedisPrefix()}bull`;

  retentionQueue = new Queue<ViolationRetentionJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000,
      },
      removeOnComplete: {
        count: 20,
        age: 7 * 24 * 60 * 60,
      },
      removeOnFail: {
        count: 50,
        age: 30 * 24 * 60 * 60,
      },
    },
  });
  retentionQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[ViolationRetention] Queue error:', err);
  });

  console.log('[ViolationRetention] Queue initialized');
}

/**
 * Start the violation retention worker
 */
export function startViolationRetentionWorker(): void {
  if (!connectionOptions) {
    throw new Error(
      'Violation retention queue not initialized. Call initViolationRetentionQueue first.'
    );
  }

  if (retentionWorker) {
    console.log('[ViolationRetention] Worker already running');
    return;
  }

  const bullPrefix = `${getRedisPrefix()}bull`;

  retentionWorker = new Worker<ViolationRetentionJobData>(
    QUEUE_NAME,
    async (job: Job<ViolationRetentionJobData>) => {
      const startTime = Date.now();
      try {
        const result = await processViolationRetention();
        console.log(
          `[ViolationRetention] Job ${job.id} completed in ${Date.now() - startTime}ms ` +
            `(dismissedPurged=${result.dismissedPurged})`
        );
      } catch (error) {
        console.error(
          `[ViolationRetention] Job ${job.id} failed after ${Date.now() - startTime}ms:`,
          error
        );
        throw error;
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
    }
  );

  retentionWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[ViolationRetention] Worker error:', error);
  });

  console.log('[ViolationRetention] Worker started');
}

/**
 * Schedule the daily violation retention purge
 */
export async function scheduleViolationRetention(): Promise<void> {
  if (!retentionQueue) {
    console.error('[ViolationRetention] Queue not initialized');
    return;
  }

  const schedulers = await retentionQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    if (scheduler.id) {
      await retentionQueue.removeJobScheduler(scheduler.id);
    }
  }

  await retentionQueue.add(
    'scheduled-purge',
    { type: 'purge' },
    {
      repeat: {
        every: PURGE_INTERVAL_MS,
      },
      jobId: 'violation-retention-repeatable',
    }
  );

  console.log('[ViolationRetention] Scheduled daily dismissed-violation purge');
}

export interface ViolationRetentionResult {
  dismissedPurged: number;
}

async function deleteBatched(where: ReturnType<typeof sql>): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.execute(sql`
      DELETE FROM violations
      WHERE id IN (
        SELECT id FROM violations
        WHERE ${where}
        LIMIT ${DELETE_BATCH_SIZE}
      )
    `);
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < DELETE_BATCH_SIZE) break;
  }
  return total;
}

/**
 * Hard-delete dismissed violations past the retention window.
 */
export async function processViolationRetention(): Promise<ViolationRetentionResult> {
  const dismissedCutoff = new Date(Date.now() - DISMISSED_RETENTION_DAYS * TIME_MS.DAY);
  const dismissedPurged = await deleteBatched(
    sql`dismissed_at IS NOT NULL AND dismissed_at < ${dismissedCutoff} AND session_id IS NOT NULL`
  );

  return { dismissedPurged };
}

/**
 * Gracefully shutdown the violation retention queue and worker
 */
export async function shutdownViolationRetentionQueue(): Promise<void> {
  console.log('[ViolationRetention] Shutting down queue...');

  if (retentionWorker) {
    await retentionWorker.close();
    retentionWorker = null;
  }

  if (retentionQueue) {
    await retentionQueue.close();
    retentionQueue = null;
  }

  console.log('[ViolationRetention] Queue shutdown complete');
}
