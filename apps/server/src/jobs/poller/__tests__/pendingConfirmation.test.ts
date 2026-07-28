import { describe, expect, it } from 'vitest';
import type { PendingSessionData } from '../types.js';
import { calculatePendingPauseAccumulation, updatePendingSession } from '../pendingConfirmation.js';

describe('calculatePendingPauseAccumulation', () => {
  const now = 1710600000000;

  it('accumulates pause duration on pause→play', () => {
    const result = calculatePendingPauseAccumulation({
      previousState: 'paused',
      newState: 'playing',
      pausedDurationMs: 5000,
      lastPausedAt: now - 10000,
      now,
    });
    expect(result.pausedDurationMs).toBe(15000);
    expect(result.lastPausedAt).toBeNull();
  });

  it('sets lastPausedAt on play→pause', () => {
    const result = calculatePendingPauseAccumulation({
      previousState: 'playing',
      newState: 'paused',
      pausedDurationMs: 0,
      lastPausedAt: null,
      now,
    });
    expect(result.pausedDurationMs).toBe(0);
    expect(result.lastPausedAt).toBe(now);
  });

  it('no change when state stays the same', () => {
    const result = calculatePendingPauseAccumulation({
      previousState: 'playing',
      newState: 'playing',
      pausedDurationMs: 3000,
      lastPausedAt: null,
      now,
    });
    expect(result.pausedDurationMs).toBe(3000);
    expect(result.lastPausedAt).toBeNull();
  });

  it('handles null lastPausedAt on pause→play gracefully', () => {
    const result = calculatePendingPauseAccumulation({
      previousState: 'paused',
      newState: 'playing',
      pausedDurationMs: 1000,
      lastPausedAt: null,
      now,
    });
    expect(result.pausedDurationMs).toBe(1000);
    expect(result.lastPausedAt).toBeNull();
  });
});

describe('updatePendingSession', () => {
  const basePending: PendingSessionData = {
    id: 'test-uuid',
    confirmation: {
      confirmedPlayback: false,
      firstSeenAt: 1710600000000,
      maxViewOffset: 0,
      initialViewOffset: null,
    },
    processed: {} as any,
    server: { id: 'srv-1', name: 'Test', type: 'jellyfin' },
    serverUser: { id: 'user-1', username: 'test' } as any,
    geo: {} as any,
    currentState: 'playing',
    startedAt: 1710600000000,
    pausedDurationMs: 0,
    lastPausedAt: null,
    lastSeenAt: 1710600000000,
  };

  it('returns not confirmed when under 30s', () => {
    const { isConfirmed } = updatePendingSession(
      basePending,
      'playing',
      15000,
      basePending.startedAt + 15000
    );
    expect(isConfirmed).toBe(false);
  });

  it('updates lastSeenAt on each call', () => {
    const now = basePending.startedAt + 5000;
    const { updatedData } = updatePendingSession(basePending, 'playing', 5000, now);
    expect(updatedData.lastSeenAt).toBe(now);
  });

  it('tracks pause accumulation across updates', () => {
    // First: play → pause
    const { updatedData: paused } = updatePendingSession(
      basePending,
      'paused',
      10000,
      basePending.startedAt + 10000
    );
    expect(paused.lastPausedAt).toBe(basePending.startedAt + 10000);

    // Second: pause → play (5s later)
    const { updatedData: resumed } = updatePendingSession(
      paused,
      'playing',
      10000,
      basePending.startedAt + 15000
    );
    expect(resumed.pausedDurationMs).toBe(5000);
    expect(resumed.lastPausedAt).toBeNull();
  });
});
