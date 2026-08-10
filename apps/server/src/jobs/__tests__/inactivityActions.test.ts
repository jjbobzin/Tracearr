/**
 * Inactivity Action Execution Tests
 *
 * Inactivity violations have no session, so kill_stream and message_client
 * must record a skipped result while notify, trust, and log actions run
 * through the shared executor deps with per-action-type cooldown keys.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RuleActions } from '@tracearr/shared';

const { mockStoreActionResults } = vi.hoisted(() => ({
  mockStoreActionResults: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/rules/v2Integration.js', () => ({
  storeActionResults: mockStoreActionResults,
}));

import { executeInactivityActions } from '../inactivityCheckQueue.js';
import {
  setActionExecutorDeps,
  resetActionExecutorDeps,
  type ActionExecutorDeps,
} from '../../services/rules/executors/index.js';

const target = {
  serverUserId: 'su-jf-1',
  username: 'dormant_dave',
  displayName: 'Dormant Dave',
  serverId: 'server-jf',
  thumbUrl: null,
};

const baseRule = (actions: RuleActions['actions']) => ({
  id: 'rule-inactive-1',
  name: 'Inactive 30 days',
  actions: { actions },
});

function createMockDeps(): ActionExecutorDeps {
  return {
    logAudit: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    adjustUserTrust: vi.fn().mockResolvedValue(undefined),
    setUserTrust: vi.fn().mockResolvedValue(undefined),
    resetUserTrust: vi.fn().mockResolvedValue(undefined),
    terminateSession: vi.fn().mockResolvedValue(undefined),
    sendClientMessage: vi.fn().mockResolvedValue(undefined),
    checkCooldown: vi.fn().mockResolvedValue(false),
    setCooldown: vi.fn().mockResolvedValue(undefined),
    queueForConfirmation: vi.fn().mockResolvedValue(undefined),
  };
}

describe('executeInactivityActions', () => {
  let deps: ActionExecutorDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    setActionExecutorDeps(deps);
  });

  afterEach(() => {
    resetActionExecutorDeps();
  });

  it('sends notify with the account payload and skips kill_stream', async () => {
    await executeInactivityActions(
      baseRule([{ type: 'notify', channels: ['discord', 'push'] }, { type: 'kill_stream' }]),
      target,
      'violation-1',
      { inactiveDays: 45, thresholdDays: 30, neverActive: false }
    );

    expect(deps.sendNotification).toHaveBeenCalledWith({
      channels: ['discord', 'push'],
      title: 'Rule Triggered: Inactive 30 days',
      message: 'Account "dormant_dave" has been inactive for 45 days',
      data: {
        ruleId: 'rule-inactive-1',
        serverUserId: 'su-jf-1',
        username: 'dormant_dave',
        displayName: 'Dormant Dave',
        serverId: 'server-jf',
        userThumbUrl: null,
      },
    });
    expect(deps.terminateSession).not.toHaveBeenCalled();

    expect(mockStoreActionResults).toHaveBeenCalledTimes(1);
    const [violationId, ruleId, results] = mockStoreActionResults.mock.calls[0]!;
    expect(violationId).toBe('violation-1');
    expect(ruleId).toBe('rule-inactive-1');
    expect(results[0]).toMatchObject({ success: true, message: 'Executed notify' });
    expect(results[1]).toMatchObject({
      success: true,
      skipped: true,
      skipReason: 'No active session for an inactivity violation',
    });
  });

  it('words the message for never-active accounts', async () => {
    await executeInactivityActions(
      baseRule([{ type: 'notify', channels: ['webhook'] }]),
      target,
      'violation-2',
      { inactiveDays: null, neverActive: true }
    );

    expect(deps.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Account "dormant_dave" has never been active',
      })
    );
  });

  it('keys cooldowns per action type and lets other actions run', async () => {
    (deps.checkCooldown as ReturnType<typeof vi.fn>).mockImplementation(
      (_ruleId: string, targetId: string) => targetId.endsWith(':notify')
    );

    await executeInactivityActions(
      baseRule([
        { type: 'notify', channels: ['discord'], cooldown_minutes: 60 },
        { type: 'adjust_trust', amount: -10 },
      ]),
      target,
      'violation-3',
      { inactiveDays: 45, neverActive: false }
    );

    expect(deps.checkCooldown).toHaveBeenCalledWith(
      'rule-inactive-1',
      'rule-inactive-1:su-jf-1:notify',
      60
    );
    expect(deps.sendNotification).not.toHaveBeenCalled();
    expect(deps.adjustUserTrust).toHaveBeenCalledWith('su-jf-1', -10);

    const results = mockStoreActionResults.mock.calls[0]![2];
    expect(results[0]).toMatchObject({ skipped: true, skipReason: 'On cooldown (60 minutes)' });
    expect(results[1]).toMatchObject({ success: true, message: 'Executed adjust_trust' });
  });

  it('arms the cooldown with the action-type key after executing', async () => {
    await executeInactivityActions(
      baseRule([{ type: 'notify', channels: ['discord'], cooldown_minutes: 30 }]),
      target,
      'violation-4',
      { inactiveDays: 45, neverActive: false }
    );

    expect(deps.setCooldown).toHaveBeenCalledWith(
      'rule-inactive-1',
      'rule-inactive-1:su-jf-1:notify',
      30
    );
  });

  it('runs trust and log actions against the account', async () => {
    await executeInactivityActions(
      baseRule([
        { type: 'set_trust', value: 20 },
        { type: 'reset_trust' },
        { type: 'log_only', message: 'dormant account seen' },
      ]),
      target,
      'violation-5',
      { inactiveDays: 45, neverActive: false }
    );

    expect(deps.setUserTrust).toHaveBeenCalledWith('su-jf-1', 20);
    expect(deps.resetUserTrust).toHaveBeenCalledWith('su-jf-1');
    expect(deps.logAudit).toHaveBeenCalledWith({
      sessionId: null,
      serverUserId: 'su-jf-1',
      serverId: 'server-jf',
      ruleId: 'rule-inactive-1',
      ruleName: 'Inactive 30 days',
      message: 'dormant account seen',
      details: { inactiveDays: 45, neverActive: false },
    });
  });

  it('records a failure without aborting later actions', async () => {
    (deps.sendNotification as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('discord webhook 500')
    );

    await executeInactivityActions(
      baseRule([
        { type: 'notify', channels: ['discord'] },
        { type: 'adjust_trust', amount: -5 },
      ]),
      target,
      'violation-6',
      { inactiveDays: 45, neverActive: false }
    );

    expect(deps.adjustUserTrust).toHaveBeenCalledWith('su-jf-1', -5);
    const results = mockStoreActionResults.mock.calls[0]![2];
    expect(results[0]).toMatchObject({ success: false, message: 'discord webhook 500' });
    expect(results[1]).toMatchObject({ success: true });
  });

  it('does nothing when the rule has no actions', async () => {
    await executeInactivityActions({ ...baseRule([]), actions: null }, target, 'violation-7', {});

    expect(mockStoreActionResults).not.toHaveBeenCalled();
    expect(deps.sendNotification).not.toHaveBeenCalled();
  });
});
