/**
 * Connection budget: pool sizing from postgres's real max_connections and
 * the live instance count. The share math is what keeps two instances
 * against a stock 100-connection postgres from tripping
 * "sorry, too many clients already".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockSetPoolMax = vi.fn();
const mockGetPoolMax = vi.fn().mockReturnValue(50);
const mockExecute = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
  setPoolMax: (...args: unknown[]) => mockSetPoolMax(...args),
  getPoolMax: () => mockGetPoolMax(),
}));

import {
  computePoolShare,
  startConnectionBudget,
  stopConnectionBudget,
} from '../connectionBudget.js';

function mockRedis(instanceCount: number) {
  return {
    zadd: vi.fn().mockResolvedValue(1),
    zremrangebyscore: vi.fn().mockResolvedValue(0),
    zcard: vi.fn().mockResolvedValue(instanceCount),
    pexpire: vi.fn().mockResolvedValue(1),
    zrem: vi.fn().mockResolvedValue(1),
  };
}

describe('computePoolShare', () => {
  it('caps a single instance at the historical default', () => {
    expect(computePoolShare(100, 1)).toBe(50);
    expect(computePoolShare(400, 1)).toBe(50);
  });

  it('splits the cap fairly across instances after the reserve', () => {
    expect(computePoolShare(100, 2)).toBe(46);
    expect(computePoolShare(100, 3)).toBe(30);
    expect(computePoolShare(150, 2)).toBe(50);
    expect(computePoolShare(150, 3)).toBe(47);
  });

  it('floors tiny shares so the app still functions, oversubscribed or not', () => {
    expect(computePoolShare(12, 2)).toBe(5);
    expect(computePoolShare(20, 4)).toBe(5);
  });

  it('treats a zero instance count as one', () => {
    expect(computePoolShare(100, 0)).toBe(50);
  });
});

describe('startConnectionBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPoolMax.mockReturnValue(50);
    mockExecute.mockResolvedValue({ rows: [{ max_connections: '100' }] });
  });

  afterEach(async () => {
    await stopConnectionBudget();
    vi.unstubAllEnvs();
  });

  it('sizes the pool to the fair share for the live instance count', async () => {
    const redis = mockRedis(2);

    await startConnectionBudget(redis as never);

    expect(mockSetPoolMax).toHaveBeenCalledWith(46);
    expect(redis.zadd).toHaveBeenCalled();
  });

  it('leaves the pool alone when the share already matches', async () => {
    mockGetPoolMax.mockReturnValue(50);
    const redis = mockRedis(1);

    await startConnectionBudget(redis as never);

    expect(mockSetPoolMax).not.toHaveBeenCalled();
  });

  it('does nothing but warn when DATABASE_POOL_MAX is set explicitly', async () => {
    vi.stubEnv('DATABASE_POOL_MAX', '120');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const redis = mockRedis(1);

    await startConnectionBudget(redis as never);

    expect(mockSetPoolMax).not.toHaveBeenCalled();
    expect(redis.zadd).not.toHaveBeenCalled();
    // 120 > 100 - 8: oversubscription gets called out
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('exceeds postgres max_connections'));
    warn.mockRestore();
  });

  it('keeps the default pool when max_connections cannot be read', async () => {
    mockExecute.mockRejectedValue(new Error('connection refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const redis = mockRedis(1);

    await startConnectionBudget(redis as never);

    expect(mockSetPoolMax).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
