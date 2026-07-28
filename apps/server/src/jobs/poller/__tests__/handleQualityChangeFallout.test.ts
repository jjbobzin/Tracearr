/**
 * handleQualityChangeFallout Tests (Task 14)
 *
 * The shared cleanup for a quality-change twin: clear its DB-write throttle
 * entry, remove it from the active-session cache, publish its stop. Every
 * caller (resolvePendingSession, the direct-create path, the stale-recovery
 * path) delegates here instead of repeating the triad inline.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDbWriteTracking, recordDbWrite, shouldFlushDbWrite } from '../dbWriteThrottle.js';
import { handleQualityChangeFallout } from '../sessionLifecycle.js';
import type { QualityChangeResult } from '../types.js';

function createQualityChange(stoppedSessionId: string): QualityChangeResult {
  return {
    stoppedSession: {
      id: stoppedSessionId,
      serverUserId: 'user-1',
      sessionKey: 'old-key',
      deviceId: 'device-1',
      ratingKey: 'rk-1',
    },
    referenceId: stoppedSessionId,
  };
}

describe('handleQualityChangeFallout', () => {
  afterEach(() => {
    clearDbWriteTracking('twin-session-1');
    clearDbWriteTracking('twin-session-2');
  });

  it('clears throttle tracking, removes the twin from cache, and publishes its stop', async () => {
    const twinId = 'twin-session-1';
    recordDbWrite(twinId, Date.now());
    expect(shouldFlushDbWrite(twinId, Date.now())).toBe(false);

    const removeActiveSession = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn().mockResolvedValue(undefined);

    await handleQualityChangeFallout(
      createQualityChange(twinId),
      { removeActiveSession },
      { publish }
    );

    expect(shouldFlushDbWrite(twinId, Date.now())).toBe(true);
    expect(removeActiveSession).toHaveBeenCalledWith(twinId);
    expect(publish).toHaveBeenCalledWith('session:stopped', twinId);
  });

  it('skips cache removal and publish when the services are unavailable', async () => {
    const twinId = 'twin-session-2';
    recordDbWrite(twinId, Date.now());

    await expect(
      handleQualityChangeFallout(createQualityChange(twinId), null, null)
    ).resolves.toBeUndefined();

    expect(shouldFlushDbWrite(twinId, Date.now())).toBe(true);
  });
});
