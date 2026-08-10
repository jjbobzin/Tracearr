/**
 * Pending session confirmation for the poller path. SSE runs its own
 * inline confirmation logic in sseProcessor.ts; both create pending entries
 * with the same PendingSessionData shape, but the poller uses these helpers
 * to advance/confirm them while SSE does not import this module.
 */

import type { SessionState } from '@tracearr/shared';
import { isPlaybackConfirmed, updateConfirmationState } from './stateTracker.js';
import type { PendingSessionData } from './types.js';

/** Pause accumulation using epoch numbers (pending sessions are JSON-serialized in Redis). */
export function calculatePendingPauseAccumulation(input: {
  previousState: string;
  newState: string;
  pausedDurationMs: number;
  lastPausedAt: number | null;
  now: number;
}): { pausedDurationMs: number; lastPausedAt: number | null } {
  let { pausedDurationMs, lastPausedAt } = input;

  if (input.previousState === 'paused' && input.newState === 'playing') {
    if (lastPausedAt) {
      pausedDurationMs += input.now - lastPausedAt;
    }
    lastPausedAt = null;
  } else if (input.previousState === 'playing' && input.newState === 'paused') {
    lastPausedAt = input.now;
  }

  return { pausedDurationMs, lastPausedAt };
}

/** Update pending session with new data and check if it's ready to persist. */
export function updatePendingSession(
  pendingData: PendingSessionData,
  newState: string,
  viewOffset: number | undefined,
  now: number
): { updatedData: PendingSessionData; isConfirmed: boolean } {
  const previousState = pendingData.currentState ?? 'playing';

  const { pausedDurationMs, lastPausedAt } = calculatePendingPauseAccumulation({
    previousState,
    newState,
    pausedDurationMs: pendingData.pausedDurationMs,
    lastPausedAt: pendingData.lastPausedAt,
    now,
  });

  const currentViewOffset = viewOffset ?? pendingData.confirmation.maxViewOffset;
  const updatedConfirmation = updateConfirmationState(pendingData.confirmation, currentViewOffset);
  const confirmed = isPlaybackConfirmed(updatedConfirmation, currentViewOffset, newState, now);

  const updatedData: PendingSessionData = {
    ...pendingData,
    confirmation: confirmed
      ? { ...updatedConfirmation, confirmedPlayback: true }
      : updatedConfirmation,
    currentState: newState as SessionState,
    pausedDurationMs,
    lastPausedAt,
    lastSeenAt: now,
  };

  return { updatedData, isConfirmed: confirmed };
}
