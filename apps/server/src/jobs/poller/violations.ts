/**
 * Violation Handling
 *
 * Broadcasting for violations created inside session lifecycle transactions.
 */

import { eq } from 'drizzle-orm';
import type { Rule, ViolationWithDetails, RuleType } from '@tracearr/shared';
import { WS_EVENTS } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { servers, serverUsers, sessions, users } from '../../db/schema.js';
import type { violations } from '../../db/schema.js';
import type { PubSubService } from '../../services/cache.js';
import { enqueueNotification } from '../notificationQueue.js';

// ============================================================================
// Transaction-Aware Violation Creation
// ============================================================================

/**
 * Minimal rule info needed for violation broadcasting.
 * Supports both V1 (legacy) and V2 rules.
 */
export interface ViolationRuleInfo {
  id: string;
  name: string;
  type: RuleType | null; // null for V2 rules
}

/**
 * Result of creating a violation within a transaction.
 * Contains data needed for post-transaction broadcasting.
 */
export interface ViolationInsertResult {
  violation: typeof violations.$inferSelect;
  rule: Rule | ViolationRuleInfo;
}

/**
 * Broadcast violation events after transaction has committed.
 * Call this AFTER the transaction to ensure data is persisted before broadcasting.
 *
 * @param violationResults - Array of violation insert results
 * @param sessionId - Session ID for fetching server details
 * @param pubSubService - PubSub service for WebSocket broadcast
 */
export async function broadcastViolations(
  violationResults: ViolationInsertResult[],
  sessionId: string,
  pubSubService: PubSubService | null
): Promise<void> {
  if (!pubSubService || violationResults.length === 0) return;

  // Get server user and server details for the violation broadcast (single query for all)
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
    .from(sessions)
    .innerJoin(serverUsers, eq(serverUsers.id, sessions.serverUserId))
    .innerJoin(users, eq(serverUsers.userId, users.id))
    .innerJoin(servers, eq(servers.id, sessions.serverId))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!details) return;

  for (const { violation, rule } of violationResults) {
    // Get rule type - null for V2 rules
    const ruleType = 'type' in rule ? rule.type : null;

    const violationWithDetails: ViolationWithDetails = {
      id: violation.id,
      ruleId: violation.ruleId,
      serverUserId: violation.serverUserId,
      sessionId: violation.sessionId,
      severity: violation.severity,
      data: violation.data,
      acknowledgedAt: violation.acknowledgedAt,
      createdAt: violation.createdAt,
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
        type: ruleType,
      },
      server: {
        id: details.serverId,
        name: details.serverName,
        type: details.serverType,
      },
    };

    await pubSubService.publish(WS_EVENTS.VIOLATION_NEW, violationWithDetails);
    console.log(`[Poller] Violation broadcast: ${rule.name} for user ${details.username}`);

    // Enqueue notification for async dispatch (Discord, webhooks, push)
    await enqueueNotification({ type: 'violation', payload: violationWithDetails });
  }
}
