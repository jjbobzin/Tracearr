import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CacheService } from '../../services/cache.js';

describe('sweepOrphanedPendingSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should discard pending sessions older than 2 minutes', async () => {
    const mockCacheService = {
      getAllPendingSessionKeys: vi.fn().mockResolvedValue([
        { serverId: 'server-1', sessionKey: 'old-session' },
        { serverId: 'server-1', sessionKey: 'new-session' },
      ]),
      getPendingSession: vi.fn().mockImplementation((serverId: string, sessionKey: string) => {
        if (sessionKey === 'old-session') {
          return {
            id: 'session-id-old',
            lastSeenAt: Date.now() - 3 * 60 * 1000, // 3 minutes ago
            serverUser: { id: 'user-1' },
          };
        }
        return {
          id: 'session-id-new',
          lastSeenAt: Date.now() - 30 * 1000, // 30 seconds ago
          serverUser: { id: 'user-1' },
        };
      }),
      deletePendingSession: vi.fn(),
      removeActiveSession: vi.fn(),
      invalidateDashboardStatsCache: vi.fn(),
    } as unknown as CacheService;

    // Import and call sweepOrphanedPendingSessions
    const { sweepOrphanedPendingSessions } = await import('../sseProcessor.js');
    await sweepOrphanedPendingSessions(mockCacheService);

    expect(mockCacheService.deletePendingSession).toHaveBeenCalledWith('server-1', 'old-session');
    expect(mockCacheService.deletePendingSession).not.toHaveBeenCalledWith(
      'server-1',
      'new-session'
    );
    expect(mockCacheService.removeActiveSession).toHaveBeenCalledWith('session-id-old', {
      skipDashboardInvalidation: true,
    });
    // One flush after the loop instead of one SCAN per removed session
    expect(mockCacheService.invalidateDashboardStatsCache).toHaveBeenCalledOnce();
  });

  it('srems a set member whose per-session hash already expired', async () => {
    const mockCacheService = {
      getAllPendingSessionKeys: vi.fn().mockResolvedValue([
        { serverId: 'server-1', sessionKey: 'zombie-session' },
        { serverId: 'server-1', sessionKey: 'new-session' },
      ]),
      // The zombie's hash TTL'd out already, so a lookup returns null even
      // though the member is still present in PENDING_SESSION_IDS.
      getPendingSession: vi.fn().mockImplementation((_serverId: string, sessionKey: string) => {
        if (sessionKey === 'zombie-session') return null;
        return {
          id: 'session-id-new',
          lastSeenAt: Date.now() - 30 * 1000,
          serverUser: { id: 'user-1' },
        };
      }),
      deletePendingSession: vi.fn(),
      removeActiveSession: vi.fn(),
      invalidateDashboardStatsCache: vi.fn(),
    } as unknown as CacheService;

    const { sweepOrphanedPendingSessions } = await import('../sseProcessor.js');
    await sweepOrphanedPendingSessions(mockCacheService);

    // deletePendingSession's srem is what clears the zombie set member; its
    // del is a harmless no-op since the hash is already gone.
    expect(mockCacheService.deletePendingSession).toHaveBeenCalledWith(
      'server-1',
      'zombie-session'
    );
    expect(mockCacheService.removeActiveSession).not.toHaveBeenCalled();
    // Nothing was swept, so the deferred flush must not fire
    expect(mockCacheService.invalidateDashboardStatsCache).not.toHaveBeenCalled();
  });

  it('resolves instead of rejecting when getAllPendingSessionKeys throws', async () => {
    const mockCacheService = {
      getAllPendingSessionKeys: vi.fn().mockRejectedValue(new Error('redis down')),
      getPendingSession: vi.fn(),
      deletePendingSession: vi.fn(),
      removeActiveSession: vi.fn(),
      invalidateDashboardStatsCache: vi.fn(),
    } as unknown as CacheService;

    const { sweepOrphanedPendingSessions } = await import('../sseProcessor.js');

    // A Redis outage at a 30s reconciliation tick must degrade to a logged
    // error, not a rejected promise that surfaces as an unhandledRejection.
    await expect(sweepOrphanedPendingSessions(mockCacheService)).resolves.toBeUndefined();
  });

  it('resolves instead of rejecting when the deferred dashboard flush throws', async () => {
    const mockCacheService = {
      getAllPendingSessionKeys: vi
        .fn()
        .mockResolvedValue([{ serverId: 'server-1', sessionKey: 'old-session' }]),
      getPendingSession: vi.fn().mockResolvedValue({
        id: 'session-id-old',
        lastSeenAt: Date.now() - 3 * 60 * 1000,
        serverUser: { id: 'user-1' },
      }),
      deletePendingSession: vi.fn(),
      removeActiveSession: vi.fn(),
      invalidateDashboardStatsCache: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as CacheService;

    const { sweepOrphanedPendingSessions } = await import('../sseProcessor.js');

    await expect(sweepOrphanedPendingSessions(mockCacheService)).resolves.toBeUndefined();
  });
});
