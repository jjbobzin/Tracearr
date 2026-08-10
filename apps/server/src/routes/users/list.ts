/**
 * Server User List and CRUD Routes
 *
 * These routes manage server users (accounts on Plex/Jellyfin/Emby servers),
 * not the identity users. Server users have per-server trust scores and session counts.
 *
 * GET / - List all server users with pagination
 * GET /:id - Get server user details
 * PATCH /:id - Update server user (trustScore, etc.)
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, inArray, isNull } from 'drizzle-orm';
import {
  updateUserSchema,
  updateUserIdentitySchema,
  userIdParamSchema,
  paginationSchema,
  serverIdFilterSchema,
  booleanStringSchema,
  userSortFieldSchema,
  type UserSortField,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { serverUsers, sessions, servers, users } from '../../db/schema.js';
import {
  hasServerAccess,
  buildServerAccessCondition,
  resolveServerIds,
  buildMultiServerCondition,
  buildMultiServerFragment,
} from '../../utils/serverFiltering.js';
import { updateUser, recomputeIdentityAggregates } from '../../services/userService.js';
import { representativeAccountOrderSql } from '../../utils/representativeAccount.js';
import { PLAY_COUNT } from '../../constants/index.js';

// Sensible default direction per sort field: names read A-Z, everything else
// leads with the "most interesting" end (highest trust, most recent).
const USER_ORDER_DEFAULT_DIR: Record<UserSortField, 'asc' | 'desc'> = {
  username: 'asc',
  trustScore: 'desc',
  joinedAt: 'desc',
  lastActivityAt: 'desc',
};

/**
 * Build the ORDER BY SQL clause for the roster based on the requested sort
 * field. Always ends in serverUsers.id so pagination stays deterministic
 * across pages, matching the representative-account tiebreak used elsewhere.
 */
function getUserOrderBy(orderBy: UserSortField, orderDir: 'asc' | 'desc') {
  const dir = orderDir === 'asc' ? sql`ASC` : sql`DESC`;

  switch (orderBy) {
    case 'trustScore':
      return sql`${users.aggregateTrustScore} ${dir}, ${serverUsers.id} ASC`;
    case 'joinedAt':
      return sql`${serverUsers.joinedAt} ${dir} NULLS LAST, ${serverUsers.id} ASC`;
    case 'lastActivityAt':
      return sql`${serverUsers.lastActivityAt} ${dir} NULLS LAST, ${serverUsers.id} ASC`;
    case 'username':
    default:
      return sql`${serverUsers.username} ${dir}, ${serverUsers.id} ASC`;
  }
}

const bulkResetTrustBodySchema = z.object({
  ids: z.array(z.uuid()).max(1000).optional(),
  selectAll: z.boolean().optional(),
  filters: z
    .object({
      serverId: z.uuid().optional(),
      serverIds: z.array(z.uuid()).optional(),
      includeRemoved: z.boolean().optional(),
    })
    .optional(),
});

