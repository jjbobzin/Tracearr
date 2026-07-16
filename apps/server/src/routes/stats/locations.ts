/**
 * Location Statistics Routes
 *
 * GET /locations - Geo data for stream map with filtering
 *
 * Features cascading filters where each filter's available options depend on
 * the other active filters. Runs 2 parallel queries per request.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { locationStatsQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { representativeAccountOrderSql } from '../../utils/representativeAccount.js';
import { resolveDateRange } from './utils.js';

interface LocationFilters {
  users: {
    id: string;
    username: string;
    identityName: string | null;
    serverUserIds: string[];
  }[];
  servers: { id: string; name: string }[];
  mediaTypes: ('movie' | 'episode' | 'track' | 'live' | 'photo' | 'unknown')[];
}

/**
 * Build a WHERE fragment matching sessions for either the single-account
 * (serverUserId) or multi-account (serverUserIds) person filter. The array
 * form takes precedence so a merged person's full history can be filtered
 * at once; the scalar form stays supported for existing callers.
 */
function buildUserFilterFragment(
  serverUserId: string | undefined,
  serverUserIds: string[] | undefined
): ReturnType<typeof sql> | null {
  if (serverUserIds && serverUserIds.length > 0) {
    const ids = serverUserIds.map((id) => sql`${id}`);
    return sql`s.server_user_id IN (${sql.join(ids, sql`, `)})`;
  }
  if (serverUserId) {
    return sql`s.server_user_id = ${serverUserId}`;
  }
  return null;
}

