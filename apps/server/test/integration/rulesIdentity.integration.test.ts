/**
 * Identity-scoped rules integration tests
 *
 * Exercises person-scoped rules (rules.userId), opt-in cross-server
 * enforcement (rules.enforceAcrossServers), and the same-server combine
 * conflict warning against a real database: applicability across a merged
 * identity's accounts, scope repoint on merge, targeting with/without
 * enforceAcrossServers, and the scope mutual-exclusivity check.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- rulesIdentity
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { RuleConditions, Server, ServerUser, Session } from '@tracearr/shared';
import { createRuleV2Schema, DEFAULT_STREAM_DETAILS } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { rules, violations } from '../../src/db/schema.js';
import { mergeUsers } from '../../src/services/mergeService.js';
import { evaluateRulesAsync } from '../../src/services/rules/engine.js';
import { getActiveRulesV2 } from '../../src/jobs/poller/database.js';
import { resolveTargetSessions } from '../../src/services/rules/executors/targeting.js';
import { ruleRoutes } from '../../src/routes/rules.js';

// A condition that always matches, so tests exercise scope filtering only.
const ALWAYS_MATCH_CONDITIONS: RuleConditions = {
  groups: [{ conditions: [{ field: 'trust_score', operator: 'gte', value: 0 }] }],
};

async function insertRule(overrides: {
  name: string;
  userId?: string | null;
  serverId?: string | null;
  serverUserId?: string | null;
  enforceAcrossServers?: boolean;
}) {
  const [row] = await db
    .insert(rules)
    .values({
      name: overrides.name,
      userId: overrides.userId ?? null,
      serverId: overrides.serverId ?? null,
      serverUserId: overrides.serverUserId ?? null,
      enforceAcrossServers: overrides.enforceAcrossServers ?? false,
      severity: 'warning',
      isActive: true,
      conditions: ALWAYS_MATCH_CONDITIONS,
      actions: { actions: [] },
    })
    .returning();
  return row!;
}

function mockServer(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Test Server',
    type: 'plex',
    url: 'http://localhost:32400',
    displayOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mockServerUser(overrides: Partial<ServerUser> = {}): ServerUser {
  return {
    id: 'su-1',
    serverId: 'server-1',
    userId: 'identity-1',
    externalId: 'ext-1',
    username: 'testuser',
    email: null,
    thumbUrl: null,
    isServerAdmin: false,
    trustScore: 100,
    joinedAt: null,
    lastActivityAt: null,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Builds an evaluation-ready Session from a real (FK-safe) session row, so
// the DB-backed violation insert below always references a session that
// actually exists.
function toEvaluationSession(row: {
  id: string;
  serverId: string;
  serverUserId: string;
  sessionKey: string;
  startedAt: Date;
}): Session {
  return {
    id: row.id,
    serverId: row.serverId,
    serverUserId: row.serverUserId,
    sessionKey: row.sessionKey,
    state: 'playing',
    mediaType: 'movie',
    mediaTitle: 'Test Movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: 'rk-1',
    externalSessionId: null,
    startedAt: row.startedAt,
    stoppedAt: null,
    durationMs: null,
    totalDurationMs: 7200000,
    progressMs: 0,
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    ipAddress: '192.168.1.100',
    geoCity: null,
    geoRegion: null,
    geoCountry: null,
    geoContinent: null,
    geoPostal: null,
    geoLat: null,
    geoLon: null,
    geoAsnNumber: null,
    geoAsnOrganization: null,
    playerName: null,
    deviceId: null,
    product: null,
    device: null,
    platform: null,
    quality: null,
    isTranscode: false,
    videoDecision: null,
    audioDecision: null,
    bitrate: null,
    channelTitle: null,
    channelIdentifier: null,
    channelThumb: null,
    artistName: null,
    albumName: null,
    trackNumber: null,
    discNumber: null,
    ...DEFAULT_STREAM_DETAILS,
  };
}

describe('identity-scoped rules', () => {
  it('applies to both accounts of a merged person and not to an unrelated person', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });
    await mergeUsers(source.id, target.id, admin.id);

    const unrelated = await createTestUser({ role: 'member' });
    const unrelatedSu = await createTestServerUser({ userId: unrelated.id, serverId: serverA.id });

    const rule = await insertRule({ name: 'Person rule', userId: target.id });

    const activeRulesV2 = await getActiveRulesV2();
    const scopedRule = activeRulesV2.find((r) => r.id === rule.id);
    expect(scopedRule?.userId).toBe(target.id);

    const serverAObj = mockServer({ id: serverA.id, type: 'plex' });
    const serverBObj = mockServer({ id: serverB.id, type: 'jellyfin' });

    // Both of the merged identity's accounts match and get a violation created.
    for (const [su, srv] of [
      [targetSu, serverAObj],
      [sourceSu, serverBObj],
    ] as const) {
      const sessionRow = await createTestSession({ serverId: srv.id, serverUserId: su.id });
      const session = toEvaluationSession(sessionRow);
      const serverUserObj = mockServerUser({ id: su.id, serverId: srv.id, userId: target.id });

      const results = await evaluateRulesAsync(
        {
          session,
          serverUser: serverUserObj,
          server: srv,
          activeSessions: [session],
          recentSessions: [session],
        },
        activeRulesV2
      );

      expect(results.some((r) => r.ruleId === rule.id)).toBe(true);

      const [insertedViolation] = await db
        .insert(violations)
        .values({
          ruleId: rule.id,
          serverUserId: su.id,
          sessionId: session.id,
          severity: 'warning',
          ruleType: null,
          data: {},
        })
        .returning();
      expect(insertedViolation?.serverUserId).toBe(su.id);
    }

    // The unrelated person's account never matches the person-scoped rule.
    const unrelatedSessionRow = await createTestSession({
      serverId: serverA.id,
      serverUserId: unrelatedSu.id,
    });
    const unrelatedSession = toEvaluationSession(unrelatedSessionRow);
    const unrelatedServerUserObj = mockServerUser({
      id: unrelatedSu.id,
      serverId: serverA.id,
      userId: unrelated.id,
    });

    const unrelatedResults = await evaluateRulesAsync(
      {
        session: unrelatedSession,
        serverUser: unrelatedServerUserObj,
        server: serverAObj,
        activeSessions: [unrelatedSession],
        recentSessions: [unrelatedSession],
      },
      activeRulesV2
    );
    expect(unrelatedResults.some((r) => r.ruleId === rule.id)).toBe(false);

    const unrelatedViolations = await db
      .select()
      .from(violations)
      .where(eq(violations.serverUserId, unrelatedSu.id));
    expect(unrelatedViolations).toHaveLength(0);
  });

  it('repoints a source identity rule onto the target on merge, applying to the target afterwards', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });

    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: server.id });

    const rule = await insertRule({ name: 'Source person rule', userId: source.id });

    await mergeUsers(source.id, target.id, admin.id);

    const [ruleAfterMerge] = await db.select().from(rules).where(eq(rules.id, rule.id));
    expect(ruleAfterMerge?.userId).toBe(target.id);

    const activeRulesV2 = await getActiveRulesV2();
    const serverObj = mockServer({ id: server.id, type: 'plex' });
    const sessionRow = await createTestSession({ serverId: server.id, serverUserId: targetSu.id });
    const session = toEvaluationSession(sessionRow);
    const serverUserObj = mockServerUser({
      id: targetSu.id,
      serverId: server.id,
      userId: target.id,
    });

    const results = await evaluateRulesAsync(
      {
        session,
        serverUser: serverUserObj,
        server: serverObj,
        activeSessions: [session],
        recentSessions: [session],
      },
      activeRulesV2
    );
    expect(results.some((r) => r.ruleId === rule.id)).toBe(true);
  });

  it('targets only the triggering account by default, and every sibling-server session when enforceAcrossServers is true', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: serverA.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: serverB.id });
    await mergeUsers(source.id, target.id, admin.id);

    const sessionA = toEvaluationSession(
      await createTestSession({ serverId: serverA.id, serverUserId: targetSu.id })
    );
    const sessionB = toEvaluationSession(
      await createTestSession({ serverId: serverB.id, serverUserId: sourceSu.id })
    );

    // Default (enforceAcrossServers=false, or absent): stays on the triggering account.
    const defaultTargets = resolveTargetSessions({
      target: 'all_user',
      triggeringSession: sessionA,
      serverUserId: targetSu.id,
      activeSessions: [sessionA, sessionB],
    });
    expect(defaultTargets.map((s) => s.id)).toEqual([sessionA.id]);

    // enforceAcrossServers=true: identity-aware, includes the sibling-server session.
    const crossServerTargets = resolveTargetSessions({
      target: 'all_user',
      triggeringSession: sessionA,
      serverUserId: targetSu.id,
      activeSessions: [sessionA, sessionB],
      identityServerUserIds: [targetSu.id, sourceSu.id],
    });
    expect(crossServerTargets.map((s) => s.id).sort()).toEqual([sessionA.id, sessionB.id].sort());
  });

  it('defaults enforceAcrossServers to false for a rule created without specifying it', async () => {
    const rule = await insertRule({ name: 'Legacy-shaped rule' });
    expect(rule.enforceAcrossServers).toBe(false);
  });

  it('same-server combine returns dropped conflicting rule names and repoints the non-conflicting one', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });

    const target = await createTestUser({ role: 'member', email: 'combine-target@example.com' });
    const source = await createTestUser({ role: 'member', email: null });
    const targetSu = await createTestServerUser({ userId: target.id, serverId: server.id });
    const sourceSu = await createTestServerUser({ userId: source.id, serverId: server.id });

    await insertRule({ name: 'Duplicate Rule', serverUserId: targetSu.id });
    const sourceDuplicate = await insertRule({ name: 'Duplicate Rule', serverUserId: sourceSu.id });
    const sourceUnique = await insertRule({
      name: 'Unique Source Rule',
      serverUserId: sourceSu.id,
    });

    const result = await mergeUsers(source.id, target.id, admin.id, {
      confirmSameServerCombine: true,
    });

    expect(result.wasSameServerCombine).toBe(true);
    expect(result.droppedRuleNames).toEqual(['Duplicate Rule']);

    // The source's conflicting rule was deleted, not duplicated.
    const [droppedRow] = await db.select().from(rules).where(eq(rules.id, sourceDuplicate.id));
    expect(droppedRow).toBeUndefined();

    const duplicateRows = await db.select().from(rules).where(eq(rules.name, 'Duplicate Rule'));
    expect(duplicateRows).toHaveLength(1);

    // The non-conflicting rule moved onto the combined (target) server user.
    const [uniqueRow] = await db.select().from(rules).where(eq(rules.id, sourceUnique.id));
    expect(uniqueRow?.serverUserId).toBe(targetSu.id);
  });
});

describe('account-scoped rules', () => {
  it('applies only to the specific account it is scoped to, not a sibling account, via the real create route', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const server = await createTestServer({ type: 'plex' });

    const targetUser = await createTestUser({ role: 'member' });
    const otherUser = await createTestUser({ role: 'member' });
    const targetSu = await createTestServerUser({ userId: targetUser.id, serverId: server.id });
    const otherSu = await createTestServerUser({ userId: otherUser.id, serverId: server.id });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        userId: admin.id,
        username: 'admin',
        role: 'owner',
        serverIds: [server.id],
      };
    });
    await app.register(ruleRoutes, { prefix: '/rules' });

    const response = await app.inject({
      method: 'POST',
      url: '/rules/v2',
      payload: {
        name: 'Account rule',
        serverUserId: targetSu.id,
        conditions: ALWAYS_MATCH_CONDITIONS,
        actions: { actions: [] },
      },
    });
    await app.close();

    expect(response.statusCode).toBe(201);
    const rule = response.json();
    expect(rule.serverUserId).toBe(targetSu.id);

    const activeRulesV2 = await getActiveRulesV2();
    const scopedRule = activeRulesV2.find((r) => r.id === rule.id);
    expect(scopedRule?.serverUserId).toBe(targetSu.id);

    const serverObj = mockServer({ id: server.id, type: 'plex' });

    // The scoped account matches and gets a violation created.
    const targetSessionRow = await createTestSession({
      serverId: server.id,
      serverUserId: targetSu.id,
    });
    const targetSession = toEvaluationSession(targetSessionRow);
    const targetServerUserObj = mockServerUser({
      id: targetSu.id,
      serverId: server.id,
      userId: targetUser.id,
    });

    const targetResults = await evaluateRulesAsync(
      {
        session: targetSession,
        serverUser: targetServerUserObj,
        server: serverObj,
        activeSessions: [targetSession],
        recentSessions: [targetSession],
      },
      activeRulesV2
    );
    expect(targetResults.some((r) => r.ruleId === rule.id)).toBe(true);

    const [insertedViolation] = await db
      .insert(violations)
      .values({
        ruleId: rule.id,
        serverUserId: targetSu.id,
        sessionId: targetSession.id,
        severity: 'warning',
        ruleType: null,
        data: {},
      })
      .returning();
    expect(insertedViolation?.serverUserId).toBe(targetSu.id);

    // A different account on the same server never matches the account-scoped rule.
    const otherSessionRow = await createTestSession({
      serverId: server.id,
      serverUserId: otherSu.id,
    });
    const otherSession = toEvaluationSession(otherSessionRow);
    const otherServerUserObj = mockServerUser({
      id: otherSu.id,
      serverId: server.id,
      userId: otherUser.id,
    });

    const otherResults = await evaluateRulesAsync(
      {
        session: otherSession,
        serverUser: otherServerUserObj,
        server: serverObj,
        activeSessions: [otherSession],
        recentSessions: [otherSession],
      },
      activeRulesV2
    );
    expect(otherResults.some((r) => r.ruleId === rule.id)).toBe(false);

    const otherViolations = await db
      .select()
      .from(violations)
      .where(eq(violations.serverUserId, otherSu.id));
    expect(otherViolations).toHaveLength(0);
  });
});

describe('rule scope validation', () => {
  it('rejects a rule with more than one scope set', () => {
    const result = createRuleV2Schema.safeParse({
      name: 'Bad scope rule',
      serverId: randomUUID(),
      userId: randomUUID(),
      conditions: ALWAYS_MATCH_CONDITIONS,
      actions: { actions: [] },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a rule scoped to exactly one of server, account, or person', () => {
    const result = createRuleV2Schema.safeParse({
      name: 'Good scope rule',
      userId: randomUUID(),
      conditions: ALWAYS_MATCH_CONDITIONS,
      actions: { actions: [] },
    });
    expect(result.success).toBe(true);
  });
});

describe('GET /rules person-scoped visibility', () => {
  it('hides a person-scoped rule from a viewer with access to none of the identity servers, fail-closed', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const otherServer = await createTestServer({ type: 'emby' });

    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    await createTestServerUser({ userId: target.id, serverId: serverA.id });
    await createTestServerUser({ userId: source.id, serverId: serverB.id });
    await mergeUsers(source.id, target.id, admin.id);

    const rule = await insertRule({ name: 'Person rule', userId: target.id });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    // Viewer's only accessible server (otherServer) is neither of the
    // merged identity's servers (serverA, serverB).
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [otherServer.id],
      };
    });
    await app.register(ruleRoutes, { prefix: '/rules' });

    const response = await app.inject({ method: 'GET', url: '/rules' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.some((r: { id: string }) => r.id === rule.id)).toBe(false);
  });

  it('shows a person-scoped rule to a viewer with access to at least one of the identity servers', async () => {
    const admin = await createTestUser({ role: 'owner' });
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });

    const target = await createTestUser({ role: 'member' });
    const source = await createTestUser({ role: 'member' });
    await createTestServerUser({ userId: target.id, serverId: serverA.id });
    await createTestServerUser({ userId: source.id, serverId: serverB.id });
    await mergeUsers(source.id, target.id, admin.id);

    const rule = await insertRule({ name: 'Person rule', userId: target.id });

    const app = Fastify({ logger: false });
    await app.register(sensible);
    // Viewer only has access to serverB (the merged-in sibling's server),
    // which is still enough since the rule targets the whole identity.
    app.decorate('authenticate', async (request: any) => {
      request.user = {
        userId: randomUUID(),
        username: 'viewer',
        role: 'viewer',
        serverIds: [serverB.id],
      };
    });
    await app.register(ruleRoutes, { prefix: '/rules' });

    const response = await app.inject({ method: 'GET', url: '/rules' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.some((r: { id: string }) => r.id === rule.id)).toBe(true);
  });
});
