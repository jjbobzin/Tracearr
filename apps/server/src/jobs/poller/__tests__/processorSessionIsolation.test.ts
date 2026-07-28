/**
 * Per-Session Error Isolation Tests
 *
 * A thrown error while processing one session inside processServerSessions
 * must not discard sessions already handled that tick, skip the grace
 * sweep, or make the server's tick report success:false - only a failure
 * to fetch sessions from the media server (or the setup around it) should
 * do that. These run through pollServers/triggerPoll, since that's what
 * feeds the DOWN_THRESHOLD health tracking the bug corrupts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSession } from '@tracearr/shared';
import type { CacheService, PubSubService } from '../../../services/cache.js';
import type { ProcessedSession } from '../types.js';

const mockDbSelect = vi.fn();
const { mockCreateMediaServerClient, mockGetActiveRulesV2 } = vi.hoisted(() => ({
  mockCreateMediaServerClient: vi.fn(),
  mockGetActiveRulesV2: vi.fn().mockResolvedValue([]),
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
    isInFallback: vi.fn().mockReturnValue(true),
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

const mockUpdatePendingSession = vi.fn();
vi.mock('../pendingConfirmation.js', () => ({
  updatePendingSession: (...args: unknown[]) => mockUpdatePendingSession(...args),
}));

const mockStopSessionAtomic = vi.fn();
const mockProcessPollResults = vi.fn().mockResolvedValue(undefined);
const mockBuildPendingActiveSession = vi.fn();
vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  buildActiveSession: vi.fn(),
  buildPendingActiveSession: (...args: unknown[]) => mockBuildPendingActiveSession(...args),
  createSessionWithRulesAtomic: vi.fn(),
  findActiveSession: vi.fn(),
  findActiveSessionByComposite: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  processPollResults: (...args: unknown[]) => mockProcessPollResults(...args),
  reEvaluateRulesOnPauseState: vi.fn(),
  reEvaluateRulesOnTranscodeChange: vi.fn(),
  stopSessionAtomic: (...args: unknown[]) => mockStopSessionAtomic(...args),
}));

vi.mock('../violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

vi.mock('../sessionMapper.js', () => ({
  mapMediaSession: vi.fn((raw: unknown) => raw),
  pickStreamDetailFields: vi.fn().mockReturnValue({}),
}));

import { servers, serverUsers, sessions as sessionsTable } from '../../../db/schema.js';
import { gracePeriodSessionIds, initializePoller, stopPoller, triggerPoll } from '../processor.js';

function createMockProcessedSession(overrides: Partial<ProcessedSession> = {}): ProcessedSession {
  return {
    sessionKey: 'sk-1',
    ratingKey: 'rk-1',
    externalUserId: 'ext-user-1',
    username: 'testuser',
    userThumb: '',
    mediaTitle: 'Test Movie',
    mediaType: 'movie',
    grandparentTitle: '',
    seasonNumber: 0,
    episodeNumber: 0,
    year: 2024,
    thumbPath: '',
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    liveUuid: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    ipAddress: '192.168.1.100',
    playerName: 'Player 1',
    deviceId: 'device-1',
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Web',
    quality: '1080p',
    isTranscode: false,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    bitrate: 20000,
    state: 'playing',
    totalDurationMs: 7200000,
    progressMs: 600000,
    sourceVideoCodec: 'hevc',
    sourceAudioCodec: 'ac3',
    sourceAudioChannels: 6,
    sourceVideoWidth: 3840,
    sourceVideoHeight: 2160,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: null,
    streamAudioCodec: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
  };
}

const serverRow = {
  id: 'server-1',
  name: 'Test Server',
  type: 'plex' as const,
  url: 'http://localhost:32400',
  token: 'token-1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const serverUsersRows = [
  {
    id: 'su-a',
    userId: 'identity-a',
    serverId: 'server-1',
    externalId: 'ext-a',
    username: 'userA',
    email: null,
    thumbUrl: null,
    isServerAdmin: false,
    trustScore: 100,
    sessionCount: 1,
    lastActivityAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    identityName: 'User A',
  },
  {
    id: 'su-b',
    userId: 'identity-b',
    serverId: 'server-1',
    externalId: 'ext-b',
    username: 'userB',
    email: null,
    thumbUrl: null,
    isServerAdmin: false,
    trustScore: 100,
    sessionCount: 1,
    lastActivityAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    identityName: 'User B',
  },
];

const processedA = createMockProcessedSession({
  sessionKey: 'session-A',
  externalUserId: 'ext-a',
  username: 'userA',
  ratingKey: 'rk-a',
  deviceId: 'device-a',
});
const processedB = createMockProcessedSession({
  sessionKey: 'session-B',
  externalUserId: 'ext-b',
  username: 'userB',
  ratingKey: 'rk-b',
  deviceId: 'device-b',
});

const activeSessionA = {
  id: 'active-a-id',
  serverId: 'server-1',
  serverUserId: 'su-a',
  sessionKey: 'session-A',
  deviceId: 'device-a',
  ratingKey: 'rk-a',
  pending: false,
} as unknown as ActiveSession;
const activeSessionB = {
  id: 'active-b-id',
  serverId: 'server-1',
  serverUserId: 'su-b',
  sessionKey: 'session-B',
  deviceId: 'device-b',
  ratingKey: 'rk-b',
  pending: false,
} as unknown as ActiveSession;

mockDbSelect.mockImplementation((_cols?: unknown) => ({
  from: (table: unknown) => {
    if (table === servers) return Promise.resolve([serverRow]);
    if (table === serverUsers) {
      return { innerJoin: () => ({ where: () => Promise.resolve(serverUsersRows) }) };
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
    getAllActiveSessions: vi.fn().mockResolvedValue([activeSessionA, activeSessionB]),
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
    getPendingSession: vi.fn((_serverId: string, pendingKey: string) => {
      if (pendingKey === 'session-A') return Promise.reject(new Error('transient redis error'));
      return Promise.resolve({ id: 'pending-b' });
    }),
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

describe('per-session error isolation in processServerSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopPoller();
    mockGetActiveRulesV2.mockResolvedValue([]);
    mockUpdatePendingSession.mockImplementation(() => ({
      updatedData: { id: 'pending-b-data' },
      isConfirmed: false,
    }));
    mockBuildPendingActiveSession.mockImplementation((data: unknown) => ({
      id: 'active-b-updated',
      pending: true,
      source: data,
    }));

    cacheService = createCacheService();
    initializePoller(
      cacheService as unknown as CacheService,
      createPubSubService() as unknown as PubSubService
    );
  });

  it('lands the other session and keeps the server healthy when one session throws mid-poll', async () => {
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([processedA, processedB]),
    });

    await triggerPoll();

    expect(cacheService.setServerHealth).toHaveBeenCalledWith('server-1', true);
    expect(cacheService.incrServerFailCount).not.toHaveBeenCalled();

    const lastCall = mockProcessPollResults.mock.calls.at(-1)?.[0] as {
      updatedSessions: Array<{ id: string }>;
    };
    expect(lastCall.updatedSessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'active-b-updated' })])
    );
  });

  it('never trips the DOWN_THRESHOLD notification across repeated ticks where the same session keeps throwing', async () => {
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([processedA, processedB]),
    });

    await triggerPoll();
    await triggerPoll();
    await triggerPoll();

    expect(cacheService.setServerHealth).not.toHaveBeenCalledWith('server-1', false);
    expect(mockEnqueueNotification.mock.calls.some(([arg]) => arg.type === 'server_down')).toBe(
      false
    );
  });

  it('still reports the server unhealthy when client.getSessions() itself fails', async () => {
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });

    await triggerPoll();
    await triggerPoll();
    await triggerPoll();

    expect(cacheService.setServerHealth).toHaveBeenCalledWith('server-1', false);
    expect(mockEnqueueNotification.mock.calls.some(([arg]) => arg.type === 'server_down')).toBe(
      true
    );
  });

  it('does not treat a session that throws mid-processing as missing for grace-period purposes', async () => {
    // Tick 1: session A is genuinely absent from the response - it enters grace.
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([processedB]),
    });
    await triggerPoll();

    expect(gracePeriodSessionIds().has('active-a-id')).toBe(true);

    // Tick 2: session A is back in the response but throws while being processed.
    mockCreateMediaServerClient.mockReturnValue({
      getSessions: vi.fn().mockResolvedValue([processedA, processedB]),
    });
    await triggerPoll();

    expect(gracePeriodSessionIds().has('active-a-id')).toBe(false);
    expect(mockStopSessionAtomic).not.toHaveBeenCalled();
  });
});
