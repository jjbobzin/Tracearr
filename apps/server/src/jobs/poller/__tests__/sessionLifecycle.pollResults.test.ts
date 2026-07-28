/**
 * processPollResults Tests
 *
 * Verifies the per-tick fan-out behavior:
 * - session:updated is coalesced to a single publish per tick regardless of
 *   how many sessions were updated (no consumer reads the payload)
 * - session:started / session:stopped remain one publish per session
 */

import { describe, it, expect, vi } from 'vitest';
import type { ActiveSession } from '@tracearr/shared';

const mockDbSelect = vi.fn();

vi.mock('../../../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

vi.mock('../../../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

import { processPollResults } from '../sessionLifecycle.js';

function makeSession(id: string, overrides: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id,
    serverId: 'server-1',
    serverUserId: 'server-user-1',
    sessionKey: `key-${id}`,
    ...overrides,
  } as ActiveSession;
}

describe('processPollResults', () => {
  it('publishes exactly one session:updated for a tick with multiple updated sessions', async () => {
    const updatedSessions = [makeSession('s1'), makeSession('s2'), makeSession('s3')];
    const cacheService = {
      incrementalSyncActiveSessions: vi.fn(),
      addUserSession: vi.fn(),
      removeUserSession: vi.fn(),
    };
    const pubSubService = { publish: vi.fn() };
    const enqueueNotification = vi.fn();

    await processPollResults({
      newSessions: [],
      stoppedKeys: [],
      updatedSessions,
      watchedTransitionOccurred: false,
      cachedSessions: [],
      cacheService,
      pubSubService,
      enqueueNotification,
    });

    const updatedPublishes = pubSubService.publish.mock.calls.filter(
      ([event]) => event === 'session:updated'
    );
    expect(updatedPublishes).toHaveLength(1);
    expect(updatedPublishes[0]?.[1]).toBe(updatedSessions[0]);
  });

  it('does not publish session:updated when nothing was updated', async () => {
    const cacheService = {
      incrementalSyncActiveSessions: vi.fn(),
      addUserSession: vi.fn(),
      removeUserSession: vi.fn(),
    };
    const pubSubService = { publish: vi.fn() };

    await processPollResults({
      newSessions: [],
      stoppedKeys: [],
      updatedSessions: [],
      watchedTransitionOccurred: false,
      cachedSessions: [],
      cacheService,
      pubSubService,
      enqueueNotification: vi.fn(),
    });

    expect(pubSubService.publish.mock.calls.some(([event]) => event === 'session:updated')).toBe(
      false
    );
  });

  it('still publishes one session:started per new session', async () => {
    const newSessions = [makeSession('new-1'), makeSession('new-2')];
    const cacheService = {
      incrementalSyncActiveSessions: vi.fn(),
      addUserSession: vi.fn(),
      removeUserSession: vi.fn(),
    };
    const pubSubService = { publish: vi.fn() };
    const enqueueNotification = vi.fn();

    await processPollResults({
      newSessions,
      stoppedKeys: [],
      updatedSessions: [],
      watchedTransitionOccurred: false,
      cachedSessions: [],
      cacheService,
      pubSubService,
      enqueueNotification,
    });

    const startedPublishes = pubSubService.publish.mock.calls.filter(
      ([event]) => event === 'session:started'
    );
    expect(startedPublishes).toHaveLength(2);
    expect(enqueueNotification).toHaveBeenCalledTimes(2);
  });

  it('skips the session:started publish and notification for sessions confirmed from a pending entry', async () => {
    const newSessions = [makeSession('fresh-1'), makeSession('confirmed-1')];
    const cacheService = {
      incrementalSyncActiveSessions: vi.fn(),
      addUserSession: vi.fn(),
      removeUserSession: vi.fn(),
    };
    const pubSubService = { publish: vi.fn() };
    const enqueueNotification = vi.fn();

    await processPollResults({
      newSessions,
      stoppedKeys: [],
      updatedSessions: [],
      watchedTransitionOccurred: false,
      cachedSessions: [],
      cacheService,
      pubSubService,
      enqueueNotification,
      confirmedFromPendingIds: new Set(['confirmed-1']),
    });

    const startedPublishes = pubSubService.publish.mock.calls.filter(
      ([event]) => event === 'session:started'
    );
    expect(startedPublishes).toHaveLength(1);
    expect(startedPublishes[0]?.[1]).toBe(newSessions[0]);
    expect(enqueueNotification).toHaveBeenCalledTimes(1);
  });

  it('still publishes one session:stopped per stopped session', async () => {
    mockDbSelect.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ durationMs: 12345 }]),
      }),
    });

    const cachedSessions = [makeSession('stopped-1'), makeSession('stopped-2')];
    const cacheService = {
      incrementalSyncActiveSessions: vi.fn(),
      addUserSession: vi.fn(),
      removeUserSession: vi.fn(),
    };
    const pubSubService = { publish: vi.fn() };
    const enqueueNotification = vi.fn();

    await processPollResults({
      newSessions: [],
      stoppedKeys: ['server-1:key-stopped-1', 'server-1:key-stopped-2'],
      updatedSessions: [],
      watchedTransitionOccurred: false,
      cachedSessions,
      cacheService,
      pubSubService,
      enqueueNotification,
    });

    const stoppedPublishes = pubSubService.publish.mock.calls.filter(
      ([event]) => event === 'session:stopped'
    );
    expect(stoppedPublishes).toHaveLength(2);
  });
});
