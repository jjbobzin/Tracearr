/**
 * Inactivity Check Queue - BullMQ-based periodic account inactivity checking
 *
 * Monitors user accounts for periods of no activity and creates violations
 * when accounts have been inactive for configurable time periods.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { getRedisPrefix } from '@tracearr/shared';
import type { Redis } from 'ioredis';
import { isMaintenance } from '../serverState.js';
import { eq, and, isNull } from 'drizzle-orm';
import type {
  AccountInactivityParams,
  ViolationWithDetails,
  RuleConditions,
  Operator,
} from '@tracearr/shared';
import { WS_EVENTS, TIME_MS, INACTIVITY_COMPATIBLE_FIELDS } from '@tracearr/shared';
import { db } from '../db/client.js';
import { rules, serverUsers, violations, users, servers } from '../db/schema.js';
import { ruleEngine } from '../services/rules.js';
import { compare } from '../services/rules/comparisons.js';
import { batchGetIdentityServerUserIds } from './poller/database.js';
import {
  getActionExecutorDeps,
  cooldownTargetId,
  type ActionResult,
} from '../services/rules/executors/index.js';
import { storeActionResults } from '../services/rules/v2Integration.js';
import { recomputeIdentityAggregatesForServerUser } from '../services/userService.js';
import { enqueueNotification } from './notificationQueue.js';

// Queue name
const QUEUE_NAME = 'inactivity-check';

// Fixed check interval (1 hour)
const CHECK_INTERVAL_MS = TIME_MS.HOUR;

// Startup delay before first check (5 minutes) - allows server to fully initialize
const STARTUP_DELAY_MS = 5 * TIME_MS.MINUTE;

// Job types
interface InactivityCheckJobData {
  type: 'check';
  ruleId?: string; // If set, only check this specific rule
}

/**
 * Check if V2 rule conditions contain an inactive_days field.
 */
export function hasInactivityCondition(conditions: RuleConditions | null): boolean {
  if (!conditions?.groups) return false;
  return conditions.groups.some((group) =>
    group.conditions.some((c) => c.field === 'inactive_days')
  );
}

/**
 * Extract the inactive_days threshold and operator from V2 conditions.
 * Returns the value and operator of the first inactive_days condition found, or null.
 */
export function extractInactiveDaysFromConditions(
  conditions: RuleConditions | null
): { value: number; operator: Operator } | null {
  if (!conditions?.groups) return null;
  for (const group of conditions.groups) {
    for (const c of group.conditions) {
      if (c.field === 'inactive_days' && typeof c.value === 'number') {
        return { value: c.value, operator: c.operator };
      }
    }
  }
  return null;
}

/**
 * True when some group can never match in this worker because every condition
 * in it needs a session. Groups AND together, so one such group makes the
 * whole rule unmatchable here.
 */
export function hasSessionOnlyGroup(conditions: RuleConditions): boolean {
  const compatible = INACTIVITY_COMPATIBLE_FIELDS as readonly string[];
  return conditions.groups.some((group) =>
    group.conditions.every((c) => !compatible.includes(c.field))
  );
}

/**
 * Evaluate a rule's conditions for a dormant account. Mirrors engine.ts
 * semantics: groups AND together, conditions within a group OR together.
 * Session-only fields cannot match without a session and evaluate false.
 * inactiveDays is null for never-active accounts; each inactive_days leaf
 * compares with its OWN operator and threshold, since a band rule like
 * "gte 30 AND lte 60" has two leaves that must not share one result.
 */
