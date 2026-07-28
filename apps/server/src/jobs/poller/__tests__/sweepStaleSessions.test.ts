/**
 * sweepStaleSessions notification tests.
 *
 * The stale sweep force-stops sessions the poller lost track of (no poll saw
 * them in 5+ minutes) and always published `session:stopped` over pubsub, but
 * never enqueued the user-facing stop notification the grace-period sweep
 * sends via `sendGracePeriodStopNotification`. These tests pin that gap and
 * the stoppedAt/durationMs consistency between the DB write and the payload.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDbSelect = vi.fn();
const mockStopSessionAtomic = vi.fn();
const mockEnqueueNotification = vi.fn();

vi.mock('../../../db/client.js', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}));

vi.mock('../../../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

vi.mock('../../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));

vi.mock('../../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../services/mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

vi.mock('../../../services/plexGeoip.js', () => ({
  lookupGeoIP: vi.fn().mockResolvedValue({ city: null, country: null }),
}));

vi.mock('../../../services/serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));

vi.mock('../../../services/sseManager.js', () => ({
  sseManager: {
    isInFallback: vi.fn().mockReturnValue(false),
    nudgeReconnect: vi.fn(),
  },
}));

vi.mock('../../notificationQueue.js', () => ({
  enqueueNotification: (...args: unknown[]) => mockEnqueueNotification(...args),
}));

vi.mock('../database.js', () => ({
  getActiveRulesV2: vi.fn().mockResolvedValue([]),
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  widenRecentSessionsForMergedIdentities: vi.fn(),
}));

vi.mock('../pendingConfirmation.js', () => ({
  updatePendingSession: vi.fn(),
}));

vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  buildActiveSession: vi.fn(),
  buildPendingActiveSession: vi.fn(),
  createSessionWithRulesAtomic: vi.fn(),
  findActiveSession: vi.fn(),
  findActiveSessionByComposite: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: vi.fn(),
  processPollResults: vi.fn().mockResolvedValue(undefined),
  reEvaluateRulesOnPauseState: vi.fn(),
  reEvaluateRulesOnTranscodeChange: vi.fn(),
  stopSessionAtomic: (...args: unknown[]) => mockStopSessionAtomic(...args),
}));

vi.mock('../violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

import { initializePoller, sweepStaleSessions } from '../processor.js';

const staleSessionRow = {
  id: 'session-1',
  serverId: 'server-1',
  serverUserId: 'server-user-1',
  sessionKey: 'key-1',
  plexSessionId: 'plex-sess-1',
  lastSeenAt: new Date(Date.now() - 10 * 60 * 1000),
  startedAt: new Date(Date.now() - 20 * 60 * 1000),
  stoppedAt: null,
};

const serverRow = { id: 'server-1', name: 'Server One', type: 'plex' as const };
const serverUserRow = {
  id: 'server-user-1',
  username: 'alice',
  thumbUrl: null,
  identityName: 'Alice Identity',
};

/** Mock db.select() call chain in the order sweepStaleSessions issues its 3 queries. */
function mockDbSequence(staleRows: unknown[], serverRows: unknown[], serverUserRows: unknown[]) {
  mockDbSelect
    .mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve(staleRows) }) })
    .mockReturnValueOnce({ from: () => ({ where: () => Promise.resolve(serverRows) }) })
    .mockReturnValueOnce({
      from: () => ({ innerJoin: () => ({ where: () => Promise.resolve(serverUserRows) }) }),
    });
}

describe('sweepStaleSessions notifications', () => {
  const cacheService = {
    removeActiveSession: vi.fn(),
    addSessionWriteRetry: vi.fn(),
    invalidateDashboardStatsCache: vi.fn(),
  };
  const pubSubService = { publish: vi.fn() };

  beforeEach(() => {
    vi.resetAllMocks();
    initializePoller(cacheService as never, pubSubService as never);
  });

  it('enqueues a session_stopped notification with the same stoppedAt used in the DB write', async () => {
    mockDbSequence([staleSessionRow], [serverRow], [serverUserRow]);
    mockStopSessionAtomic.mockResolvedValue({
      durationMs: 456000,
      watched: true,
      shortSession: false,
      wasUpdated: true,
    });

    await sweepStaleSessions();

    expect(mockStopSessionAtomic).toHaveBeenCalledTimes(1);
    const stopCallArgs = mockStopSessionAtomic.mock.calls[0]?.[0] as { stoppedAt: Date };

    expect(mockEnqueueNotification).toHaveBeenCalledTimes(1);
    const [notification] = mockEnqueueNotification.mock.calls[0] as [
      { type: string; payload: Record<string, unknown> },
    ];

    expect(notification.type).toBe('session_stopped');
    expect(notification.payload.id).toBe('session-1');
    expect(notification.payload.durationMs).toBe(456000);
    expect(notification.payload.stoppedAt).toEqual(stopCallArgs.stoppedAt);
    expect(notification.payload.user).toEqual(serverUserRow);
    expect(notification.payload.server).toEqual(serverRow);
  });

  it('does not enqueue a notification when the session was already stopped by another process', async () => {
    mockDbSequence([staleSessionRow], [serverRow], [serverUserRow]);
    mockStopSessionAtomic.mockResolvedValue({
      durationMs: null,
      watched: false,
      shortSession: false,
      wasUpdated: false,
    });

    await sweepStaleSessions();

    expect(mockEnqueueNotification).not.toHaveBeenCalled();
  });

  it('removes the cache entry without invalidating per-session, then invalidates dashboard stats once', async () => {
    mockDbSequence([staleSessionRow], [serverRow], [serverUserRow]);
    mockStopSessionAtomic.mockResolvedValue({
      durationMs: 456000,
      watched: true,
      shortSession: false,
      wasUpdated: true,
    });

    await sweepStaleSessions();

    expect(cacheService.removeActiveSession).toHaveBeenCalledWith('session-1', {
      skipDashboardInvalidation: true,
    });
    expect(cacheService.invalidateDashboardStatsCache).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate dashboard stats when no session was actually force-stopped', async () => {
    mockDbSequence([staleSessionRow], [serverRow], [serverUserRow]);
    mockStopSessionAtomic.mockResolvedValue({
      durationMs: null,
      watched: false,
      shortSession: false,
      wasUpdated: false,
    });

    await sweepStaleSessions();

    expect(cacheService.removeActiveSession).not.toHaveBeenCalled();
    expect(cacheService.invalidateDashboardStatsCache).not.toHaveBeenCalled();
  });
});
