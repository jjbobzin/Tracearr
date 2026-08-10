import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  Action,
  RuleV2,
  Session,
  Server,
  ServerUser,
  NotifyAction,
  AdjustTrustAction,
  SetTrustAction,
  KillStreamAction,
  MessageClientAction,
  LogOnlyAction,
} from '@tracearr/shared';
import {
  setActionExecutorDeps,
  resetActionExecutorDeps,
  getActionExecutorDeps,
  executeAction,
  executeActions,
  executorRegistry,
  type ActionExecutorDeps,
} from '../executors/index.js';
import type { EvaluationContext } from '../types.js';

// Mock factories for testing - matching actual types from @tracearr/shared
function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    sessionKey: 'abc123',
    serverId: 'server-1',
    serverUserId: 'user-1',
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: '12345',
    serverVersionKey: null,
    parentRatingKey: null,
    grandparentRatingKey: null,
    mediaId: null,
    showMediaId: null,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    externalSessionId: null,
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7200000,
    progressMs: 3600000,
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
    playerName: 'Living Room TV',
    deviceId: 'device-123',
    product: 'Plex Web',
    device: 'Chrome',
    platform: 'Windows',
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
    // StreamDetailFields
    sourceVideoCodec: 'h264',
    sourceAudioCodec: 'aac',
    sourceAudioChannels: 2,
    sourceVideoWidth: 1920,
    sourceVideoHeight: 1080,
    sourceVideoDetails: null,
    sourceAudioDetails: null,
    streamVideoCodec: 'h264',
    streamAudioCodec: 'aac',
    streamVideoDetails: null,
    streamAudioDetails: null,
    transcodeInfo: null,
    subtitleInfo: null,
    ...overrides,
    geoLocationName: overrides.geoLocationName ?? null,
  };
}

