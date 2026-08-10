/**
 * Image Precache Queue - warms the poster cache for a server after its
 * library sync completes, so the first browse of a freshly synced library
 * doesn't pay the cold-fetch cost for every poster.
 *
 * Walks library_items in cursor-ordered batches of 50, re-enqueueing itself
 * with the next cursor until the server is fully warmed. Pauses (delayed
 * re-enqueue) while a sync for the same server is active, since the sync
 * itself may still be writing thumb_path/dominant_color for these rows.
 *
 * A pass can optionally be scoped to `sinceUpdatedAt`: only rows whose
 * library_items.updated_at moved on/after that timestamp are candidates.
 * The caller (librarySyncQueue.ts) decides when to use a watermark versus a
 * full walk, and propagates the same value through every cursor-continuation
 * and delayed re-enqueue so a single pass stays consistently scoped.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { and, asc, eq, gt, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import { getRedisPrefix } from '@tracearr/shared';
import { isMaintenance } from '../serverState.js';
import { db } from '../db/client.js';
import { libraryItems } from '../db/schema.js';
import {
  proxyImage,
  posterCacheEntryExists,
  IMAGE_SIZES,
  posterVersionFor,
} from '../services/imageProxy.js';
import { getSetting } from '../services/settings.js';
import { getLibrarySyncStatus } from './librarySyncQueue.js';

export interface ImagePrecacheJobData {
  serverId: string;
  cursor: string | null;
  /** Only warm rows whose library_items.updated_at is on/after this ISO
   *  timestamp. Omitted (or null) means a full pass over every active item
   *  with a thumb_path - the periodic backstop that heals disk cache
   *  eviction or anything a watermark pass could miss. */
  sinceUpdatedAt?: string | null;
  /** Pass-level progress for the running-tasks UI, threaded through the
   *  cursor chain. Seeded by the first batch (which counts eligible rows)
   *  and absent on externally-enqueued pass starts. */
  totalItems?: number;
  processedItems?: number;
  /** ISO start of the whole pass, not of the current chained job. */
  passStartedAt?: string;
}

const QUEUE_NAME = 'image-precache';
const BATCH_SIZE = 50;
// Self-limits to at most 2 of the global 6 fetch-semaphore slots (imageProxy.ts)
// so a precache pass never starves live poster requests from real browsing.
const MAX_CONCURRENT_WARMS = 2;
const SYNC_ACTIVE_RETRY_DELAY_MS = 60 * 1000;

let connectionOptions: ConnectionOptions | null = null;
let imagePrecacheQueue: Queue<ImagePrecacheJobData> | null = null;
let imagePrecacheWorker: Worker<ImagePrecacheJobData> | null = null;

/**
 * Initialize the image precache queue with a Redis connection.
 */
export function initImagePrecacheQueue(redisUrl: string): void {
  if (imagePrecacheQueue) {
    console.log('[ImagePrecache] Queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  const bullPrefix = `${getRedisPrefix()}bull`;

  imagePrecacheQueue = new Queue<ImagePrecacheJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000,
      },
      removeOnComplete: {
        count: 100,
        age: 24 * 60 * 60, // 24h
      },
      removeOnFail: {
        count: 50,
      },
    },
  });
  imagePrecacheQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[ImagePrecache] Queue error:', err);
  });

  console.log('[ImagePrecache] Queue initialized');
}

/**
 * Start the image precache worker to process queued jobs.
 */
export function startImagePrecacheWorker(): void {
  if (!connectionOptions) {
    throw new Error('Image precache queue not initialized. Call initImagePrecacheQueue first.');
  }

  if (imagePrecacheWorker) {
    console.log('[ImagePrecache] Worker already running');
    return;
  }

  const bullPrefix = `${getRedisPrefix()}bull`;

  imagePrecacheWorker = new Worker<ImagePrecacheJobData>(
    QUEUE_NAME,
    async (job: Job<ImagePrecacheJobData>) => processImagePrecacheJob(job),
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
    }
  );

  imagePrecacheWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[ImagePrecache] Worker error:', error);
  });

  console.log('[ImagePrecache] Worker started');
}

/**
 * Enqueue an image precache pass for a server. No-ops when the setting is
 * disabled or the queue isn't initialized, so callers don't need to check
 * either condition themselves.
 */
export async function enqueueImagePrecache(
  serverId: string,
  cursor: string | null = null,
  sinceUpdatedAt?: string | null
): Promise<string | undefined> {
  if (!imagePrecacheQueue) return undefined;

  const enabled = await getSetting('imagePrecacheEnabled');
  if (!enabled) return undefined;

  const job = await imagePrecacheQueue.add(
    'precache',
    sinceUpdatedAt ? { serverId, cursor, sinceUpdatedAt } : { serverId, cursor },
    { jobId: `precache-${serverId}-${cursor ?? 'start'}-${Date.now()}` }
  );

  return job.id;
}

