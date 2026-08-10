/**
 * Image Precache Queue tests.
 *
 * Covers the enabled-setting gate, batch/cursor re-enqueue, the pause-while-
 * sync branch, and the <=2 concurrent warm bound.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

const mockGetSetting = vi.fn();
const mockGetLibrarySyncStatus = vi.fn();
const mockProxyImage = vi.fn();
const mockPosterCacheEntryExists = vi.fn();
const mockDbSelect = vi.fn();

vi.mock('../../services/settings.js', () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}));

vi.mock('../librarySyncQueue.js', () => ({
  getLibrarySyncStatus: (...args: unknown[]) => mockGetLibrarySyncStatus(...args),
}));

vi.mock('../../services/imageProxy.js', () => ({
  proxyImage: (...args: unknown[]) => mockProxyImage(...args),
  posterCacheEntryExists: (...args: unknown[]) => mockPosterCacheEntryExists(...args),
  IMAGE_SIZES: {
    posterGrid160: { width: 160, height: 240 },
    posterGrid240: { width: 240, height: 360 },
    posterGrid360: { width: 360, height: 540 },
  },
  posterVersionFor: (path: string) => `v-${path}`,
}));

vi.mock('../../db/client.js', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}));

vi.mock('../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

const mockQueueAdd = vi.fn();
const mockQueueClose = vi.fn();
const mockWorkerClose = vi.fn();

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(function MockQueue() {
    return {
      add: mockQueueAdd,
      close: mockQueueClose,
      on: vi.fn(),
    };
  }),
  Worker: vi.fn().mockImplementation(function MockWorker() {
    return {
      on: vi.fn(),
      close: mockWorkerClose,
    };
  }),
}));

import {
  initImagePrecacheQueue,
  enqueueImagePrecache,
  processImagePrecacheJob,
  shutdownImagePrecacheQueue,
  type ImagePrecacheJobData,
} from '../imagePrecacheQueue.js';

function makeJob(data: ImagePrecacheJobData): Job<ImagePrecacheJobData> {
  return { data } as unknown as Job<ImagePrecacheJobData>;
}

/**
 * Mock both drizzle query shapes the processor uses: the batch fetch
 * (select().from().where().orderBy().limit() -> rows) and the pass-progress
 * count (select().from().where() awaited directly -> [{ n }]).
 */
function mockBatchQuery(rows: unknown[], eligibleCount = rows.length) {
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => {
        const countResult = Promise.resolve([{ n: eligibleCount }]);
        return Object.assign(countResult, {
          orderBy: () => ({
            limit: () => Promise.resolve(rows),
          }),
        });
      },
    }),
  });
}

function makeItemRow(id: string, thumbPath: string | null = '/thumb') {
  return { id, thumbPath };
}

