/**
 * Poll Bookkeeping Tests (Task 13)
 *
 * pollServers recomputes serversNeedingPoll fresh every tick from
 * sseManager.isInFallback. Bugs lived at the top and bottom of that
 * function around that set:
 *  - missedPollTracking entries for servers no longer in serversNeedingPoll
 *    were pruned the same way whether the server moved to SSE coverage or
 *    was deleted from the DB. SSE-reclaimed entries must drop silently (SSE
 *    self-notifies), but deleted-server entries must fire the deferred stop
 *    notification from the retained snapshot, since sessions.server_id is
 *    ON DELETE CASCADE and no other path will ever send it.
 *  - the early return when allServers is empty skipped both the adaptive
 *    interval reset and the prune above it, so deleting the last server
 *    left the 3s cadence running and any grace entries stuck forever.
 *  - the early return when serversNeedingPoll is empty skips the adaptive
 *    interval reset, so a previously-active 3s cadence never settles.
 *  - hasActiveSessions counts cachedSessions from every server, including
 *    ones outside serversNeedingPoll, which also blocks that settle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLLING_INTERVALS, type ActiveSession } from '@tracearr/shared';
import type { CacheService, PubSubService } from '../../../services/cache.js';

const mockDbSelect = vi.fn();
const { mockCreateMediaServerClient, mockGetActiveRulesV2, mockIsInFallback } = vi.hoisted(() => ({
  mockCreateMediaServerClient: vi.fn(),
  mockGetActiveRulesV2: vi.fn().mockResolvedValue([]),
  mockIsInFallback: vi.fn().mockReturnValue(true),
}));

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
  createMediaServerClient: mockCreateMediaServerClient,
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
    isInFallback: (...args: [string]) => mockIsInFallback(...args),
    nudgeReconnect: vi.fn(),
  },
}));

const mockEnqueueNotification = vi.fn();
vi.mock('../../notificationQueue.js', () => ({
  enqueueNotification: (...args: unknown[]) => mockEnqueueNotification(...args),
}));

vi.mock('../database.js', () => ({
  getActiveRulesV2: mockGetActiveRulesV2,
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  widenRecentSessionsForMergedIdentities: vi.fn(),
}));

vi.mock('../pendingConfirmation.js', () => ({
  updatePendingSession: vi.fn(),
}));

const mockProcessPollResults = vi.fn().mockResolvedValue(undefined);
vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  buildActiveSession: vi.fn(),
  buildPendingActiveSession: vi.fn(),
  createSessionWithRulesAtomic: vi.fn(),
  findActiveSession: vi.fn(),
  findActiveSessionByComposite: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  processPollResults: (...args: unknown[]) => mockProcessPollResults(...args),
  reEvaluateRulesOnPauseState: vi.fn(),
  reEvaluateRulesOnTranscodeChange: vi.fn(),
  stopSessionAtomic: vi.fn(),
}));

vi.mock('../violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

vi.mock('../sessionMapper.js', () => ({
  mapMediaSession: vi.fn((raw: unknown) => raw),
  pickStreamDetailFields: vi.fn().mockReturnValue({}),
}));

import { servers, serverUsers, sessions as sessionsTable } from '../../../db/schema.js';
import { findActiveSession, stopSessionAtomic } from '../sessionLifecycle.js';
import {
  gracePeriodSessionIds,
  initializePoller,
  startPoller,
  stopPoller,
  triggerPoll,
  triggerReconciliationPoll,
} from '../processor.js';

const serverRow1 = {
  id: 'server-1',
  name: 'Server 1',
  type: 'plex' as const,
  url: 'http://localhost:32400',
  token: 'token-1',
  createdAt: new Date(),
  updatedAt: new Date(),
};
const serverRow2 = {
  id: 'server-2',
  name: 'Server 2',
  type: 'plex' as const,
  url: 'http://localhost:32401',
  token: 'token-2',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const activeSessionOnServer1 = {
  id: 'active-1-id',
  serverId: 'server-1',
  serverUserId: 'su-1',
  sessionKey: 'session-1',
  deviceId: 'device-1',
  ratingKey: 'rk-1',
  pending: false,
  startedAt: new Date('2026-07-15T00:00:00.000Z'),
  lastPausedAt: null,
  pausedDurationMs: 0,
  progressMs: null,
} as unknown as ActiveSession;
const activeSessionOnServer2 = {
  id: 'active-2-id',
  serverId: 'server-2',
  serverUserId: 'su-2',
  sessionKey: 'session-2',
  deviceId: 'device-2',
  ratingKey: 'rk-2',
  pending: false,
  startedAt: new Date('2026-07-15T00:00:00.000Z'),
  lastPausedAt: null,
  pausedDurationMs: 0,
  progressMs: null,
} as unknown as ActiveSession;

let allServersRows: (typeof serverRow1)[] = [serverRow1];
let currentCachedSessions: ActiveSession[] = [];

mockDbSelect.mockImplementation((_cols?: unknown) => ({
  from: (table: unknown) => {
    if (table === servers) return Promise.resolve(allServersRows);
    if (table === serverUsers) {
      return { innerJoin: () => ({ where: () => Promise.resolve([]) }) };
    }
    if (table === sessionsTable) {
      return { where: () => Promise.resolve([]) };
    }
    return Promise.resolve([]);
  },
}));

function createCacheService() {
  let health: boolean | null = null;
  let failCount = 0;
  return {
    getAllActiveSessions: vi.fn(() => Promise.resolve(currentCachedSessions)),
    getServerHealth: vi.fn(async () => health),
    setServerHealth: vi.fn(async (_id: string, value: boolean) => {
      health = value;
    }),
    resetServerFailCount: vi.fn(async () => {
      failCount = 0;
    }),
    incrServerFailCount: vi.fn(async () => {
      failCount += 1;
      return failCount;
    }),
    getPendingSession: vi.fn().mockResolvedValue(null),
    setPendingSession: vi.fn().mockResolvedValue(undefined),
    deletePendingSession: vi.fn().mockResolvedValue(undefined),
    withSessionCreateLock: vi.fn(),
    removeActiveSession: vi.fn().mockResolvedValue(undefined),
    removeUserSession: vi.fn().mockResolvedValue(undefined),
    hasTerminationCooldown: vi.fn().mockResolvedValue(false),
    hasTerminationCooldownComposite: vi.fn().mockResolvedValue(false),
    addSessionWriteRetry: vi.fn().mockResolvedValue(undefined),
    invalidateDashboardStatsCache: vi.fn().mockResolvedValue(undefined),
  };
}

function createPubSubService() {
  return { publish: vi.fn().mockResolvedValue(undefined) };
}

let cacheService: ReturnType<typeof createCacheService>;
let pubSubService: ReturnType<typeof createPubSubService>;

beforeEach(() => {
  vi.clearAllMocks();
  stopPoller();
  mockGetActiveRulesV2.mockResolvedValue([]);
  mockIsInFallback.mockReturnValue(true);
  allServersRows = [serverRow1];
  currentCachedSessions = [];
  mockCreateMediaServerClient.mockReturnValue({
    getSessions: vi.fn().mockResolvedValue([]),
  });

  cacheService = createCacheService();
  pubSubService = createPubSubService();
  initializePoller(
    cacheService as unknown as CacheService,
    pubSubService as unknown as PubSubService
  );
});

afterEach(() => {
  stopPoller();
});

describe('(a) missedPollTracking pruning for servers no longer polled', () => {
  it('leaves the grace-period entry for reconciliation when its server exits fallback to SSE', async () => {
    allServersRows = [serverRow1];
    currentCachedSessions = [activeSessionOnServer1];
    mockIsInFallback.mockReturnValue(true);

    await triggerPoll();
    expect(gracePeriodSessionIds().has('active-1-id')).toBe(true);

    // server-1 now has an active SSE connection - the main poller no longer
    // polls it, but reconciliation does. The entry must survive so
    // reconciliation can confirm the stop on its next pass; silently dropping
    // it here strands the session in cache with no path left to confirm it.
    mockIsInFallback.mockReturnValue(false);
    await triggerPoll();

    expect(gracePeriodSessionIds().has('active-1-id')).toBe(true);
    expect(mockEnqueueNotification.mock.calls.some(([arg]) => arg.type === 'session_stopped')).toBe(
      false
    );
    expect(cacheService.removeActiveSession).not.toHaveBeenCalled();
    expect(pubSubService.publish).not.toHaveBeenCalledWith('session:stopped', 'active-1-id');
  });

  it('does not prune a reconciliation-created entry before reconciliation can confirm it', async () => {
    // server-1 is SSE-covered (never in fallback): the main poller skips it,
    // reconciliation owns its grace entries.
    allServersRows = [serverRow1];
    currentCachedSessions = [activeSessionOnServer1];
    mockIsInFallback.mockReturnValue(false);

    // Reconciliation detects the first missed poll and records the grace entry.
    await triggerReconciliationPoll();
    expect(gracePeriodSessionIds().has('active-1-id')).toBe(true);

    // A main tick (3-10s) fires between reconciliation passes. It must not
    // prune the entry: reconciliation runs every 30s and needs two passes to
    // confirm, so pruning here makes the confirm step unreachable.
    await triggerPoll();
    expect(gracePeriodSessionIds().has('active-1-id')).toBe(true);
    expect(mockEnqueueNotification.mock.calls.some(([arg]) => arg.type === 'session_stopped')).toBe(
      false
    );
    expect(cacheService.removeActiveSession).not.toHaveBeenCalled();

    // Second reconciliation pass confirms the stop from the surviving entry.
    vi.mocked(findActiveSession).mockResolvedValue({
      id: 'active-1-id',
      sessionKey: 'session-1',
      lastSeenAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof findActiveSession>>);
    vi.mocked(stopSessionAtomic).mockResolvedValue({
      wasUpdated: true,
      durationMs: 1000,
      needsRetry: false,
    } as unknown as Awaited<ReturnType<typeof stopSessionAtomic>>);

    await triggerReconciliationPoll();

    expect(gracePeriodSessionIds().has('active-1-id')).toBe(false);
    const stopNotification = mockEnqueueNotification.mock.calls.find(
      ([arg]) => arg.type === 'session_stopped'
    );
    expect(stopNotification).toBeDefined();
    expect(stopNotification![0].payload.id).toBe('active-1-id');
    expect(cacheService.removeActiveSession).toHaveBeenCalledWith('active-1-id', {
      skipDashboardInvalidation: true,
    });
    expect(pubSubService.publish).toHaveBeenCalledWith('session:stopped', 'active-1-id');
  });

  it('fires the stop notification from the snapshot when its server is removed from the DB', async () => {
    allServersRows = [serverRow1, serverRow2];
    currentCachedSessions = [activeSessionOnServer1, activeSessionOnServer2];
    mockIsInFallback.mockReturnValue(true);

    await triggerPoll();
    expect(gracePeriodSessionIds().has('active-1-id')).toBe(true);
    expect(gracePeriodSessionIds().has('active-2-id')).toBe(true);

    // server-2 deleted; server-1 keeps being polled normally. The row backing
    // active-2-id is gone (cascade delete), so this is the only remaining
    // chance to tell the user that session stopped.
    allServersRows = [serverRow1];
    currentCachedSessions = [activeSessionOnServer1];
    await triggerPoll();

    expect(gracePeriodSessionIds().has('active-2-id')).toBe(false);
    const stopNotification = mockEnqueueNotification.mock.calls.find(
      ([arg]) => arg.type === 'session_stopped'
    );
    expect(stopNotification).toBeDefined();
    expect(stopNotification![0].payload.id).toBe('active-2-id');
    expect(cacheService.removeActiveSession).toHaveBeenCalledWith('active-2-id', {
      skipDashboardInvalidation: true,
    });
    expect(cacheService.invalidateDashboardStatsCache).toHaveBeenCalled();
    expect(pubSubService.publish).toHaveBeenCalledWith('session:stopped', 'active-2-id');
  });
});

describe('(b) adaptive interval reset when serversNeedingPoll is empty', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(global, 'setInterval');
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it('collapses a stuck active interval back to idle once every server moves to SSE coverage', async () => {
    allServersRows = [serverRow1];
    currentCachedSessions = [activeSessionOnServer1];
    mockIsInFallback.mockReturnValue(true);

    startPoller();
    await vi.waitFor(() =>
      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        POLLING_INTERVALS.SESSIONS_ACTIVE
      )
    );

    setIntervalSpy.mockClear();
    mockIsInFallback.mockReturnValue(false);

    await triggerPoll();

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      POLLING_INTERVALS.SESSIONS_IDLE
    );
  });
});

describe('(c) hasActiveSessions only counts sessions on servers actually being polled', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(global, 'setInterval');
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it('settles back to idle when the only cached sessions left belong to an SSE-covered server', async () => {
    allServersRows = [serverRow1];
    currentCachedSessions = [activeSessionOnServer1];
    mockIsInFallback.mockReturnValue(true);

    startPoller();
    await vi.waitFor(() =>
      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        POLLING_INTERVALS.SESSIONS_ACTIVE
      )
    );

    // server-1 (still being polled) is now idle. server-2's session is only
    // in cache because SSE is tracking it - server-2 isn't in serversNeedingPoll.
    allServersRows = [serverRow1, serverRow2];
    currentCachedSessions = [activeSessionOnServer2];
    mockIsInFallback.mockImplementation((id: string) => id === 'server-1');

    setIntervalSpy.mockClear();
    await triggerPoll();

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      POLLING_INTERVALS.SESSIONS_IDLE
    );
  });
});

describe('(d) allServers empty (last server deleted)', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(global, 'setInterval');
  });

  afterEach(() => {
    setIntervalSpy.mockRestore();
  });

  it('resets cadence to idle and fires the stop notification when the last server is deleted', async () => {
    allServersRows = [serverRow1];
    currentCachedSessions = [activeSessionOnServer1];
    mockIsInFallback.mockReturnValue(true);

    startPoller();
    await vi.waitFor(() =>
      expect(setIntervalSpy).toHaveBeenCalledWith(
        expect.any(Function),
        POLLING_INTERVALS.SESSIONS_ACTIVE
      )
    );
    expect(gracePeriodSessionIds().has('active-1-id')).toBe(true);

    // Last server deleted: allServers comes back empty. The stale Redis
    // entry for its session is still in cache (deleting a server doesn't
    // clean that up), and the grace-period snapshot is the only place left
    // that knows this session ever existed.
    setIntervalSpy.mockClear();
    allServersRows = [];

    await triggerPoll();

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      POLLING_INTERVALS.SESSIONS_IDLE
    );
    expect(gracePeriodSessionIds().has('active-1-id')).toBe(false);
    const stopNotification = mockEnqueueNotification.mock.calls.find(
      ([arg]) => arg.type === 'session_stopped'
    );
    expect(stopNotification).toBeDefined();
    expect(stopNotification![0].payload.id).toBe('active-1-id');
    expect(cacheService.removeActiveSession).toHaveBeenCalledWith('active-1-id', {
      skipDashboardInvalidation: true,
    });
    expect(cacheService.invalidateDashboardStatsCache).toHaveBeenCalled();
    expect(pubSubService.publish).toHaveBeenCalledWith('session:stopped', 'active-1-id');
  });
});