/** Chain continuation: carries the full job data (including pass progress)
 *  forward, with an optional delay. Fresh jobId every call - Date.now()
 *  advances, so a same-tick re-add of the active job's own id can't collide. */
async function enqueueChained(data: ImagePrecacheJobData, delayMs?: number) {
  if (!imagePrecacheQueue) return;

  const job = await imagePrecacheQueue.add('precache', data, {
    jobId: `precache-${data.serverId}-${data.cursor ?? 'start'}-${Date.now()}`,
    ...(delayMs !== undefined ? { delay: delayMs } : {}),
  });
  return job.id;
}

/** Count the rows a pass will walk - same predicate as fetchBatch, minus the
 *  cursor. Runs once per pass (first batch) to seed the progress total. */
async function countEligibleItems(
  serverId: string,
  sinceUpdatedAt?: string | null
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.serverId, serverId),
        isNull(libraryItems.removedAt),
        isNotNull(libraryItems.thumbPath),
        sinceUpdatedAt ? gte(libraryItems.updatedAt, new Date(sinceUpdatedAt)) : undefined
      )
    );
  return row?.n ?? 0;
}

interface PrecacheBatchRow {
  id: string;
  thumbPath: string;
}

/**
 * Raw candidate rows for a server, active and with a thumb path, cursor-paged
 * by id. Does NOT filter by dominant_color or grid-cache existence - a row
 * with dominant_color already set can still be missing its 240/360 grid
 * entries (dominant_color is written by the first proxyImage call at ANY
 * width, including live browsing traffic at other sizes). Termination in
 * processImagePrecacheJob depends on this returning the raw SQL row count
 * unfiltered, so no JS-side filtering happens here.
 */
async function fetchBatch(
  serverId: string,
  cursor: string | null,
  sinceUpdatedAt?: string | null
): Promise<PrecacheBatchRow[]> {
  const rows = await db
    .select({ id: libraryItems.id, thumbPath: libraryItems.thumbPath })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.serverId, serverId),
        isNull(libraryItems.removedAt),
        isNotNull(libraryItems.thumbPath),
        cursor ? gt(libraryItems.id, cursor) : undefined,
        sinceUpdatedAt ? gte(libraryItems.updatedAt, new Date(sinceUpdatedAt)) : undefined
      )
    )
    .orderBy(asc(libraryItems.id))
    .limit(BATCH_SIZE);

  return rows.map((row) => ({ id: row.id, thumbPath: row.thumbPath! }));
}

/** Which of the three grid widths are missing their versioned cache entry on disk. */
async function missingWarmWidths(
  serverId: string,
  thumbPath: string
): Promise<Array<160 | 240 | 360>> {
  const [has160, has240, has360] = await Promise.all([
    posterCacheEntryExists(serverId, thumbPath, 160),
    posterCacheEntryExists(serverId, thumbPath, 240),
    posterCacheEntryExists(serverId, thumbPath, 360),
  ]);
  const widths: Array<160 | 240 | 360> = [];
  if (!has160) widths.push(160);
  if (!has240) widths.push(240);
  if (!has360) widths.push(360);
  return widths;
}

interface WarmTask {
  itemId: string;
  width: 160 | 240 | 360;
}

function dimensionsForWidth(width: 160 | 240 | 360) {
  if (width === 160) return IMAGE_SIZES.posterGrid160;
  if (width === 240) return IMAGE_SIZES.posterGrid240;
  return IMAGE_SIZES.posterGrid360;
}

/** One proxyImage call for one item at one bucket width. Each task is a
 *  single fetch-semaphore acquisition at most, so bounding concurrent tasks
 *  to MAX_CONCURRENT_WARMS bounds concurrent semaphore slots the same way.
 *  skipLqipRace keeps the task holding its warm-pool slot until the real
 *  pipeline settles, instead of freeing it early on the LQIP placeholder. */
async function runWarmTask(serverId: string, thumbPath: string, task: WarmTask): Promise<void> {
  const version = posterVersionFor(thumbPath);
  const dimensions = dimensionsForWidth(task.width);
  await proxyImage({ serverId, imagePath: thumbPath, ...dimensions, version, skipLqipRace: true });
}

