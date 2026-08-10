/**
 * Image proxy pipeline: semaphore-bounded concurrency and miss coalescing.
 *
 * imageProxy.test.ts (service suite) proves the pure pieces with fs/db/fetch
 * mocked; this suite proves the concurrency behavior end to end, against a
 * real server row and a real (but instrumented) upstream, since that's the
 * one thing a mocked-fs unit test can't demonstrate honestly.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- imageProxyPipeline
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import sharp from 'sharp';
import { createTestServer } from '@tracearr/test-utils/factories';
import { proxyImage } from '../../src/services/imageProxy.js';

let testImage: Buffer;

beforeAll(async () => {
  testImage = await sharp({
    create: { width: 12, height: 12, channels: 3, background: { r: 90, g: 60, b: 120 } },
  })
    .jpeg()
    .toBuffer();
});

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (input: RequestInfo | URL) => Promise<Response>): void {
  globalThis.fetch = handler as unknown as typeof fetch;
}

describe('image proxy pipeline concurrency', () => {
  it('bounds concurrent upstream fetches to 6 across 30 distinct posters', async () => {
    const server = await createTestServer({ type: 'plex' });

    let inFlight = 0;
    let maxInFlight = 0;
    let fetchCalls = 0;

    stubFetch(async () => {
      fetchCalls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight--;
      return new Response(testImage, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });

    const requests = Array.from({ length: 30 }, (_, i) =>
      proxyImage({
        serverId: server.id,
        imagePath: `/library/metadata/${i}/thumb/${i}`,
        width: 240,
        height: 360,
      })
    );

    const results = await Promise.all(requests);

    expect(fetchCalls).toBe(30);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(maxInFlight).toBeGreaterThan(1);
    for (const result of results) {
      expect(result.contentType).toBe('image/webp');
      expect(result.data.length).toBeGreaterThan(0);
    }
  });

  it('coalesces 10 concurrent requests for the same poster into exactly 1 upstream fetch', async () => {
    const server = await createTestServer({ type: 'plex' });
    const imagePath = `/library/metadata/${randomUUID()}/thumb/1`;

    let fetchCalls = 0;
    stubFetch(async () => {
      fetchCalls++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return new Response(testImage, { status: 200, headers: { 'content-type': 'image/jpeg' } });
    });

    const requests = Array.from({ length: 10 }, () =>
      proxyImage({ serverId: server.id, imagePath, width: 240, height: 360 })
    );

    const results = await Promise.all(requests);

    expect(fetchCalls).toBe(1);
    for (const result of results) {
      expect(result.contentType).toBe('image/webp');
      expect(result.data.length).toBeGreaterThan(0);
    }
  });
});
