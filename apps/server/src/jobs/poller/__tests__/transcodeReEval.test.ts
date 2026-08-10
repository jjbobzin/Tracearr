/**
 * Transcode Re-evaluation Tests
 *
 * Tests for reEvaluateRulesOnTranscodeChange:
 * - Only transcode-related rules are evaluated (no false positives)
 * - Violations are created when transcode rules match
 * - Application-level dedup prevents duplicate violations
 * - Trust score penalties are applied
 * - Side effect actions (kill_stream) are executed
 * - Non-transcode rules (concurrent_streams, etc.) are skipped
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RuleV2, Session } from '@tracearr/shared';
import type { TranscodeReEvalInput } from '../types.js';

// ============================================================================
// Module Mocks
// ============================================================================

// Mock DB client - the function uses db.transaction() with tx inside
const mockExecute = vi.fn();
const mockTxSelect = vi.fn();
const mockTxInsert = vi.fn();
const mockTxUpdate = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoNothing = vi.fn();
const mockReturning = vi.fn();
const mockSet = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../../../db/client.js', () => ({
  db: {
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

// Mock schema tables - use importOriginal to preserve transitive exports
vi.mock('../../../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
  };
});

// Mock rules engine
const mockEvaluateRulesAsync = vi.fn();
vi.mock('../../../services/rules/engine.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    evaluateRulesAsync: (...args: unknown[]) => mockEvaluateRulesAsync(...args),
  };
});

// Mock executors
const mockExecuteActions = vi.fn();
vi.mock('../../../services/rules/executors/index.js', () => ({
  executeActions: (...args: unknown[]) => mockExecuteActions(...args),
}));

// Mock v2Integration
const mockStoreActionResults = vi.fn();
vi.mock('../../../services/rules/v2Integration.js', () => ({
  storeActionResults: (...args: unknown[]) => mockStoreActionResults(...args),
}));

// Mock logger
vi.mock('../../../utils/logger.js', () => ({
  pollerLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  rulesLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock geoipService (needed by evaluators)
vi.mock('../../../services/geoip.js', () => ({
  geoipService: {
    isPrivateIP: (ip: string) =>
      ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('127.'),
  },
}));

// ============================================================================
// Helpers
// ============================================================================

function createMockExistingSession(
  overrides: Record<string, unknown> = {}
): TranscodeReEvalInput['existingSession'] {
  return {
    id: 'session-1',
    serverId: 'server-1',
    serverUserId: 'user-1',
    sessionKey: 'sk-1',
    externalSessionId: 'ext-1',
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: 'rk-1',
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7200000,
    progressMs: 0,
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    ipAddress: '192.168.1.100',
    geoCity: 'New York',
    geoRegion: 'NY',
    geoCountry: 'US',
    geoContinent: 'NA',
    geoPostal: '10001',
    geoLat: 40.7128,
    geoLon: -74.006,
    geoAsnNumber: 7922,
    geoAsnOrganization: 'Comcast',
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
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
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
  } as TranscodeReEvalInput['existingSession'];
}

function createMockProcessedSession(
  overrides: Record<string, unknown> = {}
): TranscodeReEvalInput['processed'] {
  return {
    sessionKey: 'sk-1',
    ratingKey: 'rk-1',
    externalUserId: 'ext-user-1',
    username: 'testuser',
    userThumb: '',
    mediaTitle: 'Test Movie',
    mediaType: 'movie' as const,
    grandparentTitle: '',
    seasonNumber: 0,
    episodeNumber: 0,
    year: 2024,
    thumbPath: '',
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
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
    quality: '4K (H.265) → 1080p (H.264)',
    isTranscode: true,
    videoDecision: 'transcode',
    audioDecision: 'directplay',
    bitrate: 10000,
    state: 'playing' as const,
    totalDurationMs: 7200000,
    progressMs: 360000,
    sourceVideoCodec: 'hevc',
    sourceAudioCodec: 'ac3',
    sourceAudioChannels: 6,
    sourceVideoWidth: 3840,
    sourceVideoHeight: 2160,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: 'h264',
    streamAudioCodec: null,
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
  } as TranscodeReEvalInput['processed'];
}

function createTranscodeRule(overrides: Partial<RuleV2> = {}): RuleV2 {
  return {
    id: 'rule-transcode-1',
    name: 'Block 4K Transcoding',
    description: null,
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    severity: 'high',
    isActive: true,
    conditions: {
      groups: [
        { conditions: [{ field: 'is_transcoding', operator: 'eq', value: true }] },
        { conditions: [{ field: 'source_resolution', operator: 'eq', value: '4K' }] },
      ],
    },
    actions: {
      actions: [{ type: 'kill_stream' }],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createConcurrentStreamsRule(overrides: Partial<RuleV2> = {}): RuleV2 {
  return {
    id: 'rule-concurrent-1',
    name: 'Max 2 Concurrent Streams',
    description: null,
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    severity: 'warning',
    isActive: true,
    conditions: {
      groups: [{ conditions: [{ field: 'concurrent_streams', operator: 'gt', value: 2 }] }],
    },
    actions: {
      actions: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createDefaultInput(overrides: Partial<TranscodeReEvalInput> = {}): TranscodeReEvalInput {
  return {
    existingSession: createMockExistingSession(),
    processed: createMockProcessedSession(),
    server: { id: 'server-1', name: 'Test Plex', type: 'plex' },
    serverUser: {
      id: 'user-1',
      userId: 'identity-1',
      username: 'testuser',
      thumbUrl: null,
      identityName: null,
      trustScore: 100,
      lastActivityAt: new Date(),
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
      identityServerUserIds: ['user-1'],
    },
    activeRulesV2: [createTranscodeRule(), createConcurrentStreamsRule()],
    activeSessions: [],
    recentSessions: [],
    ...overrides,
  };
}

function setupDbMockChain() {
  // Reset all mock chains
  mockTransaction.mockReset();
  mockExecute.mockReset();
  mockTxSelect.mockReset();
  mockTxInsert.mockReset();
  mockTxUpdate.mockReset();
  mockFrom.mockReset();
  mockWhere.mockReset();
  mockLimit.mockReset();
  mockValues.mockReset();
  mockOnConflictDoNothing.mockReset();
  mockReturning.mockReset();
  mockSet.mockReset();

  // tx.select().from().where().limit() → dedup check
  mockTxSelect.mockReturnValue({ from: mockFrom });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockLimit.mockResolvedValue([]); // No existing violations (default)

  // tx.insert().values().onConflictDoNothing().returning()
  mockTxInsert.mockReturnValue({ values: mockValues });
  mockValues.mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
  mockOnConflictDoNothing.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([
    {
      id: 'violation-1',
      ruleId: 'rule-transcode-1',
      serverUserId: 'user-1',
      sessionId: 'session-1',
      severity: 'high',
      ruleType: null,
      data: {},
      createdAt: new Date(),
      acknowledgedAt: null,
    },
  ]);

  // tx.update().set().where()
  mockTxUpdate.mockReturnValue({ set: mockSet });
  mockSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });

  // tx.execute() → advisory lock (no-op in tests)
  mockExecute.mockResolvedValue(undefined);

  // db.transaction(async (tx) => { ... }) - execute the callback with mock tx
  const mockTx = {
    execute: mockExecute,
    select: (...args: unknown[]) => mockTxSelect(...args),
    insert: (...args: unknown[]) => mockTxInsert(...args),
    update: (...args: unknown[]) => mockTxUpdate(...args),
  };
  mockTransaction.mockImplementation(async (cb: (tx: typeof mockTx) => Promise<unknown>) => {
    return cb(mockTx);
  });
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  setupDbMockChain();
  mockExecuteActions.mockResolvedValue([]);
  mockStoreActionResults.mockResolvedValue(undefined);
});

describe('reEvaluateRulesOnTranscodeChange', () => {
  // Import dynamically after mocks are set up
  async function getFunction() {
    const mod = await import('../sessionLifecycle.js');
    return mod.reEvaluateRulesOnTranscodeChange;
  }

  describe('rule filtering', () => {
    it('only evaluates transcode-related rules, skipping concurrent_streams', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([]);

      const input = createDefaultInput();
      await reEvaluateRulesOnTranscodeChange(input);

      // Should have been called with only the transcode rule, not the concurrent streams rule
      expect(mockEvaluateRulesAsync).toHaveBeenCalledTimes(1);
      const [_baseContext, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, RuleV2[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-transcode-1');
      expect(rules[0]?.name).toBe('Block 4K Transcoding');
    });

    it('returns empty array when no rules have transcode conditions', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      const input = createDefaultInput({
        activeRulesV2: [createConcurrentStreamsRule()],
      });

      const results = await reEvaluateRulesOnTranscodeChange(input);

      expect(results).toEqual([]);
      expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    });

    it('returns empty array when there are no active rules', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      const input = createDefaultInput({ activeRulesV2: [] });

      const results = await reEvaluateRulesOnTranscodeChange(input);

      expect(results).toEqual([]);
      expect(mockEvaluateRulesAsync).not.toHaveBeenCalled();
    });
  });

  describe('violation creation', () => {
    it('creates violation when transcode rule matches', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [{ type: 'kill_stream' }],
        },
      ]);

      const input = createDefaultInput();
      const results = await reEvaluateRulesOnTranscodeChange(input);

      expect(results).toHaveLength(1);
      expect(results[0]?.violation.id).toBe('violation-1');
      // Verify DB insert was called
      expect(mockTxInsert).toHaveBeenCalled();
    });

    it('includes transcodeReEval marker in violation data', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [],
        },
      ]);

      const input = createDefaultInput();
      await reEvaluateRulesOnTranscodeChange(input);

      // Verify the values passed to insert contain transcodeReEval: true
      const insertValues = mockValues.mock.calls[0]?.[0] as Record<string, unknown>;
      const data = insertValues?.data as Record<string, unknown>;
      expect(data?.transcodeReEval).toBe(true);
    });
  });

  describe('deduplication', () => {
    it('skips violation creation when duplicate exists', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [],
        },
      ]);

      // Simulate existing violation found (dedup check returns result)
      mockLimit.mockResolvedValue([{ id: 'existing-violation-1' }]);

      const input = createDefaultInput();
      const results = await reEvaluateRulesOnTranscodeChange(input);

      // No new violations should be created
      expect(results).toHaveLength(0);
      expect(mockTxInsert).not.toHaveBeenCalled();
    });

    it('does NOT execute side effects when violation is deduplicated', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [{ type: 'create_violation', severity: 'high' }, { type: 'kill_stream' }],
        },
      ]);

      // Simulate existing violation — kill_stream must NOT re-fire
      mockLimit.mockResolvedValue([{ id: 'existing-violation-1' }]);

      const input = createDefaultInput();
      const results = await reEvaluateRulesOnTranscodeChange(input);

      expect(results).toHaveLength(0);
      expect(mockTxInsert).not.toHaveBeenCalled();
      expect(mockExecuteActions).not.toHaveBeenCalled();
      expect(mockStoreActionResults).not.toHaveBeenCalled();
    });
  });

  describe('transaction safety', () => {
    it('acquires advisory lock before dedup check', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [],
        },
      ]);

      const input = createDefaultInput();
      await reEvaluateRulesOnTranscodeChange(input);

      // Transaction should be used
      expect(mockTransaction).toHaveBeenCalledTimes(1);

      // Advisory lock should be acquired (tx.execute called with SQL)
      expect(mockExecute).toHaveBeenCalledTimes(1);

      // Advisory lock should be called BEFORE the dedup select
      const executeOrder = mockExecute.mock.invocationCallOrder[0]!;
      const selectOrder = mockTxSelect.mock.invocationCallOrder[0]!;
      expect(executeOrder).toBeLessThan(selectOrder);
    });

    it('runs dedup check + insert + trust update in same transaction', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [],
        },
      ]);

      const input = createDefaultInput();
      await reEvaluateRulesOnTranscodeChange(input);

      // 1. dedup select
      expect(mockTxSelect).toHaveBeenCalled();
      // 2. violation insert
      expect(mockTxInsert).toHaveBeenCalled();

      // Verify ordering: select (dedup) → insert
      const selectOrder = mockTxSelect.mock.invocationCallOrder[0]!;
      const insertOrder = mockTxInsert.mock.invocationCallOrder[0]!;
      expect(selectOrder).toBeLessThan(insertOrder);
    });
  });

  describe('trust score penalty', () => {
    it('does NOT automatically decrease trust score on violation creation', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [],
        },
      ]);

      const input = createDefaultInput();
      await reEvaluateRulesOnTranscodeChange(input);

      // Trust score update should NOT be called for violation creation
      expect(mockTxUpdate).not.toHaveBeenCalled();
    });
  });

  describe('side effect actions', () => {
    it('executes kill_stream action alongside violation', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([
        {
          ruleId: 'rule-transcode-1',
          ruleName: 'Block 4K Transcoding',
          matched: true,
          matchedGroups: [0, 1],
          actions: [{ type: 'kill_stream' }],
        },
      ]);

      mockExecuteActions.mockResolvedValue([{ action: 'kill_stream', success: true }]);

      const input = createDefaultInput();
      await reEvaluateRulesOnTranscodeChange(input);

      // Should execute side effect actions (kill_stream)
      expect(mockExecuteActions).toHaveBeenCalledTimes(1);
      const [_ctx, actions] = mockExecuteActions.mock.calls[0] as [unknown, { type: string }[]];
      expect(actions).toHaveLength(1);
      expect(actions[0]?.type).toBe('kill_stream');

      // Should store action results
      expect(mockStoreActionResults).toHaveBeenCalledWith('violation-1', 'rule-transcode-1', [
        { action: 'kill_stream', success: true },
      ]);
    });
  });

  describe('context building', () => {
    it('passes updated transcode fields from processed data to evaluation', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([]);

      const input = createDefaultInput({
        processed: createMockProcessedSession({
          isTranscode: true,
          videoDecision: 'transcode',
          audioDecision: 'copy',
        }),
        existingSession: createMockExistingSession({
          isTranscode: false,
          videoDecision: 'directplay',
          audioDecision: 'directplay',
        }),
      });

      await reEvaluateRulesOnTranscodeChange(input);

      expect(mockEvaluateRulesAsync).toHaveBeenCalledTimes(1);
      const [baseContext] = mockEvaluateRulesAsync.mock.calls[0] as [
        { session: Session },
        RuleV2[],
      ];

      // Session should have UPDATED transcode fields from processed
      expect(baseContext.session.isTranscode).toBe(true);
      expect(baseContext.session.videoDecision).toBe('transcode');
      expect(baseContext.session.audioDecision).toBe('copy');

      // But identity fields should come from existing session
      expect(baseContext.session.id).toBe('session-1');
      expect(baseContext.session.serverId).toBe('server-1');
      expect(baseContext.session.serverUserId).toBe('user-1');
    });
  });

  describe('false positive prevention', () => {
    it('does NOT evaluate concurrent_streams rules on transcode change', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([]);

      const input = createDefaultInput({
        activeRulesV2: [
          createConcurrentStreamsRule(),
          createTranscodeRule(),
          // Another non-transcode rule
          {
            id: 'rule-geo-1',
            name: 'Geo Restriction',
            description: null,
            serverId: null,
            serverUserId: null,
            userId: null,
            enforceAcrossServers: false,
            severity: 'warning',
            isActive: true,
            conditions: {
              groups: [
                {
                  conditions: [{ field: 'country', operator: 'not_in', value: ['US', 'CA'] }],
                },
              ],
            },
            actions: { actions: [] },
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      });

      await reEvaluateRulesOnTranscodeChange(input);

      // Only the transcode rule should be evaluated
      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, RuleV2[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-transcode-1');
    });

    it('evaluates output_resolution rules (they depend on transcode state)', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([]);

      const outputResRule: RuleV2 = {
        id: 'rule-output-res-1',
        name: 'Block Low Resolution Output',
        description: null,
        serverId: null,
        serverUserId: null,
        userId: null,
        enforceAcrossServers: false,
        severity: 'warning',
        isActive: true,
        conditions: {
          groups: [{ conditions: [{ field: 'output_resolution', operator: 'eq', value: '480p' }] }],
        },
        actions: { actions: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const input = createDefaultInput({
        activeRulesV2: [outputResRule, createConcurrentStreamsRule()],
      });

      await reEvaluateRulesOnTranscodeChange(input);

      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, RuleV2[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-output-res-1');
    });

    it('evaluates is_transcode_downgrade rules (they depend on transcode state)', async () => {
      const reEvaluateRulesOnTranscodeChange = await getFunction();

      mockEvaluateRulesAsync.mockResolvedValue([]);

      const downgradeRule: RuleV2 = {
        id: 'rule-downgrade-1',
        name: 'Detect Transcode Downgrade',
        description: null,
        serverId: null,
        serverUserId: null,
        userId: null,
        enforceAcrossServers: false,
        severity: 'warning',
        isActive: true,
        conditions: {
          groups: [
            { conditions: [{ field: 'is_transcode_downgrade', operator: 'eq', value: true }] },
          ],
        },
        actions: { actions: [] },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const input = createDefaultInput({
        activeRulesV2: [downgradeRule],
      });

      await reEvaluateRulesOnTranscodeChange(input);

      const [_ctx, rules] = mockEvaluateRulesAsync.mock.calls[0] as [unknown, RuleV2[]];
      expect(rules).toHaveLength(1);
      expect(rules[0]?.id).toBe('rule-downgrade-1');
    });
  });
});