export function evaluateUserLevelConditions(
  conditions: RuleConditions,
  user: { id: string; serverId: string; trustScore: number; createdAt: Date },
  inactiveDays: number | null,
  identityServerUserIds: readonly string[] = []
): boolean {
  return conditions.groups.every((group) =>
    group.conditions.some((c) => {
      switch (c.field) {
        case 'inactive_days': {
          // Never-active semantics match evaluateAccountInactivity: infinite
          // inactivity satisfies gte/gt/neq, never eq/lt/lte.
          if (inactiveDays === null) {
            return c.operator === 'gte' || c.operator === 'gt' || c.operator === 'neq';
          }
          return compare(inactiveDays, c.operator, c.value);
        }
        case 'server_id':
          return compare(user.serverId, c.operator, c.value);
        case 'user_id': {
          // Person semantics, mirroring evaluateUserId: the stored value is a
          // representative account id, so membership in this account's
          // identity is the match, not id equality.
          const identityIds = new Set(identityServerUserIds);
          identityIds.add(user.id);
          const values = Array.isArray(c.value) ? c.value : [c.value];
          const anyMember = values.some((v) => typeof v === 'string' && identityIds.has(v));
          return c.operator === 'neq' || c.operator === 'not_in' ? !anyMember : anyMember;
        }
        case 'trust_score':
          return compare(user.trustScore, c.operator, c.value);
        case 'account_age_days': {
          const ageDays = Math.floor((Date.now() - user.createdAt.getTime()) / TIME_MS.DAY);
          return compare(ageDays, c.operator, c.value);
        }
        default:
          return false;
      }
    })
  );
}

// Connection options (set during initialization)
let connectionOptions: ConnectionOptions | null = null;

// Queue and worker instances
let inactivityQueue: Queue<InactivityCheckJobData> | null = null;
let inactivityWorker: Worker<InactivityCheckJobData> | null = null;

// Redis client reference (kept for potential future use with caching)
let _redisClient: Redis | null = null;

// Pub/sub service for broadcasting violations
let pubSubPublish: ((event: string, data: unknown) => Promise<void>) | null = null;

/**
 * Initialize the inactivity check queue with Redis connection
 */
export function initInactivityCheckQueue(
  redisUrl: string,
  redis: Redis,
  publishFn: (event: string, data: unknown) => Promise<void>
): void {
  if (inactivityQueue) {
    console.log('[Inactivity] Queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  _redisClient = redis;
  pubSubPublish = publishFn;
  const bullPrefix = `${getRedisPrefix()}bull`;

  // Create the inactivity check queue
  inactivityQueue = new Queue<InactivityCheckJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10000, // 10s, 20s, 40s
      },
      removeOnComplete: {
        count: 50, // Keep last 50 for debugging
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 100,
        age: 7 * 24 * 60 * 60, // 7 days
      },
    },
  });
  inactivityQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[Inactivity] Queue error:', err);
  });

  console.log('[Inactivity] Queue initialized');
}

/**
 * Start the inactivity check worker
 */
export function startInactivityCheckWorker(): void {
  if (!connectionOptions) {
    throw new Error('Inactivity check queue not initialized. Call initInactivityCheckQueue first.');
  }

  if (inactivityWorker) {
    console.log('[Inactivity] Worker already running');
    return;
  }

  const bullPrefix = `${getRedisPrefix()}bull`;

  inactivityWorker = new Worker<InactivityCheckJobData>(
    QUEUE_NAME,
    async (job: Job<InactivityCheckJobData>) => {
      const startTime = Date.now();
      try {
        await processInactivityCheck(job);
        const duration = Date.now() - startTime;
        console.log(`[Inactivity] Job ${job.id} completed in ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[Inactivity] Job ${job.id} failed after ${duration}ms:`, error);
        throw error;
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1, // Only one check at a time to avoid DB contention
    }
  );

  inactivityWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[Inactivity] Worker error:', error);
  });

  console.log('[Inactivity] Worker started');
}

/**
 * Schedule inactivity checks based on active rules
 * Called on startup and when rules are created/updated/deleted
 */
export async function scheduleInactivityChecks(): Promise<void> {
  if (!inactivityQueue) {
    console.error('[Inactivity] Queue not initialized');
    return;
  }

  // Remove any existing job schedulers
  const schedulers = await inactivityQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    if (scheduler.id) {
      await inactivityQueue.removeJobScheduler(scheduler.id);
    }
  }

  // Get all active rules and filter for inactivity conditions in app code
  const candidateRules = await db
    .select({
      id: rules.id,
      conditions: rules.conditions,
    })
    .from(rules)
    .where(eq(rules.isActive, true));

  const activeRules = candidateRules.filter((r) => hasInactivityCondition(r.conditions));

  if (activeRules.length === 0) {
    console.log('[Inactivity] No active inactivity rules found');
    return;
  }

  // Schedule a single recurring job that checks all rules hourly
  await inactivityQueue.add(
    'scheduled-check',
    { type: 'check' },
    {
      repeat: {
        every: CHECK_INTERVAL_MS,
      },
      jobId: 'inactivity-check-repeatable',
    }
  );

  // Schedule a delayed startup check to allow server to fully initialize
  // This prevents false positives during server startup
  await inactivityQueue.add(
    'startup-check',
    { type: 'check' },
    {
      delay: STARTUP_DELAY_MS,
      jobId: `startup-${Date.now()}`,
    }
  );

  console.log(`[Inactivity] Scheduled hourly checks for ${activeRules.length} rule(s)`);
}

