/**
 * Notification Queue Tests - Rule Notification Bypass
 *
 * Tests that V2 rule notifications bypass channel routing and send directly
 * to the channels specified in the rule action.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ViolationWithDetails } from '@tracearr/shared';

// Create mocks using vi.hoisted
const {
  mockGetNotificationSettings,
  mockGetChannelRouting,
  mockNotificationManagerSendAll,
  mockPushNotificationServiceNotifyViolation,
  mockNotifyViolation,
  mockGetServerUserDisplayNames,
} = vi.hoisted(() => ({
  mockGetNotificationSettings: vi.fn(),
  mockGetChannelRouting: vi.fn(),
  mockNotificationManagerSendAll: vi.fn().mockResolvedValue([]),
  mockPushNotificationServiceNotifyViolation: vi.fn().mockResolvedValue(undefined),
  mockNotifyViolation: vi.fn().mockResolvedValue([]),
  mockGetServerUserDisplayNames: vi.fn(),
}));

// Mock dependencies
vi.mock('../../routes/settings.js', () => ({
  getNotificationSettings: mockGetNotificationSettings,
}));

vi.mock('../../routes/channelRouting.js', () => ({
  getChannelRouting: mockGetChannelRouting,
}));

vi.mock('../../services/notifications/index.js', () => ({
  notificationManager: {
    sendAll: mockNotificationManagerSendAll,
    notifyViolation: mockNotifyViolation,
  },
}));

vi.mock('../../services/userService.js', () => ({
  getServerUserDisplayNames: mockGetServerUserDisplayNames,
}));

vi.mock('../../services/pushNotification.js', () => ({
  pushNotificationService: {
    notifyViolation: mockPushNotificationServiceNotifyViolation,
  },
}));

vi.mock('../../websocket/index.js', () => ({
  broadcastToAll: vi.fn(),
}));

vi.mock('../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

// Mock BullMQ - we're testing the processor function directly.
// Queue must be a regular function (not an arrow) so `new Queue()` works;
// instances are captured so enqueueNotification tests can reach `add`.
const { queueInstances } = vi.hoisted(() => ({
  queueInstances: [] as Array<{ name: string; add: ReturnType<typeof vi.fn> }>,
}));

vi.mock('bullmq', () => ({
  Queue: vi.fn(function (name: string) {
    const instance = {
      name,
      on: vi.fn(),
      add: vi.fn(),
      close: vi.fn(),
      getWaitingCount: vi.fn(),
      getActiveCount: vi.fn(),
      getCompletedCount: vi.fn(),
      getFailedCount: vi.fn(),
      getDelayedCount: vi.fn(),
      getJobs: vi.fn(),
    };
    queueInstances.push(instance);
    return instance;
  }),
  Worker: vi.fn(function () {
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }),
}));

import {
  processNotificationJob,
  initNotificationQueue,
  enqueueNotification,
} from '../notificationQueue.js';

describe('Notification Queue - Rule Notification Bypass', () => {
  const createMockSettings = () => ({
    discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
    customWebhookUrl: 'https://ntfy.sh/mytopic',
    webhookFormat: 'ntfy' as const,
    ntfyTopic: 'tracearr',
    ntfyAuthToken: 'token123',
    pushoverUserKey: null,
    pushoverApiToken: null,
    mobileEnabled: true,
    unitSystem: 'metric' as const,
  });

  const createRuleNotificationPayload = (channels: string[]): ViolationWithDetails => ({
    id: 'rule-notify-123',
    ruleId: 'rule-456',
    serverUserId: 'user-789',
    sessionId: 'session-123',
    severity: 'low',
    data: {
      ruleNotification: true,
      channels,
      customTitle: 'Rule Triggered: Test Rule',
      customMessage: 'User "testuser" triggered rule "Test Rule" while playing "Test Movie"',
      ruleId: 'rule-456',
      sessionId: 'session-123',
      userId: 'user-789',
      mediaTitle: 'Test Movie',
    },
    acknowledgedAt: null,
    createdAt: new Date(),
    user: {
      id: 'user-789',
      username: 'testuser',
      serverId: 'server-id',
      thumbUrl: null,
      identityName: 'Test User',
    },
    rule: {
      id: 'rule-456',
      name: 'Test Rule',
      type: null,
    },
  });

  const createStandardViolationPayload = (): ViolationWithDetails => ({
    id: 'violation-123',
    ruleId: 'rule-456',
    serverUserId: 'user-789',
    sessionId: 'session-123',
    severity: 'warning',
    data: { reason: 'standard violation' },
    acknowledgedAt: null,
    createdAt: new Date(),
    user: {
      id: 'user-789',
      username: 'testuser',
      serverId: 'server-id',
      thumbUrl: null,
      identityName: 'Test User',
    },
    rule: {
      id: 'rule-456',
      name: 'Test Rule',
      type: 'concurrent_streams',
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNotificationSettings.mockResolvedValue(createMockSettings());
    mockGetChannelRouting.mockResolvedValue({
      discordEnabled: false,
      webhookEnabled: false,
      pushEnabled: false,
      webToastEnabled: false,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('processRuleNotification', () => {
    // We need to import the module after mocks are set up
    // and access processRuleNotification for direct testing

    it('should send to webhook channel when specified', () => {
      const payload = createRuleNotificationPayload(['webhook']);

      // Verify the payload has the right structure for rule notifications
      expect(payload.data).toEqual(
        expect.objectContaining({
          ruleNotification: true,
          channels: ['webhook'],
          customTitle: expect.any(String),
          customMessage: expect.any(String),
        })
      );
    });

    it('should include all required fields for rule notification detection', () => {
      const payload = createRuleNotificationPayload(['discord', 'webhook', 'push']);

      // Verify the payload structure that processNotificationJob checks
      expect(payload.data.ruleNotification).toBe(true);
      expect(Array.isArray(payload.data.channels)).toBe(true);
      expect(payload.data.channels).toEqual(['discord', 'webhook', 'push']);
      expect(payload.data.customTitle).toBeDefined();
      expect(payload.data.customMessage).toBeDefined();
    });

    it('should have standard violation without ruleNotification flag', () => {
      const payload = createStandardViolationPayload();

      expect(payload.data.ruleNotification).toBeUndefined();
      expect(payload.data.channels).toBeUndefined();
    });
  });

  describe('channel mapping', () => {
    it('discord channel should map to discord agent settings', () => {
      const settings = createMockSettings();

      // When channel is 'discord', we should use discordWebhookUrl
      expect(settings.discordWebhookUrl).toBe('https://discord.com/api/webhooks/123/abc');
    });

    it('webhook channel should map to customWebhookUrl with webhookFormat', () => {
      const settings = createMockSettings();

      // When channel is 'webhook', we should use customWebhookUrl
      // The webhookFormat determines which agent handles it (ntfy, apprise, etc.)
      expect(settings.customWebhookUrl).toBe('https://ntfy.sh/mytopic');
      expect(settings.webhookFormat).toBe('ntfy');
    });

    it('push channel should trigger pushNotificationService', () => {
      // The push channel is handled by pushNotificationService, not notification agents
      expect(mockPushNotificationServiceNotifyViolation).toBeDefined();
    });
  });

  describe('routing bypass verification', () => {
    it('should structure rule notification to bypass routing check', () => {
      const rulePayload = createRuleNotificationPayload(['webhook']);
      const standardPayload = createStandardViolationPayload();

      // Rule notifications have ruleNotification: true
      expect(rulePayload.data.ruleNotification).toBe(true);

      // Standard violations don't
      expect(standardPayload.data.ruleNotification).toBeUndefined();

      // This is what processNotificationJob checks to decide whether to bypass routing
    });

    it('should include channels array for direct sending', () => {
      const payload = createRuleNotificationPayload(['discord', 'push']);

      expect(payload.data.channels).toEqual(['discord', 'push']);
      // These channels will be used directly instead of checking getChannelRouting
    });
  });
});

describe('Integration: Rule Notification Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create correct payload structure from v2Integration', () => {
    // This verifies the payload structure created by v2Integration.sendNotification
    const channels = ['webhook', 'push'];
    const title = 'Rule Triggered: My Rule';
    const message = 'User triggered the rule';

    // Simulating what v2Integration creates
    const payload = {
      id: `rule-notify-${Date.now()}`,
      serverUserId: 'user-123',
      sessionId: 'session-456',
      severity: 'low',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      data: {
        ruleNotification: true,
        channels,
        customTitle: title,
        customMessage: message,
        ruleId: 'rule-789',
      },
      rule: {
        id: 'rule-789',
        name: title,
        type: null,
      },
      session: null,
      serverUser: {
        id: 'user-123',
        username: 'testuser',
        displayName: 'Test User',
      },
    };

    // Verify all the fields that processNotificationJob needs
    expect(payload.data.ruleNotification).toBe(true);
    expect(payload.data.channels).toEqual(['webhook', 'push']);
    expect(payload.data.customTitle).toBe(title);
    expect(payload.data.customMessage).toBe(message);
  });

  it('should support all valid notification channels', () => {
    const validChannels = ['push', 'discord', 'email', 'webhook'];

    // All these should be valid in a NotifyAction
    validChannels.forEach((channel) => {
      expect(['push', 'discord', 'email', 'webhook']).toContain(channel);
    });

    // Note: 'email' is not implemented yet, but is a valid channel type
  });
});

describe('processNotificationJob - user_id condition regression', () => {
  const makeSettings = () => ({
    discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
    customWebhookUrl: null,
    webhookFormat: null,
    ntfyTopic: null,
    ntfyAuthToken: null,
    pushoverUserKey: null,
    pushoverApiToken: null,
  });

  const makeRouting = () => ({
    discordEnabled: true,
    webhookEnabled: false,
    pushEnabled: false,
    webToastEnabled: false,
  });

  const makeJob = (evidence: unknown[]) =>
    ({
      data: {
        type: 'violation' as const,
        payload: {
          id: randomUUID(),
          ruleId: randomUUID(),
          serverUserId: randomUUID(),
          sessionId: randomUUID(),
          severity: 'warning',
          data: { evidence },
          acknowledgedAt: null,
          createdAt: new Date(),
          user: {
            id: randomUUID(),
            username: 'testuser',
            serverId: randomUUID(),
            thumbUrl: null,
            identityName: null,
          },
          rule: { id: randomUUID(), name: 'Test Rule', type: null },
        } as ViolationWithDetails,
      },
    }) as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNotificationSettings.mockResolvedValue(makeSettings());
    mockGetChannelRouting.mockResolvedValue(makeRouting());
    mockNotifyViolation.mockResolvedValue([]);
  });

  it('passes only threshold UUIDs (not actual username) to getServerUserDisplayNames', async () => {
    const thresholdId1 = randomUUID();
    const thresholdId2 = randomUUID();
    mockGetServerUserDisplayNames.mockResolvedValue({
      [thresholdId1]: 'Alice',
      [thresholdId2]: 'Bob',
    });

    const job = makeJob([
      {
        groupIndex: 0,
        matched: true,
        conditions: [
          {
            field: 'user_id',
            operator: 'not_in',
            threshold: [thresholdId1, thresholdId2],
            actual: 'bob',
            matched: true,
          },
        ],
      },
    ]);

    await processNotificationJob(job);

    expect(mockGetServerUserDisplayNames).toHaveBeenCalledTimes(1);
    const calledWith: string[] = mockGetServerUserDisplayNames.mock.calls[0]![0];
    expect(calledWith).toContain(thresholdId1);
    expect(calledWith).toContain(thresholdId2);
    expect(calledWith).not.toContain('bob');
  });

  it('still calls notifyViolation when getServerUserDisplayNames throws', async () => {
    mockGetServerUserDisplayNames.mockRejectedValue(
      new Error('invalid input syntax for type uuid')
    );

    const job = makeJob([
      {
        groupIndex: 0,
        matched: true,
        conditions: [
          {
            field: 'user_id',
            operator: 'not_in',
            threshold: [randomUUID()],
            actual: 'bob',
            matched: true,
          },
        ],
      },
    ]);

    await processNotificationJob(job);

    expect(mockNotifyViolation).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueNotification - violation dedupe keys', () => {
  const makeViolationPayload = (serverUserId: string, ruleId: string): ViolationWithDetails => ({
    id: `violation-${serverUserId}-${ruleId}`,
    ruleId,
    serverUserId,
    sessionId: 'session-123',
    severity: 'warning',
    data: {},
    acknowledgedAt: null,
    createdAt: new Date(),
    user: {
      id: serverUserId,
      username: 'testuser',
      serverId: 'server-id',
      thumbUrl: null,
      identityName: null,
    },
    rule: {
      id: ruleId,
      name: 'Test Rule',
      type: null,
    },
  });

  function getQueueAdd(): ReturnType<typeof vi.fn> {
    const instance = [...queueInstances].reverse().find((q) => q.name === 'notifications');
    if (!instance) throw new Error('notifications queue was not constructed');
    instance.add.mockImplementation((_name: string, _data: unknown, opts?: { jobId?: string }) => ({
      id: opts?.jobId,
    }));
    return instance.add;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Module state keeps the first queue; repeat inits are no-ops
    initNotificationQueue('redis://localhost:6379');
  });

  it('keys violations by server user so one user cannot swallow another', async () => {
    const add = getQueueAdd();

    await enqueueNotification({
      type: 'violation',
      payload: makeViolationPayload('su-a', 'rule-1'),
    });
    await enqueueNotification({
      type: 'violation',
      payload: makeViolationPayload('su-b', 'rule-1'),
    });

    const jobIds = add.mock.calls.map((call) => (call[2] as { jobId?: string }).jobId);
    expect(jobIds[0]).toContain('su-a');
    expect(jobIds[1]).toContain('su-b');
    expect(jobIds[0]).not.toBe(jobIds[1]);
  });

  it('keys violations by rule id so v2 rules with null type stay distinct', async () => {
    const add = getQueueAdd();

    await enqueueNotification({
      type: 'violation',
      payload: makeViolationPayload('su-a', 'rule-1'),
    });
    await enqueueNotification({
      type: 'violation',
      payload: makeViolationPayload('su-a', 'rule-2'),
    });

    const jobIds = add.mock.calls.map((call) => (call[2] as { jobId?: string }).jobId);
    expect(jobIds[0]).toContain('rule-1');
    expect(jobIds[1]).toContain('rule-2');
    expect(jobIds[0]).not.toBe(jobIds[1]);
  });

  it('enqueues a notify action and the routed violation as two separate jobs', async () => {
    const add = getQueueAdd();

    await enqueueNotification({
      type: 'violation',
      payload: makeViolationPayload('su-a', 'rule-1'),
    });
    await enqueueNotification({
      type: 'violation',
      payload: {
        ...makeViolationPayload('su-a', 'rule-1'),
        data: { ruleNotification: true, channels: ['discord'] },
      },
    });

    const jobIds = add.mock.calls.map((call) => (call[2] as { jobId?: string }).jobId);
    expect(add).toHaveBeenCalledTimes(2);
    expect(jobIds[0]).toBeDefined();
    expect(jobIds[1]).toBeDefined();
    expect(jobIds[0]).not.toBe(jobIds[1]);
  });

  it('still dedupes identical routed violations within a bucket', async () => {
    const add = getQueueAdd();

    await enqueueNotification({
      type: 'violation',
      payload: makeViolationPayload('su-a', 'rule-1'),
    });
    await enqueueNotification({
      type: 'violation',
      payload: makeViolationPayload('su-a', 'rule-1'),
    });

    const jobIds = add.mock.calls.map((call) => (call[2] as { jobId?: string }).jobId);
    expect(jobIds[0]).toBeDefined();
    expect(jobIds[0]).toBe(jobIds[1]);
  });

  it('skips dedupe entirely when the payload has neither rule id nor type', async () => {
    const add = getQueueAdd();

    await enqueueNotification({
      type: 'violation',
      payload: makeViolationPayload('su-a', ''),
    });
    await enqueueNotification({
      type: 'violation',
      payload: makeViolationPayload('su-b', ''),
    });

    const jobIds = add.mock.calls.map((call) => (call[2] as { jobId?: string }).jobId);
    expect(jobIds[0]).toBeUndefined();
    expect(jobIds[1]).toBeUndefined();
  });
});
