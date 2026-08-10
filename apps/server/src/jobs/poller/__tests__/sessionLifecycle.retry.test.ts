/**
 * Session Lifecycle Retry Tests (TDD - Red Phase)
 *
 * Tests for bounded retry logic when DB writes fail during session stop.
 * These tests are designed to FAIL initially (TDD red phase) because:
 * - stopSessionAtomic does not currently implement retry logic
 * - SessionStopResult does not include needsRetry property
 *
 * Expected behavior to implement:
 * 1. Retry on DB failure up to IMMEDIATE_RETRIES (3) times
 * 2. Return { needsRetry: true } when all immediate retries fail
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stopSessionAtomic } from '../sessionLifecycle.js';
import { getWatchedThreshold } from '../../../services/settings.js';

// Mock the db module
vi.mock('../../../db/client.js', () => ({
  db: {
    update: vi.fn(),
  },
}));

vi.mock('../../../services/settings.js', () => ({
  getWatchedThreshold: vi.fn().mockResolvedValue(0.85),
}));

describe('stopSessionAtomic retry logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should retry on DB failure up to IMMEDIATE_RETRIES times', async () => {
    const { db } = await import('../../../db/client.js');
    const mockUpdate = db.update as ReturnType<typeof vi.fn>;

    // Fail twice, succeed on third
    let callCount = 0;
    mockUpdate.mockImplementation(() => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            callCount++;
            if (callCount < 3) {
              throw new Error('Connection refused');
            }
            return [{ id: 'session-1' }];
          },
        }),
      }),
    }));

    const result = await stopSessionAtomic({
      session: {
        id: 'session-1',
        startedAt: new Date(),
        lastPausedAt: null,
        pausedDurationMs: 0,
        progressMs: null,
        totalDurationMs: 3600000,
        watched: false,
      } as Parameters<typeof stopSessionAtomic>[0]['session'],
      stoppedAt: new Date(),
    });

    expect(result.wasUpdated).toBe(true);
    expect(callCount).toBe(3);
  });

  it('should return retry data when all immediate retries fail', async () => {
    const { db } = await import('../../../db/client.js');
    const mockUpdate = db.update as ReturnType<typeof vi.fn>;

    mockUpdate.mockImplementation(() => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            throw new Error('Connection refused');
          },
        }),
      }),
    }));

    const result = await stopSessionAtomic({
      session: {
        id: 'session-1',
        startedAt: new Date(),
        lastPausedAt: null,
        pausedDurationMs: 0,
        progressMs: null,
        totalDurationMs: 3600000,
        watched: false,
      } as Parameters<typeof stopSessionAtomic>[0]['session'],
      stoppedAt: new Date(),
    });

    expect(result.wasUpdated).toBe(false);
    expect(result.needsRetry).toBe(true);
  });
});

describe('stopSessionAtomic watched threshold wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the watched threshold from the session media type', async () => {
    const { db } = await import('../../../db/client.js');
    const mockUpdate = db.update as ReturnType<typeof vi.fn>;
    mockUpdate.mockImplementation(() => ({
      set: () => ({
        where: () => ({
          returning: async () => [{ id: 'session-1' }],
        }),
      }),
    }));

    await stopSessionAtomic({
      session: {
        id: 'session-1',
        mediaType: 'episode',
        startedAt: new Date(Date.now() - 87000),
        lastPausedAt: null,
        pausedDurationMs: 0,
        progressMs: 87000,
        totalDurationMs: 100000,
        watched: false,
      } as Parameters<typeof stopSessionAtomic>[0]['session'],
      stoppedAt: new Date(),
    });

    expect(getWatchedThreshold).toHaveBeenCalledWith('episode');
  });

  it('marks watched using the resolved per-media-type threshold, not the shared default', async () => {
    const { db } = await import('../../../db/client.js');
    const mockUpdate = db.update as ReturnType<typeof vi.fn>;
    mockUpdate.mockImplementation(() => ({
      set: () => ({
        where: () => ({
          returning: async () => [{ id: 'session-1' }],
        }),
      }),
    }));
    (getWatchedThreshold as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0.9);

    // 87% progress: passes the 85% default but not a 90% threshold.
    const result = await stopSessionAtomic({
      session: {
        id: 'session-1',
        mediaType: 'episode',
        startedAt: new Date(Date.now() - 87000),
        lastPausedAt: null,
        pausedDurationMs: 0,
        progressMs: 87000,
        totalDurationMs: 100000,
        watched: false,
      } as Parameters<typeof stopSessionAtomic>[0]['session'],
      stoppedAt: new Date(),
    });

    expect(result.watched).toBe(false);
  });
});