/**
 * Process one batch: warm at most MAX_CONCURRENT_WARMS (item, width) pairs at
 * a time - never MAX_CONCURRENT_WARMS whole items in parallel, since an item
 * can need up to three proxyImage calls (160, 240, and 360, whichever cache
 * entries are missing) and each call is its own fetch-semaphore acquisition.
 * Re-enqueues for the next cursor when the raw batch came back full (more
 * items may remain beyond it).
 *
 * Fail-open: precache is a best-effort background warm, so one item's warm
 * failing is logged and skipped rather than failing the batch or the job.
 */
export async function processImagePrecacheJob(
  job: Job<ImagePrecacheJobData>
): Promise<{ skipped: true; reason: string } | { done: true } | { processed: number }> {
  const { serverId, cursor, sinceUpdatedAt } = job.data;

  const enabled = await getSetting('imagePrecacheEnabled');
  if (!enabled) {
    return { skipped: true, reason: 'disabled' };
  }

  const passStartedAt =
    job.data.passStartedAt ?? new Date(job.timestamp ?? Date.now()).toISOString();

  const syncStatus = await getLibrarySyncStatus(serverId);
  if (syncStatus?.isActive) {
    // Raw passthrough - the sync-active backoff must stay DB-free, so the
    // progress seed (which counts rows) waits for an actual processing run.
    await enqueueChained(
      {
        serverId,
        cursor,
        sinceUpdatedAt,
        totalItems: job.data.totalItems,
        processedItems: job.data.processedItems,
        passStartedAt,
      },
      SYNC_ACTIVE_RETRY_DELAY_MS
    );
    return { skipped: true, reason: 'sync active' };
  }

  // Seed pass progress on the first processing batch; continuations carry it.
  const processedItems = job.data.processedItems ?? 0;
  const totalItems = job.data.totalItems ?? (await countEligibleItems(serverId, sinceUpdatedAt));

  const batch = await fetchBatch(serverId, cursor, sinceUpdatedAt);
  if (batch.length === 0) {
    return { done: true };
  }

  const byId = new Map(batch.map((item) => [item.id, item.thumbPath]));
  const perItemWidths = await Promise.all(
    batch.map(async (item) => ({
      itemId: item.id,
      widths: await missingWarmWidths(serverId, item.thumbPath),
    }))
  );
  const tasks: WarmTask[] = perItemWidths.flatMap(({ itemId, widths }) =>
    widths.map((width) => ({ itemId, width }))
  );

  let nextIndex = 0;
  async function warmPoolWorker(): Promise<void> {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex++]!;
      const thumbPath = byId.get(task.itemId)!;
      // Fail-open: a single warm failing must not fail the batch or the job.
      try {
        await runWarmTask(serverId, thumbPath, task);
      } catch (err) {
        console.error(`[ImagePrecache] Failed to warm item ${task.itemId} (${task.width}):`, err);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_WARMS, tasks.length) }, () => warmPoolWorker())
  );

  if (batch.length === BATCH_SIZE) {
    const nextCursor = batch[batch.length - 1]!.id;
    await enqueueChained({
      serverId,
      cursor: nextCursor,
      sinceUpdatedAt,
      totalItems,
      processedItems: processedItems + batch.length,
      passStartedAt,
    });
  }

  return { processed: batch.length };
}

/**
 * Active precache passes for the running-tasks UI. A pass is a chain of
 * batch jobs; at any moment the chain has at most one live job per server
 * carrying cumulative pass progress in its data. Delayed jobs are the
 * sync-active backoff and count as pending, not running.
 */
export async function getAllActiveImagePrecacheJobs(): Promise<
  Array<{
    jobId: string;
    serverId: string;
    state: string;
    createdAt: number;
    passStartedAt: string | null;
    totalItems: number | null;
    processedItems: number;
  }>
> {
  if (!imagePrecacheQueue) {
    return [];
  }

  const jobs = await imagePrecacheQueue.getJobs(['active', 'waiting', 'delayed']);

  return Promise.all(
    jobs.map(async (job) => {
      const state = await job.getState();
      return {
        jobId: job.id ?? 'unknown',
        serverId: job.data.serverId,
        state,
        createdAt: job.timestamp ?? Date.now(),
        passStartedAt: job.data.passStartedAt ?? null,
        totalItems: job.data.totalItems ?? null,
        processedItems: job.data.processedItems ?? 0,
      };
    })
  );
}

/**
 * Gracefully shut down the image precache queue and worker.
 */
export async function shutdownImagePrecacheQueue(): Promise<void> {
  console.log('[ImagePrecache] Shutting down...');

  if (imagePrecacheWorker) {
    await imagePrecacheWorker.close();
    imagePrecacheWorker = null;
  }

  if (imagePrecacheQueue) {
    await imagePrecacheQueue.close();
    imagePrecacheQueue = null;
  }

  connectionOptions = null;

  console.log('[ImagePrecache] Shutdown complete');
}
