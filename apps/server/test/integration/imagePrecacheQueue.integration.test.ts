/**
 * Image precache job: selection and warming against a real database and a
 * real (but instrumented) upstream fetch.
 *
 * imagePrecacheQueue.test.ts (services suite) proves the batching, concurrency
 * bound, and fail-open behavior with the database and imageProxy mocked; this
 * suite proves the actual "needs warming" decision, which lives in the real
 * SQL WHERE clause and the real on-disk cache-existence check that a mocked
 * db.select() can't honestly exercise.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- imagePrecacheQueue
 */

import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { createTestServer, createTestLibraryItem } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { libraryItems } from '../../src/db/schema.js';
import {
  processImagePrecacheJob,
  type ImagePrecacheJobData,
} from '../../src/jobs/imagePrecacheQueue.js';
import {
  proxyImage,
  posterVersionFor,
  posterCacheEntryExists,
} from '../../src/services/imageProxy.js';

const CACHE_DIR = join(process.cwd(), 'data', 'image-cache');

let testImage: Buffer;

beforeAll(async () => {
  testImage = await sharp({
    create: { width: 12, height: 12, channels: 3, background: { r: 40, g: 80, b: 160 } },
  })
    .jpeg()
    .toBuffer();
});

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(counter: { calls: number }): void {
  globalThis.fetch = (async () => {
    counter.calls++;
    return new Response(testImage, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }) as unknown as typeof fetch;
}

function makeJob(data: ImagePrecacheJobData): Job<ImagePrecacheJobData> {
  return { data } as unknown as Job<ImagePrecacheJobData>;
}

/** Mirrors buildCacheKeyInfo's derivation so the eviction test can delete the exact file. */
function cacheFilePathFor(
  serverId: string,
  thumbPath: string,
  width: number,
  height: number
): string {
  const version = posterVersionFor(thumbPath);
  const baseHash = createHash('sha256')
    .update(`${serverId}:${thumbPath}:${width}:${height}`)
    .digest('hex')
    .slice(0, 16);
  const shard = baseHash.slice(0, 2);
  return join(CACHE_DIR, shard, `${baseHash}:v${version}.webp`);
}

describe('image precache job: real selection + warming behavior', () => {
  it('warms an item whose grid cache entries are missing even though dominant color is already set', async () => {
    const server = await createTestServer({ type: 'plex' });
    const { id, ratingKey } = await createTestLibraryItem({ serverId: server.id });
    const thumbPath = `/library/metadata/${ratingKey}/thumb/${randomUUID()}`;
    await db
      .update(libraryItems)
      .set({ thumbPath, dominantColor: '#112233' })
      .where(eq(libraryItems.id, id));

    const counter = { calls: 0 };
    stubFetch(counter);

    const result = await processImagePrecacheJob(makeJob({ serverId: server.id, cursor: null }));

    expect(result).toEqual({ processed: 1 });
    expect(counter.calls).toBe(3); // 160 + 240 + 360
    await expect(posterCacheEntryExists(server.id, thumbPath, 160)).resolves.toBe(true);
    await expect(posterCacheEntryExists(server.id, thumbPath, 240)).resolves.toBe(true);
    await expect(posterCacheEntryExists(server.id, thumbPath, 360)).resolves.toBe(true);
  });

  it('skips a fully-warmed item (all grid widths cached, dominant color set)', async () => {
    const server = await createTestServer({ type: 'plex' });
    const { id, ratingKey } = await createTestLibraryItem({ serverId: server.id });
    const thumbPath = `/library/metadata/${ratingKey}/thumb/${randomUUID()}`;
    await db.update(libraryItems).set({ thumbPath }).where(eq(libraryItems.id, id));

    const counter = { calls: 0 };
    stubFetch(counter);
    const version = posterVersionFor(thumbPath);
    await proxyImage({
      serverId: server.id,
      imagePath: thumbPath,
      width: 160,
      height: 240,
      version,
    });
    await proxyImage({
      serverId: server.id,
      imagePath: thumbPath,
      width: 240,
      height: 360,
      version,
    });
    await proxyImage({
      serverId: server.id,
      imagePath: thumbPath,
      width: 360,
      height: 540,
      version,
    });
    expect(counter.calls).toBe(3);

    await db.update(libraryItems).set({ dominantColor: '#112233' }).where(eq(libraryItems.id, id));

    counter.calls = 0;
    const result = await processImagePrecacheJob(makeJob({ serverId: server.id, cursor: null }));

    expect(result).toEqual({ processed: 1 });
    expect(counter.calls).toBe(0);
  });

  it('re-warms only the width whose cache file was evicted from disk', async () => {
    const server = await createTestServer({ type: 'plex' });
    const { id, ratingKey } = await createTestLibraryItem({ serverId: server.id });
    const thumbPath = `/library/metadata/${ratingKey}/thumb/${randomUUID()}`;
    await db.update(libraryItems).set({ thumbPath }).where(eq(libraryItems.id, id));

    const counter = { calls: 0 };
    stubFetch(counter);
    const version = posterVersionFor(thumbPath);
    await proxyImage({
      serverId: server.id,
      imagePath: thumbPath,
      width: 160,
      height: 240,
      version,
    });
    await proxyImage({
      serverId: server.id,
      imagePath: thumbPath,
      width: 240,
      height: 360,
      version,
    });
    await proxyImage({
      serverId: server.id,
      imagePath: thumbPath,
      width: 360,
      height: 540,
      version,
    });
    expect(counter.calls).toBe(3);

    await unlink(cacheFilePathFor(server.id, thumbPath, 240, 360));
    await expect(posterCacheEntryExists(server.id, thumbPath, 160)).resolves.toBe(true);
    await expect(posterCacheEntryExists(server.id, thumbPath, 240)).resolves.toBe(false);
    await expect(posterCacheEntryExists(server.id, thumbPath, 360)).resolves.toBe(true);

    counter.calls = 0;
    const result = await processImagePrecacheJob(makeJob({ serverId: server.id, cursor: null }));

    expect(result).toEqual({ processed: 1 });
    expect(counter.calls).toBe(1); // only the evicted 240 width is re-fetched
    await expect(posterCacheEntryExists(server.id, thumbPath, 240)).resolves.toBe(true);
  });

  it('sinceUpdatedAt scopes the pass to items touched on/after the watermark', async () => {
    const server = await createTestServer({ type: 'plex' });
    const stale = await createTestLibraryItem({ serverId: server.id });
    const fresh = await createTestLibraryItem({ serverId: server.id });
    const staleThumb = `/library/metadata/${stale.ratingKey}/thumb/${randomUUID()}`;
    const freshThumb = `/library/metadata/${fresh.ratingKey}/thumb/${randomUUID()}`;
    const watermark = new Date('2026-01-15T00:00:00.000Z');

    // Stale item was last touched before the watermark - e.g. a full-scan
    // pass over byte-identical rows that never bumped updated_at (Fix 3).
    await db
      .update(libraryItems)
      .set({ thumbPath: staleThumb, updatedAt: new Date(watermark.getTime() - 60_000) })
      .where(eq(libraryItems.id, stale.id));
    // Fresh item is newly added/changed since the watermark.
    await db
      .update(libraryItems)
      .set({ thumbPath: freshThumb, updatedAt: new Date(watermark.getTime() + 60_000) })
      .where(eq(libraryItems.id, fresh.id));

    const counter = { calls: 0 };
    stubFetch(counter);

    const result = await processImagePrecacheJob(
      makeJob({ serverId: server.id, cursor: null, sinceUpdatedAt: watermark.toISOString() })
    );

    expect(result).toEqual({ processed: 1 });
    expect(counter.calls).toBe(3); // only the fresh item's three widths
    await expect(posterCacheEntryExists(server.id, freshThumb, 240)).resolves.toBe(true);
    await expect(posterCacheEntryExists(server.id, staleThumb, 240)).resolves.toBe(false);
  });
});
