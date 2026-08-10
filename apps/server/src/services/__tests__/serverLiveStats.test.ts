import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  recordServerStatsSample,
  getPluginServerStats,
  getServerLiveStats,
  plexClockShift,
} from '../serverLiveStats.js';

const serverId = 'srv-1';

function fakeRedis() {
  const multiChain = {
    lpush: vi.fn().mockReturnThis(),
    ltrim: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  const redis = {
    multi: vi.fn(() => multiChain),
    lindex: vi.fn().mockResolvedValue(null),
    lrange: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue('OK'),
  };
  return { redis: redis as unknown as Redis, raw: redis, multiChain };
}

// `at` is deliberately far from RECEIVED_AT - ingest should discard it
const completeSample = {
  at: 1786151199,
  hostCpuUtilization: 3.257,
  processCpuUtilization: 0.622,
  hostMemoryUtilization: 30.042,
  processMemoryUtilization: 0.548,
};

const RECEIVED_AT_MS = 1786158888_400;
const RECEIVED_AT = 1786158888;

describe('recordServerStatsSample', () => {
  let ctx: ReturnType<typeof fakeRedis>;

  beforeEach(() => {
    ctx = fakeRedis();
    vi.useFakeTimers();
    vi.setSystemTime(RECEIVED_AT_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-stamps with our own clock so a drifting plugin host cannot shift its line', async () => {
    await recordServerStatsSample(ctx.redis, serverId, completeSample);

    const [key, payload] = ctx.multiChain.lpush.mock.calls[0] as [string, string];
    expect(key).toContain(serverId);
    expect(JSON.parse(payload)).toEqual({
      at: RECEIVED_AT,
      timespan: 6,
      hostCpuUtilization: 3.257,
      processCpuUtilization: 0.622,
      hostMemoryUtilization: 30.042,
      processMemoryUtilization: 0.548,
    });
    expect(ctx.multiChain.ltrim).toHaveBeenCalledWith(key, 0, 25);
    expect(ctx.multiChain.expire).toHaveBeenCalledWith(key, 240);
    expect(ctx.multiChain.exec).toHaveBeenCalledTimes(1);
  });

  it('skips a duplicate when a reconnect delivers two events in one second', async () => {
    ctx.raw.lindex.mockResolvedValueOnce(JSON.stringify({ at: RECEIVED_AT }));

    await recordServerStatsSample(ctx.redis, serverId, completeSample);

    expect(ctx.multiChain.lpush).not.toHaveBeenCalled();
  });

  it('floors the receive time to a whole second without quantizing to a grid', async () => {
    vi.setSystemTime(1786158892_999);
    await recordServerStatsSample(ctx.redis, serverId, completeSample);

    const [, payload] = ctx.multiChain.lpush.mock.calls[0] as [string, string];
    expect((JSON.parse(payload) as { at: number }).at).toBe(1786158892);
  });

  it('keeps samples with null host metrics so non-Linux hosts still chart', async () => {
    await recordServerStatsSample(ctx.redis, serverId, {
      ...completeSample,
      hostCpuUtilization: null,
      hostMemoryUtilization: null,
    });

    const [, payload] = ctx.multiChain.lpush.mock.calls[0] as [string, string];
    expect(JSON.parse(payload)).toEqual({
      at: RECEIVED_AT,
      timespan: 6,
      hostCpuUtilization: null,
      processCpuUtilization: 0.622,
      hostMemoryUtilization: null,
      processMemoryUtilization: 0.548,
    });
  });

  it('drops samples missing process metrics', async () => {
    await recordServerStatsSample(ctx.redis, serverId, {
      ...completeSample,
      processCpuUtilization: null,
    });

    expect(ctx.raw.multi).not.toHaveBeenCalled();
  });

  it('swallows redis failures', async () => {
    ctx.multiChain.exec.mockRejectedValue(new Error('down'));

    await expect(
      recordServerStatsSample(ctx.redis, serverId, completeSample)
    ).resolves.toBeUndefined();
  });

  it('still writes when the buffer head is corrupt', async () => {
    ctx.raw.lindex.mockResolvedValueOnce('{not json');

    await recordServerStatsSample(ctx.redis, serverId, completeSample);

    expect(ctx.multiChain.lpush).toHaveBeenCalled();
  });
});

describe('getPluginServerStats', () => {
  it('parses buffered points and skips malformed entries', async () => {
    const ctx = fakeRedis();
    const point = {
      at: 100,
      timespan: 6,
      hostCpuUtilization: 1,
      processCpuUtilization: 2,
      hostMemoryUtilization: 3,
      processMemoryUtilization: 4,
    };
    ctx.raw.lrange.mockResolvedValue([JSON.stringify(point), 'not-json']);

    const result = await getPluginServerStats(ctx.redis, serverId);

    expect(result).toEqual([point]);
    expect(ctx.raw.lrange.mock.calls[0]?.[0]).toContain(serverId);
  });

  it('returns empty on redis failure', async () => {
    const ctx = fakeRedis();
    ctx.raw.lrange.mockRejectedValue(new Error('down'));

    expect(await getPluginServerStats(ctx.redis, serverId)).toEqual([]);
  });
});

describe('plexClockShift', () => {
  const now = () => Math.floor(Date.now() / 1000);

  it('leaves a synced server alone so its real sampling lag stays visible', () => {
    expect(plexClockShift([{ at: now() - 4 }])).toBe(0);
  });

  it('drags a slow server back into the window, keeping a plausible lag', () => {
    // 200s behind is a broken clock: shift all but a plausible lag
    expect(plexClockShift([{ at: now() - 200 }])).toBe(185);
  });

  it('pulls a server whose clock runs ahead back to now', () => {
    expect(plexClockShift([{ at: now() + 60 }])).toBe(-60);
  });

  it('anchors on the newest point across every series', () => {
    expect(plexClockShift([{ at: now() - 300 }], [{ at: now() - 2 }])).toBe(0);
  });

  it('is a no-op with no points', () => {
    expect(plexClockShift([], [])).toBe(0);
  });
});

describe('getServerLiveStats', () => {
  it('serves plugin-buffered statistics for non-plex servers with empty bandwidth', async () => {
    const ctx = fakeRedis();
    const point = {
      at: 100,
      timespan: 6,
      hostCpuUtilization: 1,
      processCpuUtilization: 2,
      hostMemoryUtilization: 3,
      processMemoryUtilization: 4,
    };
    ctx.raw.lrange.mockResolvedValue([JSON.stringify(point)]);

    const result = await getServerLiveStats(ctx.redis, {
      id: serverId,
      type: 'jellyfin',
      url: 'http://jf.local',
      token: 'tok',
    });

    expect(result).toEqual({
      statistics: [point],
      bandwidth: [],
      bandwidthSamples: [],
      bandwidthAccounts: [],
      bandwidthDevices: [],
    });
    expect(ctx.raw.get).not.toHaveBeenCalled();
  });
});
