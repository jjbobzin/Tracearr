/**
 * Precache pass policy tests - the watermark vs. full-pass vs. skip decision
 * that runs after every library sync.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { REDIS_KEYS } from '@tracearr/shared';
import { resolvePrecachePass, PRECACHE_FULL_PASS_INTERVAL_MS } from '../precachePassPolicy.js';

function makeMockRedis(initial: Record<string, string> = {}): Redis {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
  } as unknown as Redis;
}

const SERVER_ID = 'server-1';

beforeEach(() => {
  vi.useRealTimers();
});

describe('resolvePrecachePass', () => {
  it('requests a full pass and does not gate on hadChanges when there is no Redis client', async () => {
    const result = await resolvePrecachePass(null, SERVER_ID, 'scheduled', false);
    expect(result).toEqual({ sinceUpdatedAt: null });
  });

  it('skips entirely when the sync had no changes and a full pass is not due', async () => {
    const redis = makeMockRedis({
      [REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(SERVER_ID)]: new Date().toISOString(),
    });

    const result = await resolvePrecachePass(redis, SERVER_ID, 'scheduled', false);

    expect(result).toBeNull();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('uses the stored watermark for a scheduled sync with changes, when a full pass is not due', async () => {
    const watermark = '2026-01-01T00:00:00.000Z';
    const redis = makeMockRedis({
      [REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(SERVER_ID)]: new Date().toISOString(),
      [REDIS_KEYS.LIBRARY_PRECACHE_WATERMARK(SERVER_ID)]: watermark,
    });

    const result = await resolvePrecachePass(redis, SERVER_ID, 'scheduled', true);

    expect(result).toEqual({ sinceUpdatedAt: watermark });
    // Watermark gets refreshed for next time even on a non-full pass.
    expect(redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.LIBRARY_PRECACHE_WATERMARK(SERVER_ID),
      expect.any(String)
    );
  });

  it('forces a full pass (sinceUpdatedAt null) for a manual sync even with a recent last-full timestamp', async () => {
    const redis = makeMockRedis({
      [REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(SERVER_ID)]: new Date().toISOString(),
    });

    const result = await resolvePrecachePass(redis, SERVER_ID, 'manual', true);

    expect(result).toEqual({ sinceUpdatedAt: null });
    expect(redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(SERVER_ID),
      expect.any(String)
    );
  });

  it('runs a full pass on its interval even when the sync had no changes (backstop)', async () => {
    const staleLastFull = new Date(
      Date.now() - PRECACHE_FULL_PASS_INTERVAL_MS - 1000
    ).toISOString();
    const redis = makeMockRedis({
      [REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(SERVER_ID)]: staleLastFull,
    });

    const result = await resolvePrecachePass(redis, SERVER_ID, 'scheduled', false);

    expect(result).toEqual({ sinceUpdatedAt: null });
    expect(redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(SERVER_ID),
      expect.any(String)
    );
  });

  it('treats a corrupt stored last-full value as due for a full pass, not as not due', async () => {
    const redis = makeMockRedis({
      [REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(SERVER_ID)]: 'not-a-date',
    });

    const result = await resolvePrecachePass(redis, SERVER_ID, 'scheduled', false);

    expect(result).toEqual({ sinceUpdatedAt: null });
    expect(redis.set).toHaveBeenCalledWith(
      REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(SERVER_ID),
      expect.any(String)
    );
  });

  it('does not force a full pass yet when the interval has not elapsed', async () => {
    const recentLastFull = new Date(
      Date.now() - PRECACHE_FULL_PASS_INTERVAL_MS + 60_000
    ).toISOString();
    const watermark = '2026-01-01T00:00:00.000Z';
    const redis = makeMockRedis({
      [REDIS_KEYS.LIBRARY_PRECACHE_LAST_FULL(SERVER_ID)]: recentLastFull,
      [REDIS_KEYS.LIBRARY_PRECACHE_WATERMARK(SERVER_ID)]: watermark,
    });

    const result = await resolvePrecachePass(redis, SERVER_ID, 'scheduled', true);

    expect(result).toEqual({ sinceUpdatedAt: watermark });
  });

  it('treats a never-run server (no last-full key) as due for a full pass', async () => {
    const redis = makeMockRedis();

    const result = await resolvePrecachePass(redis, SERVER_ID, 'scheduled', true);

    expect(result).toEqual({ sinceUpdatedAt: null });
  });
});
