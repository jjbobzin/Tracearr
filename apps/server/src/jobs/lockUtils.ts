/**
 * Shared utilities for BullMQ job lock management
 */

import type { Job } from 'bullmq';

/**
 * Lock duration for maintenance jobs, shared between the Worker's `lockDuration`
 * option and extendJobLock's default extension so a manual extend can never
 * silently grant more time than the worker (and BullMQ's stalled detection)
 * think the job actually has.
 */
export const MAINTENANCE_LOCK_DURATION_MS = 5 * 60 * 1000;

/**
 * Extend the job lock, failing fast if extension fails.
 *
 * Fail-CLOSED: a job that cannot prove it still owns its lock must abort,
 * never continue. `Job.extendLock` does not throw when the lock was lost or
 * stolen (a stalled sweep reclaimed it, or a lock-stealing replacement worker
 * took over) - it resolves to `0`. Treating that as success would let a
 * falsely-stalled or superseded job keep running to completion in parallel
 * with its replacement, writing the same data twice. Every batch boundary
 * that calls this is meant to be a real abort point.
 *
 * @param job - The BullMQ job to extend the lock for
 * @param durationMs - How long to extend the lock (default: MAINTENANCE_LOCK_DURATION_MS)
 * @throws Error if the lock could not be extended or was lost
 */
export async function extendJobLock(job: Job, durationMs: number = MAINTENANCE_LOCK_DURATION_MS) {
  if (!job.token) {
    throw new Error(`Job ${job.id} has no lock token - cannot extend lock`);
  }

  try {
    const result = await job.extendLock(job.token, durationMs);
    if (result === 0) {
      throw new Error(`Lost lock for maintenance job ${job.id}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Lost lock for job ${job.id} - aborting to allow clean retry. ` +
        `This usually indicates a Redis connectivity issue or a lock stolen by a replacement worker. ` +
        `Original error: ${message}`
    );
  }
}
