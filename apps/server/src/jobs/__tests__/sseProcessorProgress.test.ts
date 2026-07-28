/**
 * SSE Processor Tests - Progress Event DB Write Throttling
 *
 * Tests that handleProgress coalesces the DB write for progress/lastSeenAt
 * while the Redis active-session cache still updates on every event,
 * and that a watched-completion transition still persists immediately.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';

const {
  mockSseManager,
  mockEnqueueNotification,
  mockFindActiveSession,
  mockCheckWatchCompletion,
  mockDb,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events');
  return {
    mockSseManager: new EE() as EventEmitter,
    mockEnqueueNotification: vi.fn().mockResolvedValue('job-id'),
    mockFindActiveSession: vi.fn(),
    mockCheckWatchCompletion: vi.fn().mockReturnValue(false),
    mockDb: {
      select: vi.fn(),
      update: vi.fn(),
    },
  };
});

vi.mock('../../services/sseManager.js', () => ({
  sseManager: mockSseManager,
}));

vi.mock('../notificationQueue.js', () => ({
  enqueueNotification: mockEnqueueNotification,
}));

vi.mock('../../db/client.js', () => ({
  db: mockDb,
}));

vi.mock('../../services/mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

vi.mock('../../services/plexGeoip.js', () => ({
  lookupGeoIP: vi.fn().mockResolvedValue({ city: null, country: null }),
}));

vi.mock('../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));

vi.mock('../../services/geoip.js', () => ({
  geoipService: { lookup: vi.fn() },
}));

vi.mock('../poller/index.js', () => ({
  triggerReconciliationPoll: vi.fn(),
}));

vi.mock('../poller/sessionMapper.js', () => ({
  mapMediaSession: vi.fn((session: unknown) => session),
}));

vi.mock('../poller/stateTracker.js', () => ({
  calculatePauseAccumulation: vi.fn(),
  checkWatchCompletion: mockCheckWatchCompletion,
  detectMediaChange: vi.fn().mockReturnValue(false),
  isPlaybackConfirmed: vi.fn().mockReturnValue(false),
  createInitialConfirmationState: vi.fn().mockReturnValue({
    confirmedPlayback: false,
    firstSeenAt: Date.now(),
    maxViewOffset: 0,
  }),
  updateConfirmationState: vi.fn().mockImplementation((state) => state),
}));

vi.mock('../poller/database.js', () => ({
  getActiveRulesV2: vi.fn().mockResolvedValue([]),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  mergeRecentSessionsForIdentity: (map: Map<string, unknown[]>, ids: string[]) =>
    ids.flatMap((id) => map.get(id) ?? []),
}));

vi.mock('../poller/violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

vi.mock('../poller/sessionLifecycle.js', () => ({
  stopSessionAtomic: vi.fn(),
  findActiveSession: mockFindActiveSession,
  findActiveSessionsAll: vi.fn().mockResolvedValue([]),
  buildActiveSession: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: vi.fn(),
  reEvaluateRulesOnTranscodeChange: vi.fn(),
  confirmAndPersistSession: vi.fn(),
}));

vi.mock('../../services/serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));

import { initializeSSEProcessor, startSSEProcessor, stopSSEProcessor } from '../sseProcessor.js';
import { resetDbWriteThrottle } from '../poller/dbWriteThrottle.js';

const SERVER_ID = 'server-1';

const mockExistingSession = {
  id: 'session-progress-1',
  serverId: SERVER_ID,
  serverUserId: 'server-user-1',
  sessionKey: 'sess-key-1',
  ratingKey: '1001',
  state: 'playing' as const,
  startedAt: new Date(Date.now() - 60_000),
  lastPausedAt: null,
  pausedDurationMs: 0,
  watched: false,
  totalDurationMs: 3_600_000,
};

const mockCacheService = {
  getAllActiveSessions: vi.fn().mockResolvedValue([]),
  getSessionById: vi.fn(),
  addActiveSession: vi.fn(),
  updateActiveSession: vi.fn(),
  removeActiveSession: vi.fn(),
  addUserSession: vi.fn(),
  removeUserSession: vi.fn(),
  withSessionCreateLock: vi.fn(),
  hasTerminationCooldown: vi.fn().mockResolvedValue(false),
  setTerminationCooldown: vi.fn(),
  hasTerminationCooldownComposite: vi.fn().mockResolvedValue(false),
  setTerminationCooldownComposite: vi.fn(),
  getPendingSession: vi.fn().mockResolvedValue(null),
  setPendingSession: vi.fn(),
  deletePendingSession: vi.fn(),
  getAllPendingSessionKeys: vi.fn().mockResolvedValue([]),
};

const mockPubSubService = {
  publish: vi.fn(),
  subscribe: vi.fn(),
};

function setupDbUpdateMock(returning: unknown[] = [{ id: mockExistingSession.id }]) {
  const returningFn = vi.fn().mockResolvedValue(returning);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.update.mockReturnValue({ set: setFn });
  return setFn;
}

async function emitProgress(viewOffset: number): Promise<void> {
  const callsBefore = mockCacheService.updateActiveSession.mock.calls.length;
  mockSseManager.emit('plex:session:progress', {
    serverId: SERVER_ID,
    notification: { sessionKey: mockExistingSession.sessionKey, viewOffset },
  });
  // handleProgress is fire-and-forget from the event emitter; wait for THIS
  // event's Redis update rather than any past call already recorded.
  await vi.waitFor(() => {
    expect(mockCacheService.updateActiveSession.mock.calls.length).toBeGreaterThan(callsBefore);
  });
}

describe('SSE Processor - Progress Event DB Write Throttling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSseManager.removeAllListeners();
    resetDbWriteThrottle();

    mockFindActiveSession.mockResolvedValue(mockExistingSession);
    mockCheckWatchCompletion.mockReturnValue(false);
    mockCacheService.getSessionById.mockResolvedValue({
      id: mockExistingSession.id,
      progressMs: 0,
      watched: false,
    });
    setupDbUpdateMock();

    initializeSSEProcessor(mockCacheService as never, mockPubSubService as never);
    startSSEProcessor();
  });

  afterEach(() => {
    stopSSEProcessor();
  });

  it('coalesces DB writes across a burst of progress events while Redis updates every time', async () => {
    const eventCount = 5;
    for (let i = 0; i < eventCount; i++) {
      await emitProgress(10_000 + i * 1000);
    }

    // First event flushes (no prior write recorded); the rest land inside
    // the same throttle window and skip the DB write.
    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockCacheService.updateActiveSession).toHaveBeenCalledTimes(eventCount);
  });

  it('persists a watched transition immediately even mid-throttle-window', async () => {
    await emitProgress(10_000);
    expect(mockDb.update).toHaveBeenCalledTimes(1);

    // Next event crosses the watched-completion threshold - must flush
    // despite the throttle window not having elapsed.
    mockCheckWatchCompletion.mockReturnValueOnce(true);
    await emitProgress(11_000);

    expect(mockDb.update).toHaveBeenCalledTimes(2);
    expect(mockPubSubService.publish).toHaveBeenCalledWith(
      'session:updated',
      expect.objectContaining({ watched: true })
    );
  });

  it('does not resurrect the session in cache when a stop races the progress write', async () => {
    // Simulate an SSE stop landing between the batch read and this write:
    // the update's liveness guard matches zero rows.
    setupDbUpdateMock([]);

    mockSseManager.emit('plex:session:progress', {
      serverId: SERVER_ID,
      notification: { sessionKey: mockExistingSession.sessionKey, viewOffset: 10_000 },
    });
    await vi.waitFor(() => {
      expect(mockDb.update).toHaveBeenCalledTimes(1);
    });
    // Give the update's zero-row branch a chance to run before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockCacheService.updateActiveSession).not.toHaveBeenCalled();
  });
});
