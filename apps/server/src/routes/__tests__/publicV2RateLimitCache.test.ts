import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../services/settings.js', () => ({ getSetting: vi.fn() }));

import { getSetting } from '../../services/settings.js';
import { getPublicApiRateLimit, resetPublicApiRateLimitCache } from '../publicV2/rateLimitCache.js';

describe('getPublicApiRateLimit', () => {
  beforeEach(() => {
    resetPublicApiRateLimitCache();
    vi.useRealTimers();
    vi.mocked(getSetting).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves the configured setting', async () => {
    vi.mocked(getSetting).mockResolvedValue(500);
    await expect(getPublicApiRateLimit()).resolves.toBe(500);
  });

  it('serves subsequent lookups from the snapshot without re-querying', async () => {
    vi.mocked(getSetting).mockResolvedValue(500);
    await getPublicApiRateLimit();
    await getPublicApiRateLimit();
    await getPublicApiRateLimit();
    expect(getSetting).toHaveBeenCalledTimes(1);
  });

  it('refreshes the snapshot once the TTL elapses', async () => {
    vi.useFakeTimers();
    vi.mocked(getSetting).mockResolvedValue(500);
    await getPublicApiRateLimit();

    vi.advanceTimersByTime(30_001);
    vi.mocked(getSetting).mockResolvedValue(100);
    await expect(getPublicApiRateLimit()).resolves.toBe(100);
    expect(getSetting).toHaveBeenCalledTimes(2);
  });

  it('fails open to the default (240) when the DB errors on the first-ever load', async () => {
    vi.mocked(getSetting).mockRejectedValue(new Error('db down'));
    await expect(getPublicApiRateLimit()).resolves.toBe(240);
  });

  it('falls back to the last known-good value when a refresh errors', async () => {
    vi.useFakeTimers();
    vi.mocked(getSetting).mockResolvedValue(500);
    await getPublicApiRateLimit();

    vi.advanceTimersByTime(30_001);
    vi.mocked(getSetting).mockRejectedValue(new Error('db down'));
    await expect(getPublicApiRateLimit()).resolves.toBe(500);
  });
});