function createMockServer(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Test Server',
    type: 'plex',
    url: 'http://localhost:32400',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockServerUser(overrides: Partial<ServerUser> = {}): ServerUser {
  return {
    id: 'server-user-1',
    userId: 'user-1',
    serverId: 'server-1',
    externalId: 'plex-user-1',
    username: 'testuser',
    email: 'test@example.com',
    thumbUrl: null,
    isServerAdmin: false,
    trustScore: 100,
    joinedAt: new Date(),
    lastActivityAt: new Date(),
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockRule(overrides: Partial<RuleV2> = {}): RuleV2 {
  return {
    id: 'rule-1',
    name: 'Test Rule',
    description: 'A test rule',
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    severity: 'warning',
    conditions: { groups: [] },
    actions: { actions: [] },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockContext(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  const session = createMockSession();
  return {
    session,
    server: createMockServer(),
    serverUser: createMockServerUser(),
    rule: createMockRule(),
    activeSessions: [session],
    recentSessions: [session],
    ...overrides,
  };
}

function createMockDeps(): ActionExecutorDeps {
  return {
    logAudit: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    adjustUserTrust: vi.fn().mockResolvedValue(undefined),
    setUserTrust: vi.fn().mockResolvedValue(undefined),
    resetUserTrust: vi.fn().mockResolvedValue(undefined),
    terminateSession: vi.fn().mockResolvedValue('kill-job-id'),
    sendClientMessage: vi.fn().mockResolvedValue(undefined),
    checkCooldown: vi.fn().mockResolvedValue(false),
    setCooldown: vi.fn().mockResolvedValue(undefined),
    queueForConfirmation: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Action Executor Registry', () => {
  describe('Dependency Injection', () => {
    beforeEach(() => {
      resetActionExecutorDeps();
    });

    it('should use no-op dependencies by default', () => {
      const deps = getActionExecutorDeps();
      expect(deps).toBeDefined();
      // Default deps should not throw
      expect(async () => await deps.logAudit({} as never)).not.toThrow();
    });

    it('should allow setting custom dependencies', () => {
      const mockDeps = createMockDeps();
      setActionExecutorDeps(mockDeps);
      expect(getActionExecutorDeps()).toBe(mockDeps);
    });

    it('should reset to no-op dependencies', () => {
      const mockDeps = createMockDeps();
      setActionExecutorDeps(mockDeps);
      resetActionExecutorDeps();
      expect(getActionExecutorDeps()).not.toBe(mockDeps);
    });
  });

  describe('Executor Registry', () => {
    it('should have executors for all action types', () => {
      const expectedTypes = [
        'log_only',
        'notify',
        'adjust_trust',
        'set_trust',
        'reset_trust',
        'kill_stream',
        'message_client',
      ];

      for (const type of expectedTypes) {
        expect(executorRegistry[type as keyof typeof executorRegistry]).toBeDefined();
        expect(typeof executorRegistry[type as keyof typeof executorRegistry]).toBe('function');
      }
    });
  });

  describe('executeAction', () => {
    let mockDeps: ActionExecutorDeps;

    beforeEach(() => {
      mockDeps = createMockDeps();
      setActionExecutorDeps(mockDeps);
    });

    afterEach(() => {
      resetActionExecutorDeps();
    });

    it('should return error for unknown action type', async () => {
      const context = createMockContext();
      const action = { type: 'unknown_type' } as unknown as Action;

      const result = await executeAction(context, action);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown action type');
    });

    describe('log_only', () => {
      it('should log audit with context data', async () => {
        const context = createMockContext();
        const action: LogOnlyAction = { type: 'log_only', message: 'Test log message' };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.logAudit).toHaveBeenCalledWith({
          sessionId: context.session.id,
          serverUserId: context.serverUser.id,
          serverId: context.server.id,
          ruleId: context.rule.id,
          ruleName: context.rule.name,
          message: 'Test log message',
          details: expect.any(Object),
        });
      });
    });

    describe('notify', () => {
      it('should send notification to channels', async () => {
        const context = createMockContext();
        const action: NotifyAction = {
          type: 'notify',
          channels: ['discord', 'email'],
        };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.sendNotification).toHaveBeenCalledWith({
          channels: ['discord', 'email'],
          title: expect.stringContaining(context.rule.name),
          message: expect.stringContaining(context.serverUser.username),
          data: expect.objectContaining({
            ruleId: context.rule.id,
            sessionId: context.session.id,
            serverUserId: context.serverUser.id,
            username: context.serverUser.username,
            displayName: context.serverUser.username,
          }),
        });
      });

      it('prefers the identity name over the account username for display', async () => {
        const context = createMockContext();
        context.serverUser.identityName = 'Alice Smith';
        const action: NotifyAction = { type: 'notify', channels: ['discord'] };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.sendNotification).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              username: context.serverUser.username,
              displayName: 'Alice Smith',
            }),
          })
        );
      });

      it('should not send notification if no channels specified', async () => {
        const context = createMockContext();
        const action: NotifyAction = { type: 'notify', channels: [] };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.sendNotification).not.toHaveBeenCalled();
      });
    });

    describe('adjust_trust', () => {
      it('should adjust user trust by amount', async () => {
        const context = createMockContext();
        const action: AdjustTrustAction = { type: 'adjust_trust', amount: -10 };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.adjustUserTrust).toHaveBeenCalledWith(context.serverUser.id, -10);
      });

      it('should not adjust if amount is 0', async () => {
        const context = createMockContext();
        const action: AdjustTrustAction = { type: 'adjust_trust', amount: 0 };

        await executeAction(context, action);

        expect(mockDeps.adjustUserTrust).not.toHaveBeenCalled();
      });
    });

    describe('set_trust', () => {
      it('should set user trust to specific value', async () => {
        const context = createMockContext();
        const action: SetTrustAction = { type: 'set_trust', value: 50 };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.setUserTrust).toHaveBeenCalledWith(context.serverUser.id, 50);
      });
    });

    describe('reset_trust', () => {
      it('should reset user trust to baseline', async () => {
        const context = createMockContext();
        const action: Action = { type: 'reset_trust' };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.resetUserTrust).toHaveBeenCalledWith(context.serverUser.id);
      });
    });

    describe('kill_stream', () => {
      it('should record the interim result as queued, not a false success', async () => {
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream' };

        const result = await executeAction(context, action);

        // The kill worker inserts the authoritative outcome (killed/skipped_*/failed)
        // later; this interim row must not claim success/skipped:false.
        expect(result).toEqual({
          action,
          success: true,
          skipped: true,
          skipReason: 'queued',
          enqueuedSessionIds: [context.session.id],
        });
      });

      it('records the action as failed (not queued) when the queue drops every target', async () => {
        (mockDeps.terminateSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream' };

        const result = await executeAction(context, action);

        // No job landed, so no worker row will follow: the interim row is the
        // only record and must read as failed rather than queued.
        expect(result.success).toBe(false);
        expect(result.skipped).toBeFalsy();
      });

      it('should terminate session silently when no message provided', async () => {
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream' };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          0,
          undefined,
          undefined,
          undefined,
          context.session.id
        );
      });

      it('should terminate session with delay', async () => {
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream', delay_seconds: 30 };

        await executeAction(context, action);

        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          30,
          undefined,
          undefined,
          undefined,
          context.session.id
        );
      });

      it('should terminate session with custom message', async () => {
        const context = createMockContext();
        const action: KillStreamAction = {
          type: 'kill_stream',
          message: 'You violated the concurrent streams policy',
        };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          0,
          'You violated the concurrent streams policy',
          undefined,
          undefined,
          context.session.id
        );
      });

      it('should terminate session with delay and message', async () => {
        const context = createMockContext();
        const action: KillStreamAction = {
          type: 'kill_stream',
          delay_seconds: 15,
          message: 'Stream will be terminated in 15 seconds',
        };

        await executeAction(context, action);

        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          15,
          'Stream will be terminated in 15 seconds',
          undefined,
          undefined,
          context.session.id
        );
      });

      it('should not set cooldown at enqueue time - arming moves to the kill worker', async () => {
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream', cooldown_minutes: 10 };

        await executeAction(context, action);

        expect(mockDeps.setCooldown).not.toHaveBeenCalled();
      });

      it('should carry cooldown_minutes and the triggering serverUserId through to terminateSession', async () => {
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream', cooldown_minutes: 10 };

        await executeAction(context, action);

        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          0,
          undefined,
          undefined,
          { minutes: 10, triggeringServerUserId: context.serverUser.id },
          context.session.id
        );
      });

      describe('with targeting', () => {
        it('should terminate only triggering session by default', async () => {
          const triggeringSession = createMockSession({ id: 'triggering' });
          const otherSession = createMockSession({
            id: 'other',
            serverUserId: triggeringSession.serverUserId,
            startedAt: new Date(Date.now() - 60000),
          });
          const context = createMockContext({
            session: triggeringSession,
            activeSessions: [otherSession, triggeringSession],
          });
          const action: KillStreamAction = { type: 'kill_stream' };

          await executeAction(context, action);

          expect(mockDeps.terminateSession).toHaveBeenCalledTimes(1);
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            'triggering',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            'triggering'
          );
        });

        it('should terminate oldest session but re-verify against the triggering session', async () => {
          const oldestSession = createMockSession({
            id: 'oldest',
            serverUserId: 'user-1',
            startedAt: new Date('2024-01-01T08:00:00Z'),
          });
          const newestSession = createMockSession({
            id: 'newest',
            serverUserId: 'user-1',
            startedAt: new Date('2024-01-01T10:00:00Z'),
          });
          const context = createMockContext({
            session: newestSession,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [oldestSession, newestSession],
          });
          const action: KillStreamAction = { type: 'kill_stream', target: 'oldest' };

          await executeAction(context, action);

          expect(mockDeps.terminateSession).toHaveBeenCalledTimes(1);
          // Target is the oldest session, but the trigger passed through is the
          // session that matched (newest), so the worker re-verifies against it.
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            'oldest',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            'newest'
          );
        });

        it('should terminate all except oldest when target is all_except_one', async () => {
          const session1 = createMockSession({
            id: 's1',
            serverUserId: 'user-1',
            startedAt: new Date('2024-01-01T08:00:00Z'),
          });
          const session2 = createMockSession({
            id: 's2',
            serverUserId: 'user-1',
            startedAt: new Date('2024-01-01T09:00:00Z'),
          });
          const session3 = createMockSession({
            id: 's3',
            serverUserId: 'user-1',
            startedAt: new Date('2024-01-01T10:00:00Z'),
          });
          const context = createMockContext({
            session: session3,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [session1, session2, session3],
          });
          const action: KillStreamAction = { type: 'kill_stream', target: 'all_except_one' };

          await executeAction(context, action);

          expect(mockDeps.terminateSession).toHaveBeenCalledTimes(2);
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            's2',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            's3'
          );
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            's3',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            's3'
          );
        });

        it('should terminate all user sessions when target is all_user', async () => {
          const session1 = createMockSession({ id: 's1', serverUserId: 'user-1' });
          const session2 = createMockSession({ id: 's2', serverUserId: 'user-1' });
          const otherUserSession = createMockSession({ id: 'other', serverUserId: 'user-2' });
          const context = createMockContext({
            session: session1,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [session1, session2, otherUserSession],
          });
          const action: KillStreamAction = { type: 'kill_stream', target: 'all_user' };

          await executeAction(context, action);

          expect(mockDeps.terminateSession).toHaveBeenCalledTimes(2);
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            's1',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            's1'
          );
          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            's2',
            context.server.id,
            context.rule.id,
            null,
            0,
            undefined,
            undefined,
            undefined,
            's1'
          );
          expect(mockDeps.terminateSession).not.toHaveBeenCalledWith(
            'other',
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything(),
            expect.anything()
          );
        });

        it('should give each target its own terminateSession call keyed by that session id', async () => {
          const session1 = createMockSession({ id: 's1', serverUserId: 'user-1' });
          const session2 = createMockSession({ id: 's2', serverUserId: 'user-1' });
          const context = createMockContext({
            session: session1,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [session1, session2],
            violationId: 'violation-1',
          });
          const action: KillStreamAction = { type: 'kill_stream', target: 'all_user' };

          const result = await executeAction(context, action);

          const calledSessionIds = (
            mockDeps.terminateSession as ReturnType<typeof vi.fn>
          ).mock.calls.map((call) => call[0]);
          // Multi-target: each resolved session is its own terminateSession call
          // (and, downstream, its own kill queue job) rather than one call for
          // the whole target set.
          expect(calledSessionIds).toEqual(['s1', 's2']);
          expect(new Set(calledSessionIds).size).toBe(2);
          // wasTerminatedByRule derives from this, so every enqueued target
          // (not just the triggering session) must be reported.
          expect(result.enqueuedSessionIds).toEqual(['s1', 's2']);
        });

        it('should carry identityServerUserIds only when the rule enforces across servers', async () => {
          const session1 = createMockSession({ id: 's1', serverUserId: 'user-1' });
          const crossServerContext = createMockContext({
            session: session1,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [session1],
            rule: createMockRule({ enforceAcrossServers: true }),
            identityServerUserIds: ['user-1', 'user-1-sibling'],
          });
          const action: KillStreamAction = { type: 'kill_stream' };

          await executeAction(crossServerContext, action);

          expect(mockDeps.terminateSession).toHaveBeenCalledWith(
            's1',
            crossServerContext.server.id,
            crossServerContext.rule.id,
            null,
            0,
            undefined,
            ['user-1', 'user-1-sibling'],
            undefined,
            's1'
          );
        });
      });
    });

    describe('message_client', () => {
      it('should send message to client', async () => {
        const context = createMockContext();
        const action: MessageClientAction = { type: 'message_client', message: 'Please stop!' };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(mockDeps.sendClientMessage).toHaveBeenCalledWith(context.session.id, 'Please stop!');
      });

      it('should not send if message is empty', async () => {
        const context = createMockContext();
        const action: MessageClientAction = { type: 'message_client', message: '' };

        await executeAction(context, action);

        expect(mockDeps.sendClientMessage).not.toHaveBeenCalled();
      });

      describe('with targeting', () => {
        it('should message all user sessions when target is all_user', async () => {
          const session1 = createMockSession({ id: 's1', serverUserId: 'user-1' });
          const session2 = createMockSession({ id: 's2', serverUserId: 'user-1' });
          const context = createMockContext({
            session: session1,
            serverUser: createMockServerUser({ id: 'user-1' }),
            activeSessions: [session1, session2],
          });
          const action: MessageClientAction = {
            type: 'message_client',
            message: 'Warning!',
            target: 'all_user',
          };

          await executeAction(context, action);

          expect(mockDeps.sendClientMessage).toHaveBeenCalledTimes(2);
          expect(mockDeps.sendClientMessage).toHaveBeenCalledWith('s1', 'Warning!');
          expect(mockDeps.sendClientMessage).toHaveBeenCalledWith('s2', 'Warning!');
        });
      });
    });

    describe('Cooldown Handling', () => {
      it('should skip action if on cooldown', async () => {
        (mockDeps.checkCooldown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
        const context = createMockContext();
        const action: NotifyAction = { type: 'notify', channels: ['discord'], cooldown_minutes: 5 };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(result.skipped).toBe(true);
        expect(result.skipReason).toContain('cooldown');
        expect(mockDeps.sendNotification).not.toHaveBeenCalled();
      });

      it('should execute and set cooldown if not on cooldown', async () => {
        (mockDeps.checkCooldown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        const context = createMockContext();
        const action: NotifyAction = { type: 'notify', channels: ['discord'], cooldown_minutes: 5 };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(result.skipped).toBeUndefined();
        expect(mockDeps.sendNotification).toHaveBeenCalled();
        expect(mockDeps.setCooldown).toHaveBeenCalled();
      });

      it('should not check cooldown if cooldown_minutes is not set', async () => {
        const context = createMockContext();
        const action: NotifyAction = { type: 'notify', channels: ['discord'] };

        await executeAction(context, action);

        expect(mockDeps.checkCooldown).not.toHaveBeenCalled();
      });

      it('scopes cooldown keys per action type so a notify cooldown cannot suppress kill_stream', async () => {
        (mockDeps.checkCooldown as ReturnType<typeof vi.fn>).mockImplementation(
          (_ruleId: string, targetId: string) => targetId.endsWith(':notify')
        );
        const context = createMockContext();
        const actions: Action[] = [
          { type: 'notify', channels: ['discord'], cooldown_minutes: 5 },
          { type: 'kill_stream', cooldown_minutes: 10 },
        ];

        const results = await executeActions(context, actions);

        expect(results[0]?.skipped).toBe(true);
        expect(results[0]?.skipReason).toContain('cooldown');
        expect(mockDeps.checkCooldown).toHaveBeenCalledWith(
          context.rule.id,
          `${context.rule.id}:${context.serverUser.id}:notify`,
          5
        );
        expect(mockDeps.checkCooldown).toHaveBeenCalledWith(
          context.rule.id,
          `${context.rule.id}:${context.serverUser.id}:kill_stream`,
          10
        );
        expect(mockDeps.terminateSession).toHaveBeenCalledWith(
          context.session.id,
          context.server.id,
          context.rule.id,
          null,
          0,
          undefined,
          undefined,
          { minutes: 10, triggeringServerUserId: context.serverUser.id },
          context.session.id
        );
      });

      it('arms the cooldown key with the action type', async () => {
        (mockDeps.checkCooldown as ReturnType<typeof vi.fn>).mockResolvedValue(false);
        const context = createMockContext();
        const action: NotifyAction = { type: 'notify', channels: ['discord'], cooldown_minutes: 5 };

        await executeAction(context, action);

        expect(mockDeps.setCooldown).toHaveBeenCalledWith(
          context.rule.id,
          `${context.rule.id}:${context.serverUser.id}:notify`,
          5
        );
      });
    });

    describe('Confirmation Handling', () => {
      it('should queue for confirmation if require_confirmation is true', async () => {
        const context = createMockContext();
        const action: KillStreamAction = { type: 'kill_stream', require_confirmation: true };

        const result = await executeAction(context, action);

        expect(result.success).toBe(true);
        expect(result.skipped).toBe(true);
        expect(result.skipReason).toContain('confirmation');
        expect(mockDeps.queueForConfirmation).toHaveBeenCalledWith({
          ruleId: context.rule.id,
          ruleName: context.rule.name,
          sessionId: context.session.id,
          serverUserId: context.serverUser.id,
          serverId: context.server.id,
          action,
        });
        expect(mockDeps.terminateSession).not.toHaveBeenCalled();
      });
    });

    describe('Error Handling', () => {
      it('should return error result if executor throws', async () => {
        (mockDeps.sendNotification as ReturnType<typeof vi.fn>).mockRejectedValue(
          new Error('Network error')
        );
        const context = createMockContext();
        const action: NotifyAction = { type: 'notify', channels: ['discord'] };

        const result = await executeAction(context, action);

        expect(result.success).toBe(false);
        expect(result.message).toBe('Network error');
      });
    });
  });

  describe('executeActions', () => {
    let mockDeps: ActionExecutorDeps;

    beforeEach(() => {
      mockDeps = createMockDeps();
      setActionExecutorDeps(mockDeps);
    });

    afterEach(() => {
      resetActionExecutorDeps();
    });

    it('should execute all actions in sequence', async () => {
      const context = createMockContext();
      const actions: Action[] = [
        { type: 'log_only', message: 'Test' },
        { type: 'adjust_trust', amount: -10 },
        { type: 'notify', channels: ['discord'] },
      ];

      const results = await executeActions(context, actions);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.success)).toBe(true);
      expect(mockDeps.logAudit).toHaveBeenCalled();
      expect(mockDeps.adjustUserTrust).toHaveBeenCalled();
      expect(mockDeps.sendNotification).toHaveBeenCalled();
    });

    it('should continue executing after an action fails', async () => {
      (mockDeps.logAudit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Audit error'));
      const context = createMockContext();
      const actions: Action[] = [
        { type: 'log_only', message: 'Test' },
        { type: 'notify', channels: ['discord'] },
      ];

      const results = await executeActions(context, actions);

      expect(results).toHaveLength(2);
      expect(results[0]?.success).toBe(false);
      expect(results[1]?.success).toBe(true);
      expect(mockDeps.sendNotification).toHaveBeenCalled();
    });

    it('should return empty array for empty actions', async () => {
      const context = createMockContext();

      const results = await executeActions(context, []);

      expect(results).toEqual([]);
    });
  });
});