export const locationsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /locations - Geo data for stream map with filtering
   *
   * Supports filtering by:
   * - period: Time period (day, week, month, year, all, custom)
   * - startDate/endDate: For custom period
   * - serverUserId: Filter to a specific account
   * - serverUserIds: Filter to a person's full set of accounts (takes precedence)
   * - serverId: Legacy single-server filter (kept for back-compat)
   * - serverIds: Repeatable multi-server filter
   * - mediaType: Filter by movie/episode/track
   */
  app.get('/locations', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = locationStatsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const {
      period,
      startDate,
      endDate,
      serverUserId,
      serverUserIds,
      serverId: legacyServerId,
      serverIds: rawServerIds,
      mediaType,
    } = query.data;
    const dateRange = resolveDateRange(period, startDate, endDate);
    const authUser = request.user;

    const resolvedIds = resolveServerIds(authUser, legacyServerId, rawServerIds, { strict: false });
    const serverFragment = buildMultiServerFragment(resolvedIds, 's.server_id');
    const userFragment = buildUserFilterFragment(
      serverUserId,
      serverUserIds as string[] | undefined
    );

    // Build WHERE conditions for main query (all qualified with 's.' for sessions table)
    const conditions: ReturnType<typeof sql>[] = [
      sql`s.geo_lat IS NOT NULL`,
      sql`s.geo_lon IS NOT NULL`,
    ];

    // Add date range filter (null start means "all time")
    if (dateRange.start) {
      conditions.push(sql`s.started_at >= ${dateRange.start}`);
    }
    if (period === 'custom') {
      conditions.push(sql`s.started_at < ${dateRange.end}`);
    }

    if (userFragment) {
      conditions.push(userFragment);
    }
    // If specific mediaType requested, filter to it; otherwise show all types
    if (mediaType) {
      conditions.push(sql`s.media_type = ${mediaType}`);
    }

    // serverFragment already starts with AND (or is empty for owner-all)
    const whereClause = sql`WHERE ${sql.join(conditions, sql` AND `)} ${serverFragment}`;

    // Build cascading filter conditions - each filter type sees options based on OTHER active filters
    // This gives users a consistent UX where selecting one filter narrows down the others
    const baseConditions: ReturnType<typeof sql>[] = [
      sql`s.geo_lat IS NOT NULL`,
      sql`s.geo_lon IS NOT NULL`,
    ];

    // Add date range filter for cascading filters
    if (dateRange.start) {
      baseConditions.push(sql`s.started_at >= ${dateRange.start}`);
    }
    if (period === 'custom') {
      baseConditions.push(sql`s.started_at < ${dateRange.end}`);
    }

    // Users filter: apply server + mediaType filters (not user filter)
    const userFilterConditions = [...baseConditions];
    if (mediaType) {
      userFilterConditions.push(sql`s.media_type = ${mediaType}`);
    }
    const userFilterWhereClause = sql`WHERE ${sql.join(userFilterConditions, sql` AND `)} ${serverFragment}`;

    // Servers filter: apply user + mediaType filters (not server filter)
    const serverFilterConditions = [...baseConditions];
    if (userFragment) serverFilterConditions.push(userFragment);
    if (mediaType) {
      serverFilterConditions.push(sql`s.media_type = ${mediaType}`);
    }
    // Cascading server dropdown should respect access but not the active server filter
    const serverAccessFragment = buildMultiServerFragment(resolvedIds, 's.server_id');
    const serverFilterWhereClause = sql`WHERE ${sql.join(serverFilterConditions, sql` AND `)} ${serverAccessFragment}`;

    // MediaType filter: apply user + server filters (not mediaType filter)
    const mediaFilterConditions = [...baseConditions];
    if (userFragment) mediaFilterConditions.push(userFragment);
    const mediaFilterWhereClause = sql`WHERE ${sql.join(mediaFilterConditions, sql` AND `)} ${serverFragment}`;

    // Cascading filters are always fetched fresh (no caching since they depend on current selections)
    let availableFilters: LocationFilters | null = null;

    // Execute queries in parallel (2 instead of 4 sequential)
    const [mainResult, filtersResult] = await Promise.all([
      // Query 1: Main location data with CTE for per-server breakdown
      //
      // location_detail: location-grain aggregates for device_count and user_info (DISTINCT
      //   across all servers to avoid double-counting).
      // per_server: (location, server_id) grain with per-server event counts; DISTINCT
      //   COALESCE(reference_id, id) deduplicates resume-chain sessions within one server.
      // server_agg: re-aggregates per_server to location grain, producing total count and
      //   the servers JSON array ordered by count DESC.
      // Final SELECT joins location_detail with server_agg via IS NOT DISTINCT FROM to
      //   handle NULL geo fields correctly.
      db.execute(sql`
        WITH location_detail AS (
          SELECT
            s.geo_city,
            s.geo_location_name,
            s.geo_region,
            s.geo_country,
            s.geo_lat,
            s.geo_lon,
            MAX(s.started_at) AS last_activity,
            MIN(s.started_at) AS first_activity,
            COUNT(DISTINCT COALESCE(s.device_id, s.player_name))::int AS device_count,
            JSON_AGG(DISTINCT jsonb_build_object('id', su.id, 'username', su.username, 'thumbUrl', su.thumb_url))
              FILTER (WHERE su.id IS NOT NULL) AS user_info
          FROM sessions s
          LEFT JOIN server_users su ON s.server_user_id = su.id
          ${whereClause}
          GROUP BY s.geo_location_name, s.geo_city, s.geo_region, s.geo_country, s.geo_lat, s.geo_lon
        ),
        per_server AS (
          SELECT
            s.geo_city,
            s.geo_location_name,
            s.geo_region,
            s.geo_country,
            s.geo_lat,
            s.geo_lon,
            s.server_id,
            COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int AS server_count
          FROM sessions s
          ${whereClause}
          GROUP BY s.geo_location_name, s.geo_city, s.geo_region, s.geo_country, s.geo_lat, s.geo_lon, s.server_id
        ),
        server_agg AS (
          SELECT
            geo_city,
            geo_location_name,
            geo_region,
            geo_country,
            geo_lat,
            geo_lon,
            SUM(server_count)::int AS total_count,
            JSON_AGG(
              jsonb_build_object('serverId', server_id, 'count', server_count)
              ORDER BY server_count DESC, server_id
            ) AS servers
          FROM per_server
          GROUP BY geo_location_name, geo_city, geo_region, geo_country, geo_lat, geo_lon
        )
        SELECT
          ld.geo_location_name AS location_name,
          ld.geo_city AS city,
          ld.geo_region AS region,
          ld.geo_country AS country,
          ld.geo_lat AS lat,
          ld.geo_lon AS lon,
          sa.total_count AS count,
          ld.last_activity,
          ld.first_activity,
          ld.device_count,
          ld.user_info,
          sa.servers
        FROM location_detail ld
        JOIN server_agg sa ON
          ld.geo_location_name IS NOT DISTINCT FROM sa.geo_location_name AND
          ld.geo_city IS NOT DISTINCT FROM sa.geo_city AND
          ld.geo_region IS NOT DISTINCT FROM sa.geo_region AND
          ld.geo_country IS NOT DISTINCT FROM sa.geo_country AND
          ld.geo_lat IS NOT DISTINCT FROM sa.geo_lat AND
          ld.geo_lon IS NOT DISTINCT FROM sa.geo_lon
        ORDER BY sa.total_count DESC
        LIMIT 500
      `),

      // Query 2: Cascading filter options - each filter type uses conditions from OTHER active filters
      // Note: ORDER BY not allowed within UNION subqueries, sorting done in application code
      db.execute(sql`
          SELECT
            'user' as filter_type,
            rep.id::text as id,
            rep.username as name,
            rep.identity_name as identity_name,
            COALESCE(
              (SELECT ARRAY_AGG(su2.id::text ORDER BY su2.id)
               FROM server_users su2
               WHERE su2.user_id = rep.user_id
               ${buildMultiServerFragment(resolvedIds, 'su2.server_id')}
              ),
              ARRAY[rep.id::text]
            ) AS server_user_ids
          FROM (
            SELECT DISTINCT ON (su.user_id) su.id, su.user_id, su.username, u.name as identity_name
            FROM sessions s
            JOIN server_users su ON su.id = s.server_user_id
            JOIN users u ON su.user_id = u.id
            ${userFilterWhereClause}
            ORDER BY su.user_id, ${representativeAccountOrderSql('su')}
          ) rep

          UNION ALL

          SELECT 'server' as filter_type, sv.id::text as id, sv.name as name, NULL as identity_name,
            NULL::text[] as server_user_ids
          FROM sessions s
          JOIN servers sv ON sv.id = s.server_id
          ${serverFilterWhereClause}
          GROUP BY sv.id, sv.name

          UNION ALL

          SELECT 'media' as filter_type, s.media_type as id, s.media_type as name, NULL as identity_name,
            NULL::text[] as server_user_ids
          FROM sessions s
          ${mediaFilterWhereClause} AND s.media_type IS NOT NULL
          GROUP BY s.media_type
        `),
    ]);

    // Parse filter results (no caching - cascading filters depend on current selections)
    // Sorting done here since ORDER BY not allowed within UNION subqueries
    const filters = filtersResult.rows as {
      filter_type: string;
      id: string;
      name: string;
      identity_name: string | null;
      server_user_ids: string[] | null;
    }[];
    availableFilters = {
      users: filters
        .filter((f) => f.filter_type === 'user')
        .map((f) => ({
          id: f.id,
          username: f.name,
          identityName: f.identity_name,
          serverUserIds: f.server_user_ids ?? [f.id],
        }))
        .sort((a, b) => (a.identityName ?? a.username).localeCompare(b.identityName ?? b.username)),
      servers: filters
        .filter((f) => f.filter_type === 'server')
        .map((f) => ({ id: f.id, name: f.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      mediaTypes: filters
        .filter((f) => f.filter_type === 'media')
        .map((f) => f.name)
        .filter(
          (t): t is 'movie' | 'episode' | 'track' =>
            t === 'movie' || t === 'episode' || t === 'track'
        )
        .sort((a, b) => a.localeCompare(b)),
    };

    // Transform main query results
    const locationStats = (
      mainResult.rows as {
        location_name: string | null;
        city: string | null;
        region: string | null;
        country: string | null;
        lat: number;
        lon: number;
        count: number;
        last_activity: Date;
        first_activity: Date;
        device_count: number;
        user_info: { id: string; username: string; thumbUrl: string | null }[] | null;
        servers: { serverId: string; count: number }[] | null;
      }[]
    ).map((row) => ({
      locationName: row.location_name,
      city: row.city,
      region: row.region,
      country: row.country,
      lat: row.lat,
      lon: row.lon,
      count: row.count,
      lastActivity: row.last_activity,
      firstActivity: row.first_activity,
      deviceCount: row.device_count,
      // Only include users array if NOT filtering by a specific user (or person)
      users: userFragment ? undefined : (row.user_info ?? []).slice(0, 5),
      servers: row.servers ?? [],
    }));

    // Calculate summary stats for the overlay card
    const totalStreams = locationStats.reduce((sum, loc) => sum + loc.count, 0);
    // uniqueLocations = number of distinct map markers (not location-server pairs)
    const uniqueLocations = locationStats.length;
    const topCity = locationStats[0]?.city ?? null;

    return {
      data: locationStats,
      summary: {
        totalStreams,
        uniqueLocations,
        topCity,
      },
      availableFilters: availableFilters ?? { users: [], servers: [], mediaTypes: [] },
    };
  });
};