/**
 * Trigger an immediate inactivity check for all rules or a specific rule
 */
export async function triggerInactivityCheck(ruleId?: string): Promise<void> {
  if (!inactivityQueue) {
    console.error('[Inactivity] Queue not initialized');
    return;
  }

  await inactivityQueue.add(
    'manual-check',
    { type: 'check', ruleId },
    { jobId: `manual-${Date.now()}` }
  );
}

/**
 * Process an inactivity check job
 */
async function processInactivityCheck(job: Job<InactivityCheckJobData>): Promise<void> {
  console.log(`[Inactivity] Processing check (job ${job.id})`);

  // Get all active rules and filter for inactivity conditions
  const candidateRules = await db
    .select()
    .from(rules)
    .where(job.data.ruleId ? eq(rules.id, job.data.ruleId) : eq(rules.isActive, true));

  const activeRules = candidateRules.filter((r) => hasInactivityCondition(r.conditions));

  if (activeRules.length === 0) {
    console.log('[Inactivity] No active inactivity rules to check');
    return;
  }

  let totalViolations = 0;

  for (const rule of activeRules) {
    const inactivityCondition = extractInactiveDaysFromConditions(rule.conditions);
    if (inactivityCondition === null) {
      console.warn(
        `[Inactivity] Could not extract inactive_days from rule ${rule.name} (${rule.id}), skipping`
      );
      continue;
    }
    if (rule.conditions && hasSessionOnlyGroup(rule.conditions)) {
      console.warn(
        `[Inactivity] Rule ${rule.name} (${rule.id}) has a group of session-only conditions ` +
          `that can never match outside a session, skipping`
      );
      continue;
    }
    const params: AccountInactivityParams = {
      inactivityValue: inactivityCondition.value,
      inactivityUnit: 'days',
    };
    const { operator } = inactivityCondition;

    console.log(`[Inactivity] Checking rule: ${rule.name} (${rule.id})`);

    // Rule scope narrows the account set: per-account, per-server, or
    // per-identity. All three server types flow through here identically.
    const scopeFilters = [isNull(serverUsers.removedAt)];
    if (rule.serverUserId) {
      scopeFilters.push(eq(serverUsers.id, rule.serverUserId));
    }
    if (rule.serverId) {
      scopeFilters.push(eq(serverUsers.serverId, rule.serverId));
    }
    if (rule.userId) {
      scopeFilters.push(eq(serverUsers.userId, rule.userId));
    }

    const usersToCheck = await db
      .select({
        id: serverUsers.id,
        userId: serverUsers.userId,
        username: serverUsers.username,
        lastActivityAt: serverUsers.lastActivityAt,
        serverId: serverUsers.serverId,
        trustScore: serverUsers.trustScore,
        createdAt: serverUsers.createdAt,
      })
      .from(serverUsers)
      .where(and(...scopeFilters));

    console.log(`[Inactivity] Checking ${usersToCheck.length} users for rule ${rule.name}`);

    // user_id conditions use person semantics; one batched lookup per rule
    // resolves each account's identity siblings
    const identityIdsByUser = await batchGetIdentityServerUserIds([
      ...new Set(usersToCheck.map((u) => u.userId)),
    ]);

    for (const user of usersToCheck) {
      // Evaluate inactivity for this user, then the rule's remaining
      // user-level conditions (trust score, account age, server, user)
      const result = ruleEngine.evaluateAccountInactivity(user, params, operator);

      const inactiveDays = user.lastActivityAt
        ? Math.floor((Date.now() - user.lastActivityAt.getTime()) / TIME_MS.DAY)
        : null;
      const matched = rule.conditions
        ? evaluateUserLevelConditions(
            rule.conditions,
            user,
            inactiveDays,
            identityIdsByUser.get(user.userId) ?? []
          )
        : result.violated;

      if (matched && result.violated) {
        try {
          // Only create violation if no existing unacknowledged violation exists
          const shouldCreate = await shouldCreateViolation(user.id, rule.id);

          if (shouldCreate) {
            await createInactivityViolation(rule, user, result);
            totalViolations++;
          }
        } catch (error) {
          console.error(
            `[Inactivity] Failed to process violation for ${user.username} on rule ${rule.name}:`,
            error
          );
        }
      }
    }
  }

  console.log(`[Inactivity] Check complete. Created ${totalViolations} violations.`);
}

