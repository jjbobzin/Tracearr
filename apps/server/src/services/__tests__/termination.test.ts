/**
 * Termination Service Tests
 *
 * Tests the terminateSession function from termination.ts:
 * - Successful termination (outcome: 'terminated')
 * - Session already gone (outcome: 'already_gone')
 * - Failed termination (outcome: 'failed')
 * - Cache and pubsub handling
 * - Graceful degradation when services unavailable
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

// Mock dependencies before importing the module under test
vi.mock('../cache.js', () => ({
  getCacheService: vi.fn(),
  getPubSubService: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    query: {
      sessions: {
        findFirst: vi.fn(),
      },
    },
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

// Import after mocking
import { db } from '../../db/client.js';
import { getCacheService, getPubSubService } from '../cache.js';
import { createMediaServerClient } from '../mediaServer/index.js';
import { terminateSession } from '../termination.js';

// Type for the mock session findFirst function (returns partial session for tests)
const mockSessionFindFirst = db.query.sessions.findFirst as ReturnType<typeof vi.fn>;

// Helper to create a mock session with server and user relations
function createMockSession(overrides: Record<string, unknown> = {}) {
  const sessionId = randomUUID();
  const serverId = randomUUID();
  const serverUserId = randomUUID();

  return {
    id: sessionId,
    serverId,
    serverUserId,
    sessionKey: 'session-key-123',
    plexSessionId: 'plex-session-456',
    startedAt: new Date('2024-01-01T10:00:00Z'),
    state: 'playing',
    server: {
      id: serverId,
      type: 'plex',
      url: 'http://localhost:32400',
      token: 'test-token',
    },
    serverUser: {
      id: serverUserId,
    },
    ...overrides,
  };
}

// Helper to setup database update chain
function mockDbUpdateChain() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.update).mockReturnValue(chain as never);
  return chain;
}

// Helper to setup database insert chain
function mockDbInsertChain(logId: string = randomUUID()) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: logId }]),
  };
  vi.mocked(db.insert).mockReturnValue(chain as never);
  return chain;
}

describe('terminateSession', () => {
  // Mock services
  const mockCacheService = {
    removeActiveSession: vi.fn().mockResolvedValue(undefined),
  };

  const mockPubSubService = {
    publish: vi.fn().mockResolvedValue(undefined),
  };

  const mockMediaClient = {
    terminateSession: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: services are available
    vi.mocked(getCacheService).mockReturnValue(mockCacheService as never);
    vi.mocked(getPubSubService).mockReturnValue(mockPubSubService as never);
    vi.mocked(createMediaServerClient).mockReturnValue(mockMediaClient as never);

    // Setup default DB mocks
    mockDbUpdateChain();
    mockDbInsertChain();
  });

  describe('successful termination', () => {
    it('should return outcome "terminated" on successful API call', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);

      const result = await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('terminated');
      expect(result.error).toBeUndefined();
    });

    it('should update cache on successful termination', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(mockCacheService.removeActiveSession).toHaveBeenCalledWith(mockSession.id);
    });

    it('should broadcast session:stopped event on success', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(mockPubSubService.publish).toHaveBeenCalledWith('session:stopped', mockSession.id);
    });

    it('should update session state to stopped in database', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);
      const updateChain = mockDbUpdateChain();

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(db.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'stopped',
          forceStopped: true,
        })
      );
    });

    it('should log the termination in terminationLogs', async () => {
      const mockSession = createMockSession();
      const logId = randomUUID();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);
      const insertChain = mockDbInsertChain(logId);

      const result = await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
        triggeredByUserId: 'admin-user-id',
        reason: 'Test termination',
      });

      expect(db.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: mockSession.id,
          serverId: mockSession.serverId,
          serverUserId: mockSession.serverUserId,
          trigger: 'manual',
          success: true,
        })
      );
      expect(result.terminationLogId).toBe(logId);
    });
  });

  describe('session already gone (404/not found)', () => {
    it('should return outcome "already_gone" when session not found on server', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockRejectedValue(
        new Error('Session not found (may have already ended)')
      );

      const result = await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('already_gone');
      expect(result.error).toBeUndefined();
    });

    it('should treat 404 error as success', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockRejectedValue(new Error('HTTP 404: Resource not found'));

      const result = await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(result.success).toBe(true);
      expect(result.outcome).toBe('already_gone');
    });

    it('should still clean up cache when session already gone', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockRejectedValue(new Error('Session not found'));

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(mockCacheService.removeActiveSession).toHaveBeenCalledWith(mockSession.id);
    });

    it('should still broadcast stop event when session already gone', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockRejectedValue(new Error('not found'));

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(mockPubSubService.publish).toHaveBeenCalledWith('session:stopped', mockSession.id);
    });

    it('should still update database state when session already gone', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockRejectedValue(new Error('not found'));
      const updateChain = mockDbUpdateChain();

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(db.update).toHaveBeenCalled();
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'stopped',
          forceStopped: true,
        })
      );
    });
  });

  describe('failed termination', () => {
    it('should return outcome "failed" on actual errors', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockRejectedValue(new Error('Network timeout'));

      const result = await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('failed');
      expect(result.error).toBe('Network timeout');
    });

    it('should NOT update cache on failure', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockRejectedValue(new Error('Connection refused'));

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(mockCacheService.removeActiveSession).not.toHaveBeenCalled();
    });

    it('should NOT broadcast stop event on failure', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockRejectedValue(new Error('Server error'));

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(mockPubSubService.publish).not.toHaveBeenCalled();
    });

    it('should still log the failed termination attempt', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockRejectedValue(new Error('Timeout'));
      const insertChain = mockDbInsertChain();

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(db.insert).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          errorMessage: 'Timeout',
        })
      );
    });

    it('should return failed when session not found in database', async () => {
      mockSessionFindFirst.mockResolvedValue(null);

      const result = await terminateSession({
        sessionId: 'non-existent-session',
        trigger: 'manual',
      });

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('failed');
      expect(result.error).toBe('Session not found in database');
    });

    it('should return failed when no session ID available for termination', async () => {
      // Session exists but has no terminationSessionId (plexSessionId or sessionKey)
      const mockSession = createMockSession({
        plexSessionId: null,
        sessionKey: null,
      });
      mockSessionFindFirst.mockResolvedValue(mockSession);

      const result = await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      expect(result.success).toBe(false);
      expect(result.outcome).toBe('failed');
      expect(result.error).toBe('No session ID available for termination');
    });
  });

  describe('service unavailability handling', () => {
    it('should handle cache service unavailable gracefully', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      vi.mocked(getCacheService).mockReturnValue(null);
      mockMediaClient.terminateSession.mockResolvedValue(true);

      const result = await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      // Should still succeed even without cache
      expect(result.success).toBe(true);
      expect(result.outcome).toBe('terminated');
    });

    it('should handle pubsub service unavailable gracefully', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      vi.mocked(getPubSubService).mockReturnValue(null);
      mockMediaClient.terminateSession.mockResolvedValue(true);

      const result = await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      // Should still succeed even without pubsub
      expect(result.success).toBe(true);
      expect(result.outcome).toBe('terminated');
    });

    it('should handle cache errors gracefully (not fail termination)', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);
      mockCacheService.removeActiveSession.mockRejectedValue(new Error('Redis connection failed'));

      // Spy on console.error to verify error was logged
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        /* no-op */
      });

      const result = await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      // Should still succeed despite cache error
      expect(result.success).toBe(true);
      expect(result.outcome).toBe('terminated');
      expect(consoleSpy).toHaveBeenCalledWith(
        '[Termination] Failed to update cache:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('should handle pubsub errors gracefully (not fail termination)', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);
      mockPubSubService.publish.mockRejectedValue(new Error('Publish failed'));

      // Spy on console.error to verify error was logged
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        /* no-op */
      });

      const result = await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      // Should still succeed despite pubsub error
      expect(result.success).toBe(true);
      expect(result.outcome).toBe('terminated');
      expect(consoleSpy).toHaveBeenCalledWith(
        '[Termination] Failed to broadcast stop:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('different server types', () => {
    it('should use plexSessionId for Plex servers', async () => {
      const mockSession = createMockSession({
        server: {
          type: 'plex',
          url: 'http://localhost:32400',
          token: 'plex-token',
        },
        plexSessionId: 'plex-specific-id',
        sessionKey: 'session-key',
      });
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      // For Plex, should use plexSessionId
      expect(mockMediaClient.terminateSession).toHaveBeenCalledWith('plex-specific-id', undefined);
    });

    it('should use sessionKey for Jellyfin servers', async () => {
      const mockSession = createMockSession({
        server: {
          type: 'jellyfin',
          url: 'http://localhost:8096',
          token: 'jellyfin-token',
        },
        plexSessionId: 'some-id',
        sessionKey: 'jellyfin-session-key',
      });
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      // For Jellyfin, should use sessionKey
      expect(mockMediaClient.terminateSession).toHaveBeenCalledWith(
        'jellyfin-session-key',
        undefined
      );
    });

    it('should use sessionKey for Emby servers', async () => {
      const mockSession = createMockSession({
        server: {
          type: 'emby',
          url: 'http://localhost:8096',
          token: 'emby-token',
        },
        plexSessionId: 'some-id',
        sessionKey: 'emby-session-key',
      });
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
      });

      // For Emby, should use sessionKey
      expect(mockMediaClient.terminateSession).toHaveBeenCalledWith('emby-session-key', undefined);
    });
  });

  describe('rule-triggered termination', () => {
    it('should log rule information for rule-triggered terminations', async () => {
      const mockSession = createMockSession();
      const ruleId = randomUUID();
      const violationId = randomUUID();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);
      const insertChain = mockDbInsertChain();

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'rule',
        ruleId,
        violationId,
        reason: 'Concurrent stream limit exceeded',
      });

      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: 'rule',
          ruleId,
          violationId,
          reason: 'Concurrent stream limit exceeded',
        })
      );
    });

    it('leaves the session row untouched and skips the stop broadcast when the kill call fails', async () => {
      const mockSession = createMockSession();
      const ruleId = randomUUID();
      const violationId = randomUUID();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockRejectedValue(new Error('Media server unreachable'));
      const insertChain = mockDbInsertChain();

      const result = await terminateSession({
        sessionId: mockSession.id,
        trigger: 'rule',
        ruleId,
        violationId,
        reason: 'Concurrent stream limit exceeded',
      });

      // The session is still actually playing - state must not be touched.
      expect(db.update).not.toHaveBeenCalled();
      // No session:stopped event for a session that never stopped.
      expect(mockPubSubService.publish).not.toHaveBeenCalled();
      // The termination attempt itself is recorded as failed.
      expect(result.success).toBe(false);
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ ruleId, violationId, success: false })
      );
    });
  });

  describe('termination reason', () => {
    it('should pass reason to media server client', async () => {
      const mockSession = createMockSession();
      mockSessionFindFirst.mockResolvedValue(mockSession);
      mockMediaClient.terminateSession.mockResolvedValue(true);

      await terminateSession({
        sessionId: mockSession.id,
        trigger: 'manual',
        reason: 'Admin requested stream stop',
      });

      expect(mockMediaClient.terminateSession).toHaveBeenCalledWith(
        expect.any(String),
        'Admin requested stream stop'
      );
    });
  });
});
