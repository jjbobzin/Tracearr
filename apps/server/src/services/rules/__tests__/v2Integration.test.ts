/**
 * V2 Integration Tests - Notification Payload
 *
 * The notify executor passes the triggering account in params.data. The
 * violation-like payload built here must carry those values through to the
 * queue: the dedupe key reads payload.serverUserId and payload.rule.id, and
 * formatters read payload.user. A payload built from defaults collapses every
 * rule notification into one dedupe bucket attributed to "System".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

const { mockEnqueueNotification } = vi.hoisted(() => ({
  mockEnqueueNotification: vi.fn().mockResolvedValue('job-1'),
}));

vi.mock('../../../jobs/notificationQueue.js', () => ({
  enqueueNotification: mockEnqueueNotification,
}));

vi.mock('../../../db/client.js', () => ({ db: {} }));

vi.mock('../../../jobs/poller/database.js', () => ({
  invalidateRulesCache: vi.fn(),
}));

vi.mock('../../userService.js', () => ({
  recomputeIdentityAggregates: vi.fn(),
}));

import { createActionExecutorDeps } from '../v2Integration.js';

describe('createActionExecutorDeps - sendNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries the triggering account and rule into the violation payload', async () => {
    const deps = createActionExecutorDeps({} as unknown as Redis);

    await deps.sendNotification({
      channels: ['discord', 'push'],
      title: 'Rule Triggered: Sharing',
      message: 'User "alice" triggered rule "Sharing"',
      data: {
        ruleId: 'rule-1',
        sessionId: 'sess-1',
        serverUserId: 'su-1',
        username: 'alice',
        displayName: 'Alice',
        serverId: 'srv-1',
      },
    });

    expect(mockEnqueueNotification).toHaveBeenCalledTimes(1);
    const arg = mockEnqueueNotification.mock.calls[0]![0];
    expect(arg.type).toBe('violation');
    expect(arg.payload.serverUserId).toBe('su-1');
    expect(arg.payload.sessionId).toBe('sess-1');
    expect(arg.payload.rule.id).toBe('rule-1');
    expect(arg.payload.rule.type).toBeNull();
    expect(arg.payload.user).toMatchObject({
      id: 'su-1',
      username: 'alice',
      identityName: 'Alice',
    });
    expect(arg.payload.data).toMatchObject({
      ruleNotification: true,
      channels: ['discord', 'push'],
      customTitle: 'Rule Triggered: Sharing',
      customMessage: 'User "alice" triggered rule "Sharing"',
    });
  });

  it('falls back to safe defaults when data is missing', async () => {
    const deps = createActionExecutorDeps({} as unknown as Redis);

    await deps.sendNotification({
      channels: ['webhook'],
      title: 'Rule Triggered: Orphan',
      message: 'no data',
    });

    expect(mockEnqueueNotification).toHaveBeenCalledTimes(1);
    const arg = mockEnqueueNotification.mock.calls[0]![0];
    expect(arg.payload.serverUserId).toBe('');
    expect(arg.payload.user.username).toBe('System');
  });
});
