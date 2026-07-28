/**
 * Poller Pending-Session Reconciliation Tests
 *
 * Tests for the isNew branch's pending-session check:
 * - Confirms a pending session with its preGeneratedId instead of duplicating it
 * - Leaves the session pending when still below the confirmation threshold
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PendingSessionData } from '../types.js';

const {
  mockSseManager,
  mockEnqueueNotification,
  mockCreateMediaServerClient,
  mockMapMediaSession,
  mockUpdatePendingSession,
  mockCreateSessionWithRulesAtomic,
  mockBuildActiveSession,
  mockFindActiveSession,
  mockProcessPollResults,
  mockHandleQualityChangeFallout,
  mockDb,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events');

  /** Thenable query-chain stub: chained calls return itself, awaiting resolves to `result`. */
  function chainResolving(result: unknown[]) {
    const obj: Record<string, unknown> = {};
    obj.where = () => obj;
    obj.innerJoin = () => obj;
    obj.limit = () => obj;
    obj.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject);
    obj.catch = (reject: (e: unknown) => void) => Promise.resolve(result).catch(reject);
    return obj;
  }

  const mockServerRow = {
    id: 'server-1',
    name: 'Test Server',
    type: 'plex',
    url: 'http://localhost:32400',
    token: 'test-token',
  };

  const mockServerUserRow = {
    id: 'server-user-1',
    userId: 'identity-1',
    serverId: 'server-1',
    externalId: 'user-123',
    username: 'alice',
    email: null,
    thumbUrl: null,
    isServerAdmin: false,
    trustScore: 100,
    sessionCount: 5,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    identityName: 'Alice',
  };

  return {
    mockSseManager: Object.assign(new EventEmitter(), {
      isInFallback: vi.fn().mockReturnValue(false),
      nudgeReconnect: vi.fn(),
    }),
    mockEnqueueNotification: vi.fn().mockResolvedValue('job-id'),
    mockCreateMediaServerClient: vi.fn().mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([{}]),
    }),
    mockMapMediaSession: vi.fn(),
    mockUpdatePendingSession: vi.fn(),
    mockCreateSessionWithRulesAtomic: vi.fn(),
    mockBuildActiveSession: vi.fn(),
    mockFindActiveSession: vi.fn().mockResolvedValue(null),
    mockProcessPollResults: vi.fn().mockResolvedValue(undefined),
    mockHandleQualityChangeFallout: vi.fn().mockResolvedValue(undefined),
    mockDb: {
      // Server lookup calls select() with no column argument. The server-user
      // join query and the plex duplicate-content check both pass columns, so
      // they're told apart by whether innerJoin() is used (only the former does).
      select: vi.fn((columns?: unknown) => ({
        from: vi.fn(() => {
          if (columns === undefined) return chainResolving([mockServerRow]);
          const obj: Record<string, unknown> = { where: () => obj, limit: () => obj };
          obj.innerJoin = () => chainResolving([mockServerUserRow]);
          obj.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
            Promise.resolve([]).then(resolve, reject);
          return obj;
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
      })),
    },
  };
});