export const listRoutes: FastifyPluginAsync = async (app) => {
  // Combined schema for pagination and server filter
  const userListQuerySchema = paginationSchema.extend(serverIdFilterSchema.shape).extend({
    includeRemoved: booleanStringSchema.default(false),
    search: z.string().trim().min(1).max(100).optional(),
    orderBy: userSortFieldSchema.default('username'),
    orderDir: z.enum(['asc', 'desc']).optional(),
  });

  /**
   * GET / - List all server users with pagination
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = userListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { page, pageSize, serverId, serverIds, includeRemoved, search, orderBy, orderDir } =
      query.data;
    const authUser = request.user;
    const offset = (page - 1) * pageSize;
    const effectiveOrderDir = orderDir ?? USER_ORDER_DEFAULT_DIR[orderBy];

    const resolvedIds = resolveServerIds(authUser, serverId, serverIds);

    // Short-circuit when the user has no accessible servers in the requested set
    if (resolvedIds?.length === 0) {
      return {
        data: [],
        page,
        pageSize,
        total: 0,
        totalPages: 0,
      };
    }

    // Build conditions for filtering
    const conditions = [];

    const serverCondition = buildMultiServerCondition(resolvedIds, serverUsers.serverId);
    if (serverCondition) {
      conditions.push(serverCondition);
    }

    if (!includeRemoved) {
      conditions.push(isNull(serverUsers.removedAt));
    }

    if (search) {
      const pattern = `%${search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      conditions.push(
        sql`(${serverUsers.username} ILIKE ${pattern} OR ${users.name} ILIKE ${pattern})`
      );
    }

    // One row per identity: keep the login-linked, most-active present account, scoped
    // to servers the caller can see so an inaccessible account can't win or hide the row.
    conditions.push(sql`${serverUsers.id} IN (
      SELECT DISTINCT ON (su.user_id) su.id
      FROM ${serverUsers} su
      INNER JOIN ${users} u ON su.user_id = u.id
      WHERE true ${buildMultiServerFragment(resolvedIds, 'su.server_id')}
      ORDER BY su.user_id, ${representativeAccountOrderSql('su')}
    )`);

    const serverUserList = await db
      .select({
        id: serverUsers.id,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        userId: serverUsers.userId,
        externalId: serverUsers.externalId,
        username: serverUsers.username,
        email: serverUsers.email,
        thumbUrl: serverUsers.thumbUrl,
        isServerAdmin: serverUsers.isServerAdmin,
        trustScore: serverUsers.trustScore,
        joinedAt: serverUsers.joinedAt,
        lastActivityAt: serverUsers.lastActivityAt,
        removedAt: serverUsers.removedAt,
        updatedAt: serverUsers.updatedAt,
        // Include identity info
        identityName: users.name,
        role: users.role,
        // The person's overall trust across all their server accounts,
        // distinct from `trustScore` (this representative account's own score).
        identityTrustScore: users.aggregateTrustScore,
      })
      .from(serverUsers)
      .innerJoin(servers, eq(serverUsers.serverId, servers.id))
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(getUserOrderBy(orderBy, effectiveOrderDir))
      .limit(pageSize)
      .offset(offset);

    // Get total count (joins users because the search condition references users.name)
    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(serverUsers)
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    const total = countResult[0]?.count ?? 0;

    // Batch-fetch each identity's server memberships in one query for the whole
    // page, scoped to servers the caller can access (owners see all).
    const pageUserIds = [...new Set(serverUserList.map((u) => u.userId))];
    const identityServersByUserId = new Map<
      string,
      { id: string; name: string; serverUserId: string; removedAt: string | null }[]
    >();
    if (pageUserIds.length > 0) {
      const identityServerAccessCondition = buildServerAccessCondition(
        authUser,
        serverUsers.serverId
      );
      const identityWhere = identityServerAccessCondition
        ? and(inArray(serverUsers.userId, pageUserIds), identityServerAccessCondition)
        : inArray(serverUsers.userId, pageUserIds);

      const identityServerRows = await db
        .selectDistinct({
          userId: serverUsers.userId,
          serverId: serverUsers.serverId,
          serverName: servers.name,
          serverUserId: serverUsers.id,
          removedAt: serverUsers.removedAt,
        })
        .from(serverUsers)
        .innerJoin(servers, eq(serverUsers.serverId, servers.id))
        .where(identityWhere);

      for (const row of identityServerRows) {
        const existing = identityServersByUserId.get(row.userId);
        const entry = {
          id: row.serverId,
          name: row.serverName,
          serverUserId: row.serverUserId,
          removedAt: row.removedAt ? row.removedAt.toISOString() : null,
        };
        if (existing) {
          existing.push(entry);
        } else {
          identityServersByUserId.set(row.userId, [entry]);
        }
      }
    }

    const data = serverUserList.map((u) => ({
      ...u,
      // Fallback is unreachable in practice: the row's own server is always part of the
      // batched scope above. Kept as a safety net, not an expected path.
      identityServers: identityServersByUserId.get(u.userId) ?? [
        {
          id: u.serverId,
          name: u.serverName,
          serverUserId: u.id,
          removedAt: u.removedAt ? u.removedAt.toISOString() : null,
        },
      ],
    }));

    return {
      data,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  });

  /**
   * GET /:id - Get server user details
   */
  app.get('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const { id } = params.data;
    const authUser = request.user;

    const serverUserRows = await db
      .select({
        id: serverUsers.id,
        serverId: serverUsers.serverId,
        serverName: servers.name,
        userId: serverUsers.userId,
        externalId: serverUsers.externalId,
        username: serverUsers.username,
        email: serverUsers.email,
        thumbUrl: serverUsers.thumbUrl,
        isServerAdmin: serverUsers.isServerAdmin,
        trustScore: serverUsers.trustScore,
        joinedAt: serverUsers.joinedAt,
        lastActivityAt: serverUsers.lastActivityAt,
        removedAt: serverUsers.removedAt,
        updatedAt: serverUsers.updatedAt,
        // Include identity info
        identityName: users.name,
        role: users.role,
      })
      .from(serverUsers)
      .innerJoin(servers, eq(serverUsers.serverId, servers.id))
      .innerJoin(users, eq(serverUsers.userId, users.id))
      .where(eq(serverUsers.id, id))
      .limit(1);

    const serverUser = serverUserRows[0];
    if (!serverUser) {
      return reply.notFound('User not found');
    }

    // Verify access (owners can see all servers)
    if (!hasServerAccess(authUser, serverUser.serverId)) {
      return reply.forbidden('You do not have access to this user');
    }

    // Get session stats for this server user (count unique plays, not raw rows)
    const statsResult = await db
      .select({
        totalSessions: PLAY_COUNT,
        totalWatchTime: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
      })
      .from(sessions)
      .where(eq(sessions.serverUserId, id));

    const stats = statsResult[0];

    return {
      ...serverUser,
      stats: {
        totalSessions: stats?.totalSessions ?? 0,
        totalWatchTime: Number(stats?.totalWatchTime ?? 0),
      },
    };
  });

  /**
   * PATCH /:id - Update server user (trustScore, etc.)
   */
  app.patch('/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const body = updateUserSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can update users
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can update users');
    }

    // Get existing server user
    const serverUserRows = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.id, id))
      .limit(1);

    const serverUser = serverUserRows[0];
    if (!serverUser) {
      return reply.notFound('User not found');
    }

    // Verify access (owners can see all servers)
    if (!hasServerAccess(authUser, serverUser.serverId)) {
      return reply.forbidden('You do not have access to this user');
    }

    // Build update object
    const updateData: Partial<{
      trustScore: number;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    if (body.data.trustScore !== undefined) {
      updateData.trustScore = body.data.trustScore;
    }

    // Update server user, and keep the person's overall trust rollup current
    // in the same transaction whenever trustScore actually changed.
    const updatedServerUser = await db.transaction(async (tx) => {
      const updated = await tx
        .update(serverUsers)
        .set(updateData)
        .where(eq(serverUsers.id, id))
        .returning({
          id: serverUsers.id,
          serverId: serverUsers.serverId,
          userId: serverUsers.userId,
          externalId: serverUsers.externalId,
          username: serverUsers.username,
          email: serverUsers.email,
          thumbUrl: serverUsers.thumbUrl,
          isServerAdmin: serverUsers.isServerAdmin,
          trustScore: serverUsers.trustScore,
          joinedAt: serverUsers.joinedAt,
          lastActivityAt: serverUsers.lastActivityAt,
          updatedAt: serverUsers.updatedAt,
        });

      const row = updated[0];
      if (row && updateData.trustScore !== undefined) {
        await recomputeIdentityAggregates(row.userId, tx);
      }
      return row;
    });

    if (!updatedServerUser) {
      return reply.internalServerError('Failed to update user');
    }

    return updatedServerUser;
  });

  /**
   * PATCH /:id/identity - Update user identity (display name)
   * Owner-only. Updates the users table (identity), not server_users.
   */
  app.patch('/:id/identity', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = userIdParamSchema.safeParse(request.params);
    if (!params.success) {
      return reply.badRequest('Invalid user ID');
    }

    const body = updateUserIdentitySchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { id } = params.data;
    const authUser = request.user;

    // Only owners can update user identity
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only owners can update user identity');
    }

    // Get serverUser to find userId (the identity)
    const serverUserRows = await db
      .select({ userId: serverUsers.userId, serverId: serverUsers.serverId })
      .from(serverUsers)
      .where(eq(serverUsers.id, id))
      .limit(1);

    const serverUser = serverUserRows[0];
    if (!serverUser) {
      return reply.notFound('User not found');
    }

    // Verify access
    if (!hasServerAccess(authUser, serverUser.serverId)) {
      return reply.forbidden('Access denied');
    }

    // Update the identity record (users table)
    const updated = await updateUser(serverUser.userId, { name: body.data.name });

    return { success: true, name: updated.name };
  });

  /**
   * POST /bulk/reset-trust - Bulk reset trust scores to 100
   * Owner/admin. Accepts either specific server-user IDs or a selectAll flag
   * with the same roster filters as GET /. Resetting a person's representative
   * row resets ALL of their accounts on servers the caller can access, so the
   * identity's overall trust score actually returns to 100 for an owner (not
   * just the one account that happened to be selected). A scoped admin only
   * ever touches accounts on servers they can access, so the identity's
   * rollup recomputes over the person's full account set and may land short
   * of 100 if a sibling account outside their access still has a lower score.
   */
  app.post('/bulk/reset-trust', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners and admins can reset trust scores
    if (authUser.role !== 'owner' && authUser.role !== 'admin') {
      return reply.forbidden('Only administrators can reset trust scores');
    }

    const parsedBody = bulkResetTrustBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.badRequest('Invalid request body');
    }
    const body = parsedBody.data;

    if ((!body.ids || body.ids.length === 0) && !body.selectAll) {
      return reply.badRequest('ids array or selectAll is required');
    }

    let seedIds: string[] = [];

    if (body.selectAll) {
      // Same filters as GET / (serverIds, includeRemoved), resolved against
      // the caller's own access, so selectAll can never promise a reset
      // outside what the roster actually shows them.
      const resolvedIds = resolveServerIds(
        authUser,
        body.filters?.serverId,
        body.filters?.serverIds,
        { strict: false }
      );

      if (resolvedIds?.length === 0) {
        return { success: true, updated: 0 };
      }

      const conditions = [];
      const serverCondition = buildMultiServerCondition(resolvedIds, serverUsers.serverId);
      if (serverCondition) {
        conditions.push(serverCondition);
      }
      if (!body.filters?.includeRemoved) {
        conditions.push(isNull(serverUsers.removedAt));
      }

      const matching = await db
        .select({ id: serverUsers.id })
        .from(serverUsers)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      seedIds = matching.map((u) => u.id);
    } else {
      seedIds = body.ids!;
    }

    if (seedIds.length === 0) {
      return { success: true, updated: 0 };
    }

    // Verify access and resolve the identities behind the seed accounts
    const seedDetails = await db
      .select({
        id: serverUsers.id,
        serverId: serverUsers.serverId,
        userId: serverUsers.userId,
      })
      .from(serverUsers)
      .where(inArray(serverUsers.id, seedIds));

    const accessibleSeeds = seedDetails.filter((u) => hasServerAccess(authUser, u.serverId));
    if (accessibleSeeds.length === 0) {
      return { success: true, updated: 0 };
    }

    const affectedIdentityIds = [...new Set(accessibleSeeds.map((u) => u.userId))];

    // Expand each touched identity to ALL of their accounts on servers the
    // caller can access, so a merged person's sibling accounts get reset too.
    const identityAccessCondition = buildServerAccessCondition(authUser, serverUsers.serverId);
    const identityWhere = identityAccessCondition
      ? and(inArray(serverUsers.userId, affectedIdentityIds), identityAccessCondition)
      : inArray(serverUsers.userId, affectedIdentityIds);

    const accountsToReset = await db
      .select({ id: serverUsers.id })
      .from(serverUsers)
      .where(identityWhere);

    const accountIds = accountsToReset.map((a) => a.id);
    if (accountIds.length === 0) {
      return { success: true, updated: 0 };
    }

    // Bulk update trust scores to 100, then recompute each affected identity's
    // rollup once in the same transaction.
    await db.transaction(async (tx) => {
      await tx
        .update(serverUsers)
        .set({
          trustScore: 100,
          updatedAt: new Date(),
        })
        .where(inArray(serverUsers.id, accountIds));

      for (const userId of affectedIdentityIds) {
        await recomputeIdentityAggregates(userId, tx);
      }
    });

    return { success: true, updated: accountIds.length };
  });
};
