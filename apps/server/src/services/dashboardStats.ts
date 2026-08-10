/**
 * Dashboard Statistics Service
 *
 * Computes dashboard metrics (plays, watch time, alerts, active users).
 * Used by both internal dashboard route and public API stats/today endpoint.
 */

import { sql, gte, and, inArray, eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { REDIS_KEYS, TIME_MS, type DashboardStats } from '@tracearr/shared';
import { db } from '../db/client.js';
import { sessions, serverUsers } from '../db/schema.js';
import {
  playsCountSince,
  watchTimeSince,
  violationsCountSince,
  uniqueUsersSince,
} from '../db/prepared.js';
import { buildMultiServerCondition, buildMultiServerFragment } from '../utils/serverFiltering.js';
import { getCacheService } from './cache.js';
import { getStartOfDayInTimezone, getStartOfNextDayInTimezone } from '../routes/stats/utils.js';
import { PRIMARY_MEDIA_TYPES, MEDIA_TYPE_SQL_FILTER } from '../constants/index.js';

export interface GetDashboardStatsOptions {
  /** Server IDs to filter by. undefined = all servers */
  serverIds?: string[];
  /** IANA timezone for "today" calculation */
  timezone: string;
  /** Redis client for caching (optional) */
  redis?: Redis;
}

const CACHE_TTL_SECONDS = 60;
const MIN_PLAY_DURATION_MS = 120000;

/**
 * Get dashboard statistics with optional caching.
 */
export async function getDashboardStats(
  options: GetDashboardStatsOptions
): Promise<DashboardStats> {
  const { serverIds, timezone, redis } = options;

  // Build cache key
  const cacheKeySegment = serverIds === undefined ? 'all' : serverIds.sort().join(',');
  const cacheKey = `${REDIS_KEYS.DASHBOARD_STATS}:${cacheKeySegment}:${timezone}`;

  // Try cache first
  if (redis) {
    const cached = await redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as DashboardStats;
      } catch {
        // Fall through to compute
      }
    }
  }

  // Compute stats
  const stats = await computeDashboardStats(serverIds, timezone);

  // Cache result
  if (redis) {
    await redis.setex(cacheKey, CACHE_TTL_SECONDS, JSON.stringify(stats));
  }

  return stats;
}

async function computeDashboardStats(
  serverIds: string[] | undefined,
  timezone: string
): Promise<DashboardStats> {
  // Get active streams
  let activeStreams = 0;
  const cacheService = getCacheService();
  if (cacheService) {
    try {
      let activeSessions = await cacheService.getAllActiveSessions();
      if (serverIds !== undefined) {
        const idSet = new Set(serverIds);
        activeSessions = activeSessions.filter((s) => idSet.has(s.serverId));
      }
      activeStreams = activeSessions.length;
    } catch {
      // Ignore cache errors
    }
  }

  const todayStart = getStartOfDayInTimezone(timezone);
  const todayEnd = getStartOfNextDayInTimezone(timezone, todayStart);
  const last24h = new Date(Date.now() - TIME_MS.DAY);

  let todayPlays: number;
  let todaySessions: number;
  let watchTimeHours: number;
  let alertsLast24h: number;
  let activeUsersToday: number;

  if (serverIds === undefined) {
    // No server filter - use prepared statements for performance
    const [
      todayPlaysResult,
      watchTimeResult,
      alertsResult,
      activeUsersResult,
      validatedPlaysResult,
    ] = await Promise.all([
      playsCountSince.execute({ since: todayStart }),
      watchTimeSince.execute({ since: todayStart }),
      violationsCountSince.execute({ since: last24h }),
      uniqueUsersSince.execute({ since: todayStart }),
      db.execute(sql`
        SELECT COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        WHERE started_at >= ${todayStart} AND started_at < ${todayEnd}
          AND duration_ms >= ${MIN_PLAY_DURATION_MS}
          ${MEDIA_TYPE_SQL_FILTER}
      `),
    ]);

    todaySessions = todayPlaysResult[0]?.count ?? 0;
    todayPlays = (validatedPlaysResult.rows[0] as { count: number })?.count ?? 0;
    watchTimeHours =
      Math.round((Number(watchTimeResult[0]?.totalMs ?? 0) / (1000 * 60 * 60)) * 10) / 10;
    alertsLast24h = alertsResult[0]?.count ?? 0;
    activeUsersToday = activeUsersResult[0]?.count ?? 0;
  } else {
    // Server filter - use dynamic queries
    const buildSessionConditions = (since: Date) => {
      const conditions = [
        gte(sessions.startedAt, since),
        inArray(sessions.mediaType, PRIMARY_MEDIA_TYPES),
      ];

      const serverCondition = buildMultiServerCondition(serverIds, sessions.serverId);
      if (serverCondition) {
        conditions.push(serverCondition);
      }

      return conditions;
    };

    const violationServerFilter = buildMultiServerFragment(serverIds, 'su.server_id');
    const sessionServerFilter = buildMultiServerFragment(serverIds);

    const [
      todaySessionsResult,
      watchTimeResult,
      alertsResult,
      activeUsersResult,
      validatedPlaysResult,
    ] = await Promise.all([
      db
        .select({
          count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
        })
        .from(sessions)
        .where(and(...buildSessionConditions(todayStart))),

      db
        .select({
          totalMs: sql<number>`COALESCE(SUM(duration_ms), 0)::bigint`,
        })
        .from(sessions)
        .where(and(...buildSessionConditions(todayStart))),

      db
        .execute(
          sql`
          SELECT count(*)::int as count
          FROM violations v
          INNER JOIN server_users su ON su.id = v.server_user_id
          WHERE v.created_at >= ${last24h}
          AND v.dismissed_at IS NULL
          ${violationServerFilter}
        `
        )
        .then((r) => [{ count: (r.rows[0] as { count: number })?.count ?? 0 }]),

      // Distinct identities (people), not accounts - a merged person with
      // accounts on multiple selected servers counts once.
      db
        .select({
          count: sql<number>`count(DISTINCT ${serverUsers.userId})::int`,
        })
        .from(sessions)
        .innerJoin(serverUsers, eq(sessions.serverUserId, serverUsers.id))
        .where(and(...buildSessionConditions(todayStart))),

      db.execute(sql`
        SELECT COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        WHERE started_at >= ${todayStart} AND started_at < ${todayEnd}
          AND duration_ms >= ${MIN_PLAY_DURATION_MS}
          ${MEDIA_TYPE_SQL_FILTER}
        ${sessionServerFilter}
      `),
    ]);

    todaySessions = todaySessionsResult[0]?.count ?? 0;
    todayPlays = (validatedPlaysResult.rows[0] as { count: number })?.count ?? 0;
    watchTimeHours =
      Math.round((Number(watchTimeResult[0]?.totalMs ?? 0) / (1000 * 60 * 60)) * 10) / 10;
    alertsLast24h = alertsResult[0]?.count ?? 0;
    activeUsersToday = activeUsersResult[0]?.count ?? 0;
  }

  return {
    activeStreams,
    todayPlays,
    todaySessions,
    watchTimeHours,
    alertsLast24h,
    activeUsersToday,
  };
}