/**
 * Skip if any violation already exists for this user+rule. Dismissed rows are
 * soft-deleted and deliberately included: a dismissed inactivity violation
 * must never re-arm, or the hourly tick re-runs the rule's actions forever.
 */
async function shouldCreateViolation(serverUserId: string, ruleId: string): Promise<boolean> {
  const existing = await db
    .select({ id: violations.id })
    .from(violations)
    .where(and(eq(violations.serverUserId, serverUserId), eq(violations.ruleId, ruleId)))
    .limit(1);

  return existing.length === 0;
}

/**
 * Create an inactivity violation (no associated session)
 */
async function createInactivityViolation(
  rule: typeof rules.$inferSelect,
  user: { id: string; username: string; serverId: string },
  result: { severity: string; data: Record<string, unknown> }
): Promise<void> {
  // Insert violation without session reference
  const created = await db.transaction(async (tx) => {
    const insertedRows = await tx
      .insert(violations)
      .values({
        ruleId: rule.id,
        serverUserId: user.id,
        sessionId: null, // No session for inactivity violations
        severity: rule.severity as 'low' | 'warning' | 'high',
        ruleType: 'account_inactivity',
        data: result.data,
      })
      .onConflictDoNothing()
      .returning();

    const inserted = insertedRows[0];
    if (inserted) {
      await recomputeIdentityAggregatesForServerUser(user.id, tx);
    }
    return inserted;
  });

  if (!created) {
    console.log(`[Inactivity] Duplicate violation prevented for user ${user.username}`);
    return;
  }

  // Get user and server details for broadcasting
  const [details] = await db
    .select({
      userId: serverUsers.id,
      username: serverUsers.username,
      thumbUrl: serverUsers.thumbUrl,
      identityName: users.name,
      serverId: servers.id,
      serverName: servers.name,
      serverType: servers.type,
    })
    .from(serverUsers)
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .innerJoin(servers, eq(servers.id, serverUsers.serverId))
    .where(eq(serverUsers.id, user.id))
    .limit(1);

  if (!details) {
    console.warn(`[Inactivity] Could not find details for user ${user.id}`);
    return;
  }

  // Broadcast violation event
  if (pubSubPublish) {
    const violationWithDetails: ViolationWithDetails = {
      id: created.id,
      ruleId: created.ruleId,
      serverUserId: created.serverUserId,
      sessionId: created.sessionId,
      severity: created.severity,
      data: created.data,
      acknowledgedAt: created.acknowledgedAt,
      createdAt: created.createdAt,
      user: {
        id: details.userId,
        username: details.username,
        thumbUrl: details.thumbUrl,
        serverId: details.serverId,
        identityName: details.identityName,
      },
      rule: {
        id: rule.id,
        name: rule.name,
        type: rule.type,
      },
      server: {
        id: details.serverId,
        name: details.serverName,
        type: details.serverType,
      },
    };

    await pubSubPublish(WS_EVENTS.VIOLATION_NEW, violationWithDetails);
    console.log(`[Inactivity] Violation created: ${rule.name} for user ${details.username}`);

    // Enqueue notification for async dispatch (Discord, webhooks, push)
    await enqueueNotification({ type: 'violation', payload: violationWithDetails });
  }

  await executeInactivityActions(
    rule,
    {
      serverUserId: details.userId,
      username: details.username,
      displayName: details.identityName ?? details.username,
      serverId: details.serverId,
      thumbUrl: details.thumbUrl,
    },
    created.id,
    result.data
  );
}