vi.mock('../../../db/client.js', () => ({ db: mockDb }));
vi.mock('../../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));
vi.mock('../../../serverState.js', () => ({ isMaintenance: vi.fn().mockReturnValue(false) }));
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
vi.mock('../../../services/sseManager.js', () => ({ sseManager: mockSseManager }));
vi.mock('../../notificationQueue.js', () => ({ enqueueNotification: mockEnqueueNotification }));
vi.mock('../database.js', () => ({
  getActiveRulesV2: vi.fn().mockResolvedValue([]),
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  widenRecentSessionsForMergedIdentities: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../pendingConfirmation.js', () => ({ updatePendingSession: mockUpdatePendingSession }));
vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  buildActiveSession: mockBuildActiveSession,
  buildPendingActiveSession: vi.fn(),
  createSessionWithRulesAtomic: mockCreateSessionWithRulesAtomic,
  findActiveSession: mockFindActiveSession,
  findActiveSessionByComposite: vi.fn().mockResolvedValue(null),
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: mockHandleQualityChangeFallout,
  processPollResults: mockProcessPollResults,
  reEvaluateRulesOnPauseState: vi.fn(),
  reEvaluateRulesOnTranscodeChange: vi.fn(),
  stopSessionAtomic: vi.fn(),
}));
vi.mock('../sessionMapper.js', () => ({
  mapMediaSession: mockMapMediaSession,
  pickStreamDetailFields: vi.fn().mockImplementation((s: unknown) => s),
}));
vi.mock('../violations.js', () => ({ broadcastViolations: vi.fn() }));

import { initializePoller, triggerServerPoll } from '../processor.js';

function createPendingSessionData(): PendingSessionData {
  const now = Date.now();
  return {
    id: 'pending-uuid-123',
    confirmation: {
      confirmedPlayback: false,
      firstSeenAt: now - 31000,
      maxViewOffset: 31000,
      initialViewOffset: 1000,
    },
    processed: {
      sessionKey: 'test-session-key',
      ratingKey: '12345',
      externalUserId: 'user-123',
      username: 'alice',
      state: 'playing',
    } as PendingSessionData['processed'],
    server: { id: 'server-1', name: 'Test Server', type: 'plex' },
    serverUser: {
      id: 'server-user-1',
      userId: 'identity-1',
      username: 'alice',
      thumbUrl: null,
      identityName: 'Alice',
      trustScore: 100,
      sessionCount: 5,
      lastActivityAt: new Date(),
      createdAt: new Date(),
      identityServerUserIds: ['server-user-1'],
    },
    geo: {
      city: null,
      region: null,
      country: null,
      countryCode: null,
      continent: null,
      postal: null,
      lat: null,
      lon: null,
      asnNumber: null,
      asnOrganization: null,
    },
    startedAt: now - 31000,
    lastSeenAt: now,
    currentState: 'playing',
    pausedDurationMs: 0,
    lastPausedAt: null,
  };
}

describe('poller isNew branch defers to a pending session', () => {
  let cacheService: {
    getAllActiveSessions: ReturnType<typeof vi.fn>;
    getPendingSession: ReturnType<typeof vi.fn>;
    deletePendingSession: ReturnType<typeof vi.fn>;
    setPendingSession: ReturnType<typeof vi.fn>;
    withSessionCreateLock: ReturnType<typeof vi.fn>;
    hasTerminationCooldown: ReturnType<typeof vi.fn>;
    hasTerminationCooldownComposite: ReturnType<typeof vi.fn>;
    addActiveSession: ReturnType<typeof vi.fn>;
    addUserSession: ReturnType<typeof vi.fn>;
    removeActiveSession: ReturnType<typeof vi.fn>;
    removeUserSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockMapMediaSession.mockReturnValue({
      sessionKey: 'test-session-key',
      ratingKey: '12345',
      externalUserId: 'user-123',
      username: 'alice',
      userThumb: '',
      mediaTitle: 'Test Movie',
      mediaType: 'movie',
      state: 'playing',
      ipAddress: '1.2.3.4',
      deviceId: 'device-1',
    });

    cacheService = {
      getAllActiveSessions: vi.fn().mockResolvedValue([]),
      getPendingSession: vi
        .fn()
        .mockImplementation(async (_serverId: string, key: string) =>
          key === 'test-session-key' ? createPendingSessionData() : null
        ),
      deletePendingSession: vi.fn(),
      setPendingSession: vi.fn(),
      withSessionCreateLock: vi.fn().mockImplementation(async (_s, _k, op) => op()),
      hasTerminationCooldown: vi.fn().mockResolvedValue(false),
      hasTerminationCooldownComposite: vi.fn().mockResolvedValue(false),
      addActiveSession: vi.fn(),
      addUserSession: vi.fn(),
      removeActiveSession: vi.fn(),
      removeUserSession: vi.fn(),
    };

    initializePoller(
      cacheService as unknown as Parameters<typeof initializePoller>[0],
      { publish: vi.fn(), subscribe: vi.fn() } as unknown as Parameters<typeof initializePoller>[1]
    );
  });

  it('confirms the pending session with preGeneratedId instead of creating a duplicate', async () => {
    mockUpdatePendingSession.mockReturnValue({
      updatedData: createPendingSessionData(),
      isConfirmed: true,
    });

    mockCreateSessionWithRulesAtomic.mockResolvedValue({
      insertedSession: { id: 'pending-uuid-123', sessionKey: 'test-session-key' },
      violationResults: [],
      qualityChange: null,
      referenceId: null,
      wasTerminatedByRule: false,
    });

    mockBuildActiveSession.mockReturnValue({
      id: 'pending-uuid-123',
      serverId: 'server-1',
      sessionKey: 'test-session-key',
    });

    await triggerServerPoll('server-1');

    expect(mockCreateSessionWithRulesAtomic).toHaveBeenCalledTimes(1);
    expect(mockCreateSessionWithRulesAtomic).toHaveBeenCalledWith(
      expect.objectContaining({ preGeneratedId: 'pending-uuid-123' })
    );

    expect(cacheService.deletePendingSession).toHaveBeenCalledWith('server-1', 'test-session-key');

    expect(mockProcessPollResults).toHaveBeenCalledTimes(1);
    const call = mockProcessPollResults.mock.calls[0]?.[0];
    expect(call.newSessions).toHaveLength(1);
    expect(call.newSessions[0].id).toBe('pending-uuid-123');
  });

  it('runs quality-change fallout for the stopped twin when confirming a pending session', async () => {
    mockUpdatePendingSession.mockReturnValue({
      updatedData: createPendingSessionData(),
      isConfirmed: true,
    });

    const qualityChange = {
      stoppedSession: {
        id: 'twin-session-id',
        serverUserId: 'server-user-1',
        sessionKey: 'twin-session-key',
        deviceId: 'device-1',
        ratingKey: '12345',
      },
      referenceId: 'twin-session-id',
    };

    mockCreateSessionWithRulesAtomic.mockResolvedValue({
      insertedSession: { id: 'pending-uuid-123', sessionKey: 'test-session-key' },
      violationResults: [],
      qualityChange,
      referenceId: 'twin-session-id',
      wasTerminatedByRule: false,
    });

    mockBuildActiveSession.mockReturnValue({
      id: 'pending-uuid-123',
      serverId: 'server-1',
      sessionKey: 'test-session-key',
    });

    await triggerServerPoll('server-1');

    expect(mockHandleQualityChangeFallout).toHaveBeenCalledWith(
      qualityChange,
      cacheService,
      expect.objectContaining({ publish: expect.any(Function) })
    );
  });

  it('keeps the session pending and does not create anything when still below threshold', async () => {
    mockUpdatePendingSession.mockReturnValue({
      updatedData: createPendingSessionData(),
      isConfirmed: false,
    });

    await triggerServerPoll('server-1');

    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
    expect(cacheService.setPendingSession).toHaveBeenCalledTimes(1);
    expect(cacheService.deletePendingSession).not.toHaveBeenCalled();
  });

  it('bails out of the fallback create path when a pending session appears inside the lock', async () => {
    // Pre-check (outside the lock) sees nothing; the check re-run as the first
    // statement inside the lock finds a pending session SSE created in the gap.
    let getPendingSessionCalls = 0;
    cacheService.getPendingSession = vi.fn(async (_serverId: string, key: string) => {
      if (key !== 'test-session-key') return null;
      getPendingSessionCalls++;
      return getPendingSessionCalls === 1 ? null : createPendingSessionData();
    });

    await triggerServerPoll('server-1');

    expect(getPendingSessionCalls).toBeGreaterThanOrEqual(2);
    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
    expect(mockProcessPollResults).not.toHaveBeenCalled();
  });

  it("bails out cleanly when the pending session is confirmed by another process inside resolvePendingSession's own lock", async () => {
    // First read (before the lock) sees the pending session and confirms it.
    // SSE fully confirms and creates the same session in the gap before the
    // lock is acquired, so the re-check inside the lock finds it gone.
    mockUpdatePendingSession.mockReturnValue({
      updatedData: createPendingSessionData(),
      isConfirmed: true,
    });

    let getPendingSessionCalls = 0;
    cacheService.getPendingSession = vi.fn(async (_serverId: string, key: string) => {
      if (key !== 'test-session-key') return null;
      getPendingSessionCalls++;
      return getPendingSessionCalls === 1 ? createPendingSessionData() : null;
    });

    await expect(triggerServerPoll('server-1')).resolves.not.toThrow();

    expect(getPendingSessionCalls).toBeGreaterThanOrEqual(2);
    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
    expect(cacheService.deletePendingSession).not.toHaveBeenCalled();
    // Nothing new/updated/stopped for this session this tick, so processPollResults
    // is skipped entirely (same as the sibling "confirmed by other" path above).
    expect(mockProcessPollResults).not.toHaveBeenCalled();
  });

  it('deletes the stale pending entry when the in-lock existingById check finds the row already persisted', async () => {
    // Pending stays present through both reads, but a concurrent caller already
    // wrote the row for this pre-generated id. The in-lock existingById check
    // finds it and bails without creating a duplicate. The pending entry must
    // still be dropped here, or the orphan sweep later phantom-stops the live
    // row this pending id points at.
    mockUpdatePendingSession.mockReturnValue({
      updatedData: createPendingSessionData(),
      isConfirmed: true,
    });

    const mockServerRow = {
      id: 'server-1',
      name: 'Test Server',
      type: 'plex',
      url: 'http://localhost:32400',
      token: 'test-token',
    };
    const mockServerUserRow = {
      id: 'server-user-1',
      userId: 'identity-1',
      serverId: 'server-1',
      externalId: 'user-123',
      username: 'alice',
      email: null,
      thumbUrl: null,
      isServerAdmin: false,
      trustScore: 100,
      sessionCount: 5,
      lastActivityAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      identityName: 'Alice',
    };

    // Override the DB so the in-lock existingById lookup (a columns query with
    // no innerJoin) resolves a row for the pre-generated id.
    mockDb.select.mockImplementation((columns?: unknown) => ({
      from: vi.fn(() => {
        if (columns === undefined) {
          const s: Record<string, unknown> = {};
          s.where = () => s;
          s.limit = () => s;
          s.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
            Promise.resolve([mockServerRow]).then(res, rej);
          return s;
        }
        const o: Record<string, unknown> = {};
        o.where = () => o;
        o.limit = () => o;
        o.innerJoin = () => {
          const j: Record<string, unknown> = {};
          j.where = () => j;
          j.limit = () => j;
          j.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
            Promise.resolve([mockServerUserRow]).then(res, rej);
          return j;
        };
        o.then = (res: (v: unknown[]) => void, rej?: (e: unknown) => void) =>
          Promise.resolve([{ id: 'pending-uuid-123' }]).then(res, rej);
        return o;
      }),
    }));

    await triggerServerPoll('server-1');

    expect(mockCreateSessionWithRulesAtomic).not.toHaveBeenCalled();
    expect(cacheService.deletePendingSession).toHaveBeenCalledWith('server-1', 'test-session-key');
  });
});
