/**
 * SSE Processor Tests - Server Health Notifications
 *
 * Tests the fallback:activated and fallback:deactivated handlers:
 * - Server down notification is delayed by threshold (60s)
 * - Server up cancels pending notification if recovered before threshold
 * - Server up sends notification if server was marked as down
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventEmitter } from 'events';

// Create mocks using vi.hoisted - must require EventEmitter inside for hoisting to work
const { mockSseManager, mockEnqueueNotification } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('events');
  return {
    mockSseManager: new EE() as EventEmitter,
    mockEnqueueNotification: vi.fn().mockResolvedValue('job-id'),
  };
});

// Mock the sseManager
vi.mock('../../services/sseManager.js', () => ({
  sseManager: mockSseManager,
}));

// Mock enqueueNotification
vi.mock('../notificationQueue.js', () => ({
  enqueueNotification: mockEnqueueNotification,
}));

// Mock other dependencies
vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));

vi.mock('../../services/mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

vi.mock('../../services/geoip.js', () => ({
  geoipService: { lookup: vi.fn() },
}));

vi.mock('../poller/index.js', () => ({
  triggerReconciliationPoll: vi.fn(),
}));

vi.mock('../poller/sessionMapper.js', () => ({
  mapMediaSession: vi.fn(),
}));

vi.mock('../poller/stateTracker.js', () => ({
  calculatePauseAccumulation: vi.fn(),
  checkWatchCompletion: vi.fn(),
  detectMediaChange: vi.fn(),
  // Playback confirmation functions for delayed rule evaluation
  isPlaybackConfirmed: vi.fn().mockReturnValue(false),
  createInitialConfirmationState: vi.fn().mockReturnValue({
    confirmedPlayback: false,
    firstSeenAt: Date.now(),
    maxViewOffset: 0,
  }),
  updateConfirmationState: vi.fn().mockImplementation((state) => state),
}));

vi.mock('../poller/database.js', () => ({
  getActiveRulesV2: vi.fn(),
  batchGetRecentUserSessions: vi.fn(),
  mergeRecentSessionsForIdentity: (map: Map<string, unknown[]>, ids: string[]) =>
    ids.flatMap((id) => map.get(id) ?? []),
}));

vi.mock('../poller/violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

vi.mock('../poller/sessionLifecycle.js', () => ({
  stopSessionAtomic: vi.fn(),
  findActiveSession: vi.fn(),
  findActiveSessionsAll: vi.fn(),
  buildActiveSession: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  handleQualityChangeFallout: vi.fn(),
  reEvaluateRulesOnTranscodeChange: vi.fn(),
  confirmAndPersistSession: vi.fn(),
}));

// Import after mocking
import { initializeSSEProcessor, startSSEProcessor, stopSSEProcessor } from '../sseProcessor.js';
import { triggerReconciliationPoll } from '../poller/index.js';

// Mock cache and pubsub services
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
  // Pending session methods for delayed rule evaluation
  getPendingSession: vi.fn().mockResolvedValue(null),
  setPendingSession: vi.fn(),
  deletePendingSession: vi.fn(),
  getAllPendingSessionKeys: vi.fn().mockResolvedValue([]),
};

const mockPubSubService = {
  publish: vi.fn(),
  subscribe: vi.fn(),
};

describe('SSE Processor - Server Health Notifications', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockSseManager.removeAllListeners();

    // Initialize and start the processor
    initializeSSEProcessor(mockCacheService as never, mockPubSubService as never);
    startSSEProcessor();
  });

  afterEach(() => {
    stopSSEProcessor();
    vi.useRealTimers();
  });

  describe('fallback:activated (server goes down)', () => {
    it('should schedule server_down notification with 60s delay', () => {
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-1',
        serverName: 'Test Server',
      });

      // Notification should NOT be sent immediately
      expect(mockEnqueueNotification).not.toHaveBeenCalled();

      // Advance time by 59 seconds - still no notification
      vi.advanceTimersByTime(59_000);
      expect(mockEnqueueNotification).not.toHaveBeenCalled();

      // Advance past 60 seconds - notification should be sent
      vi.advanceTimersByTime(1_000);
      expect(mockEnqueueNotification).toHaveBeenCalledWith({
        type: 'server_down',
        payload: { serverName: 'Test Server', serverId: 'server-1' },
      });
    });

    it('should handle multiple servers going down independently', () => {
      // Server 1 goes down
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-1',
        serverName: 'Server 1',
      });

      // 30 seconds later, Server 2 goes down
      vi.advanceTimersByTime(30_000);
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-2',
        serverName: 'Server 2',
      });

      // At 60s, only Server 1 should be notified
      vi.advanceTimersByTime(30_000);
      expect(mockEnqueueNotification).toHaveBeenCalledTimes(1);
      expect(mockEnqueueNotification).toHaveBeenCalledWith({
        type: 'server_down',
        payload: { serverName: 'Server 1', serverId: 'server-1' },
      });

      // At 90s (60s after Server 2), Server 2 should be notified
      vi.advanceTimersByTime(30_000);
      expect(mockEnqueueNotification).toHaveBeenCalledTimes(2);
      expect(mockEnqueueNotification).toHaveBeenLastCalledWith({
        type: 'server_down',
        payload: { serverName: 'Server 2', serverId: 'server-2' },
      });
    });

    it('should replace pending notification if same server triggers again', () => {
      // Server goes down
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-1',
        serverName: 'Test Server',
      });

      // 30 seconds later, same server triggers fallback again (e.g., retry logic)
      vi.advanceTimersByTime(30_000);
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-1',
        serverName: 'Test Server',
      });

      // Original 60s would be at 60s, but we reset, so need 60s from second trigger
      vi.advanceTimersByTime(30_000); // Now at 60s from first
      expect(mockEnqueueNotification).not.toHaveBeenCalled();

      // 60s from second trigger (at 90s total)
      vi.advanceTimersByTime(30_000);
      expect(mockEnqueueNotification).toHaveBeenCalledTimes(1);
    });
  });

  describe('fallback:deactivated (server comes back up)', () => {
    it('should cancel pending notification if server recovers before threshold', () => {
      // Server goes down
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-1',
        serverName: 'Test Server',
      });

      // Server comes back up after 30 seconds (before 60s threshold)
      vi.advanceTimersByTime(30_000);
      mockSseManager.emit('fallback:deactivated', {
        serverId: 'server-1',
        serverName: 'Test Server',
      });

      // No server_down notification should be sent
      expect(mockEnqueueNotification).not.toHaveBeenCalled();

      // Even after the original threshold passes, no notification
      vi.advanceTimersByTime(60_000);
      expect(mockEnqueueNotification).not.toHaveBeenCalled();
    });

    it('should send server_up notification if server was marked as down', async () => {
      // Server goes down
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-1',
        serverName: 'Test Server',
      });

      // Wait for threshold to pass - server is now "down"
      vi.advanceTimersByTime(60_000);
      expect(mockEnqueueNotification).toHaveBeenCalledWith({
        type: 'server_down',
        payload: { serverName: 'Test Server', serverId: 'server-1' },
      });

      mockEnqueueNotification.mockClear();

      // Server comes back up
      mockSseManager.emit('fallback:deactivated', {
        serverId: 'server-1',
        serverName: 'Test Server',
      });

      // Need to flush promises for the async handler
      await vi.runAllTimersAsync();

      expect(mockEnqueueNotification).toHaveBeenCalledWith({
        type: 'server_up',
        payload: { serverName: 'Test Server', serverId: 'server-1' },
      });
    });

    it('should not send server_up if server was never marked as down', async () => {
      // Server comes up without ever going down (e.g., initial connection)
      mockSseManager.emit('fallback:deactivated', {
        serverId: 'server-1',
        serverName: 'Test Server',
      });

      await vi.runAllTimersAsync();

      // Should NOT send server_up since we never sent server_down
      expect(mockEnqueueNotification).not.toHaveBeenCalled();
    });

    it('should trigger a reconciliation poll on reconnect to catch missed sessions', async () => {
      mockSseManager.emit('fallback:deactivated', {
        serverId: 'server-1',
        serverName: 'Test Server',
      });

      await vi.runAllTimersAsync();

      expect(vi.mocked(triggerReconciliationPoll)).toHaveBeenCalled();
    });
  });

  describe('stopSSEProcessor cleanup', () => {
    it('should clear pending notifications on stop', () => {
      // Server goes down
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-1',
        serverName: 'Test Server',
      });

      // Stop processor before threshold
      vi.advanceTimersByTime(30_000);
      stopSSEProcessor();

      // Even after threshold, no notification (timer was cleared)
      vi.advanceTimersByTime(60_000);
      expect(mockEnqueueNotification).not.toHaveBeenCalled();
    });

    it('should clear multiple pending notifications on stop', () => {
      // Multiple servers go down
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-1',
        serverName: 'Server 1',
      });
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-2',
        serverName: 'Server 2',
      });
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-3',
        serverName: 'Server 3',
      });

      // Stop processor
      stopSSEProcessor();

      // No notifications should be sent
      vi.advanceTimersByTime(120_000);
      expect(mockEnqueueNotification).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle enqueueNotification errors gracefully', () => {
      mockEnqueueNotification.mockRejectedValueOnce(new Error('Queue error'));

      // Server goes down
      mockSseManager.emit('fallback:activated', {
        serverId: 'server-1',
        serverName: 'Test Server',
      });

      // Should not throw when notification fails
      expect(() => {
        vi.advanceTimersByTime(60_000);
      }).not.toThrow();
    });
  });
});