/**
 * Run the rule's configured actions for an inactivity violation. There is no
 * session, so session-bound actions (kill_stream, message_client) record a
 * skipped result instead of executing; the rest go through the same executor
 * deps and per-action-type cooldown keys as the session path
 * (services/rules/executors/index.ts).
 */
export async function executeInactivityActions(
  rule: Pick<typeof rules.$inferSelect, 'id' | 'name' | 'actions'>,
  target: {
    serverUserId: string;
    username: string;
    displayName: string;
    serverId: string;
    thumbUrl: string | null;
  },
  violationId: string,
  data: Record<string, unknown>
): Promise<void> {
  const actions = rule.actions?.actions ?? [];
  if (actions.length === 0) return;

  const deps = getActionExecutorDeps();
  const results: ActionResult[] = [];

  for (const action of actions) {
    if (action.type === 'kill_stream' || action.type === 'message_client') {
      results.push({
        action,
        success: true,
        skipped: true,
        skipReason: 'No active session for an inactivity violation',
      });
      continue;
    }

    const cooldownMinutes =
      'cooldown_minutes' in action && typeof action.cooldown_minutes === 'number'
        ? action.cooldown_minutes
        : undefined;
    const targetId = cooldownTargetId(rule.id, target.serverUserId, action.type);

    if (cooldownMinutes && cooldownMinutes > 0) {
      const onCooldown = await deps.checkCooldown(rule.id, targetId, cooldownMinutes);
      if (onCooldown) {
        results.push({
          action,
          success: true,
          skipped: true,
          skipReason: `On cooldown (${cooldownMinutes} minutes)`,
        });
        continue;
      }
    }

    try {
      switch (action.type) {
        case 'notify': {
          if (action.channels.length > 0) {
            const message = data.neverActive
              ? `Account "${target.username}" has never been active`
              : `Account "${target.username}" has been inactive for ${String(data.inactiveDays)} days`;
            await deps.sendNotification({
              channels: action.channels,
              title: `Rule Triggered: ${rule.name}`,
              message,
              data: {
                ruleId: rule.id,
                serverUserId: target.serverUserId,
                username: target.username,
                displayName: target.displayName,
                serverId: target.serverId,
                userThumbUrl: target.thumbUrl,
              },
            });
          }
          break;
        }
        case 'adjust_trust':
          if (action.amount !== 0) {
            await deps.adjustUserTrust(target.serverUserId, action.amount);
          }
          break;
        case 'set_trust':
          await deps.setUserTrust(target.serverUserId, action.value);
          break;
        case 'reset_trust':
          await deps.resetUserTrust(target.serverUserId);
          break;
        case 'log_only':
          await deps.logAudit({
            sessionId: null,
            serverUserId: target.serverUserId,
            serverId: target.serverId,
            ruleId: rule.id,
            ruleName: rule.name,
            message: action.message,
            details: data,
          });
          break;
      }

      results.push({ action, success: true, message: `Executed ${action.type}` });

      if (cooldownMinutes && cooldownMinutes > 0) {
        await deps.setCooldown(rule.id, targetId, cooldownMinutes);
      }
    } catch (error) {
      results.push({
        action,
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  await storeActionResults(violationId, rule.id, results);
}

/**
 * Gracefully shutdown the inactivity check queue and worker
 */
export async function shutdownInactivityCheckQueue(): Promise<void> {
  console.log('[Inactivity] Shutting down queue...');

  if (inactivityWorker) {
    await inactivityWorker.close();
    inactivityWorker = null;
  }

  if (inactivityQueue) {
    await inactivityQueue.close();
    inactivityQueue = null;
  }

  _redisClient = null;
  pubSubPublish = null;

  console.log('[Inactivity] Queue shutdown complete');
}

/**
 * Get the inactivity check queue instance (for testing or external scheduling)
 */
export function getInactivityQueue(): Queue<InactivityCheckJobData> | null {
  return inactivityQueue;
}

/**
 * Get queue statistics for the inactivity check queue
 */
export async function getInactivityCheckQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  schedule: string | null;
} | null> {
  if (!inactivityQueue) return null;

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    inactivityQueue.getWaitingCount(),
    inactivityQueue.getActiveCount(),
    inactivityQueue.getCompletedCount(),
    inactivityQueue.getFailedCount(),
    inactivityQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed, schedule: `every ${CHECK_INTERVAL_MS}ms` };
}