describe('imagePrecacheQueue', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await shutdownImagePrecacheQueue();
    initImagePrecacheQueue('redis://localhost:6379');
    mockGetSetting.mockResolvedValue(true);
    mockGetLibrarySyncStatus.mockResolvedValue({ isActive: false });
    mockProxyImage.mockResolvedValue({
      data: Buffer.from(''),
      contentType: 'image/webp',
      cached: false,
    });
    // Every width missing by default, so pre-existing tests that assume every
    // candidate item gets fully warmed keep passing unchanged.
    mockPosterCacheEntryExists.mockResolvedValue(false);
  });

  describe('enqueueImagePrecache', () => {
    it('enqueues when imagePrecacheEnabled is true', async () => {
      mockGetSetting.mockResolvedValue(true);
      mockQueueAdd.mockResolvedValue({ id: 'job-1' });

      const result = await enqueueImagePrecache('server-1');

      expect(mockGetSetting).toHaveBeenCalledWith('imagePrecacheEnabled');
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({ serverId: 'server-1', cursor: null });
      expect(result).toBe('job-1');
    });

    it('does not enqueue when imagePrecacheEnabled is false', async () => {
      mockGetSetting.mockResolvedValue(false);

      const result = await enqueueImagePrecache('server-1');

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  describe('processImagePrecacheJob', () => {
    it('no-ops without touching the database when disabled', async () => {
      mockGetSetting.mockResolvedValue(false);

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ skipped: true, reason: 'disabled' });
      expect(mockGetLibrarySyncStatus).not.toHaveBeenCalled();
      expect(mockDbSelect).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('re-enqueues with a 60s delay and does not process when a sync is active for the server', async () => {
      mockGetLibrarySyncStatus.mockResolvedValue({ isActive: true });
      mockQueueAdd.mockResolvedValue({ id: 'job-delayed' });

      const result = await processImagePrecacheJob(
        makeJob({ serverId: 'server-1', cursor: 'cursor-1' })
      );

      expect(result).toEqual({ skipped: true, reason: 'sync active' });
      expect(mockDbSelect).not.toHaveBeenCalled();
      expect(mockProxyImage).not.toHaveBeenCalled();
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData, opts] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({
        serverId: 'server-1',
        cursor: 'cursor-1',
        passStartedAt: expect.any(String),
      });
      expect(opts.delay).toBe(60000);
    });

    it('processes a full batch of 50 and re-enqueues itself with the next cursor', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => makeItemRow(`item-${i}`));
      mockBatchQuery(rows);
      mockQueueAdd.mockResolvedValue({ id: 'job-next' });

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ processed: 50 });
      // Each item warms three widths (160 + 240 + 360).
      expect(mockProxyImage).toHaveBeenCalledTimes(150);
      expect(mockProxyImage).toHaveBeenCalledWith(expect.objectContaining({ skipLqipRace: true }));
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({
        serverId: 'server-1',
        cursor: 'item-49',
        totalItems: 50,
        processedItems: 50,
        passStartedAt: expect.any(String),
      });
    });

    it('re-enqueues from the raw row count even when one row in the raw 50 has a null thumbPath', async () => {
      const rows = Array.from({ length: 50 }, (_, i) =>
        i === 25 ? makeItemRow(`item-${i}`, null) : makeItemRow(`item-${i}`)
      );
      mockBatchQuery(rows);
      mockQueueAdd.mockResolvedValue({ id: 'job-next' });

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ processed: 50 });
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({
        serverId: 'server-1',
        cursor: 'item-49',
        totalItems: 50,
        processedItems: 50,
        passStartedAt: expect.any(String),
      });
    });

    it('carries pass progress through the cursor chain without recounting', async () => {
      const rows = Array.from({ length: 50 }, (_, i) => makeItemRow(`item-${i}`));
      mockBatchQuery(rows);
      mockQueueAdd.mockResolvedValue({ id: 'job-next' });

      const result = await processImagePrecacheJob(
        makeJob({
          serverId: 'server-1',
          cursor: 'item-99',
          totalItems: 500,
          processedItems: 100,
          passStartedAt: '2026-08-09T00:00:00.000Z',
        })
      );

      expect(result).toEqual({ processed: 50 });
      // totalItems present in the job data means the seed count is skipped:
      // one db.select for the batch, none for the count.
      expect(mockDbSelect).toHaveBeenCalledTimes(1);
      const [, jobData] = mockQueueAdd.mock.calls[0]!;
      expect(jobData).toEqual({
        serverId: 'server-1',
        cursor: 'item-49',
        totalItems: 500,
        processedItems: 150,
        passStartedAt: '2026-08-09T00:00:00.000Z',
      });
    });

    it('does not re-enqueue when the batch is smaller than 50 (cursor exhausted)', async () => {
      const rows = [makeItemRow('item-0'), makeItemRow('item-1')];
      mockBatchQuery(rows);

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ processed: 2 });
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('reports done and skips warming when no items match', async () => {
      mockBatchQuery([]);

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ done: true });
      expect(mockProxyImage).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('never runs more than 2 concurrent warm calls', async () => {
      const rows = Array.from({ length: 5 }, (_, i) => makeItemRow(`item-${i}`));
      mockBatchQuery(rows);

      let active = 0;
      let peak = 0;
      mockProxyImage.mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { data: Buffer.from(''), contentType: 'image/webp', cached: false };
      });

      await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(mockProxyImage).toHaveBeenCalledTimes(15); // 5 items x 3 widths
      expect(peak).toBeLessThanOrEqual(2);
      expect(peak).toBe(2); // confirms the pool actually parallelizes, not serialized to 1
    });

    it('continues the batch and does not fail the job when one warm call throws', async () => {
      const rows = [makeItemRow('item-0'), makeItemRow('item-1')];
      mockBatchQuery(rows);
      mockProxyImage
        .mockRejectedValueOnce(new Error('upstream fetch failed'))
        .mockResolvedValue({ data: Buffer.from(''), contentType: 'image/webp', cached: false });

      const result = await processImagePrecacheJob(makeJob({ serverId: 'server-1', cursor: null }));

      expect(result).toEqual({ processed: 2 });
      expect(mockProxyImage).toHaveBeenCalledTimes(6); // 2 items x 3 widths, despite the first rejecting
    });
  });
});
