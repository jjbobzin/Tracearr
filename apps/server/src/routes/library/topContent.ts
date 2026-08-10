/**
 * Library Top Content Routes
 *
 * GET /top-movies - Top movies by plays/watch time with time filtering
 * GET /top-shows - Top TV shows by engagement with binge scoring
 *
 * Features:
 * - Time period filtering (7d, 30d, 90d, 1y, all)
 * - Multi-server support with serverIds[] query param
 * - Single-server path delegates to DB functions (exact main parity)
 * - Multi-server path uses inlined CTE + match-key dedup with serverIds[]
 * - Per-item serverIds[] for frontend color dots (multi-server path only)
 * - Server-side sorting on all metrics
 * - Pagination support
 */

import {
  CACHE_TTL,
  REDIS_KEYS,
  topContentQuerySchema,
  type TopContentQueryInput,
  type TopMoviesResponse,
  type TopShowsResponse,
} from '@tracearr/shared';
import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

/** Raw row returned by get_content_engagement() DB function */
interface RawMovieRowSingle {
  rating_key: string;
  media_title: string;
  year: number | null;
  thumb_path: string | null;
  server_id: string;
  total_plays: string;
  total_watch_hours: string;
  unique_viewers: string;
  completion_rate: string;
}

/** Raw row from the inlined multi-server dedup CTE (movies) */
interface RawMovieRowMulti {
  match_key: string | null;
  media_title: string;
  year: number | null;
  thumb_path: string | null;
  server_id: string;
  server_ids: string[];
  total_plays: string;
  total_watch_hours: string;
  unique_viewers: string;
  completion_rate: string;
}

/** Raw row returned by get_show_engagement() DB function */
interface RawShowRowSingle {
  show_title: string;
  year: number | null;
  thumb_path: string | null;
  server_id: string;
  total_episode_views: string;
  total_watch_hours: string;
  unique_viewers: string;
  avg_completion_rate: string;
  binge_score: string;
}

/** Raw row from the inlined multi-server dedup CTE (shows) */
interface RawShowRowMulti {
  show_title: string;
  year: number | null;
  thumb_path: string | null;
  server_id: string;
  server_ids: string[];
  total_episode_views: string;
  total_watch_hours: string;
  unique_viewers: string;
  avg_completion_rate: string;
  binge_score: string;
}

/** Convert period string to date range */
function getPeriodDates(period: string): { startDate: Date | null; endDate: Date } {
  const endDate = new Date();

  switch (period) {
    case '7d':
      return { startDate: new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000), endDate };
    case '30d':
      return { startDate: new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000), endDate };
    case '90d':
      return { startDate: new Date(endDate.getTime() - 90 * 24 * 60 * 60 * 1000), endDate };
    case '1y':
      return { startDate: new Date(endDate.getTime() - 365 * 24 * 60 * 60 * 1000), endDate };
    case 'all':
    default:
      return { startDate: null, endDate };
  }
}

/**
 * For 'all' period, find the earliest engagement data as the start date.
 * Falls back to 2020-01-01 if no data exists.
 */
async function resolveStartDate(startDate: Date | null): Promise<Date> {
  if (startDate) return startDate;

  const result = await db.execute(sql`
    SELECT MIN(day)::date AS earliest FROM daily_content_engagement
  `);
  const earliest = (result.rows[0] as { earliest: string | null })?.earliest;
  return earliest ? new Date(earliest) : new Date('2020-01-01');
}

export const libraryTopContentRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /top-movies - Top movies by engagement metrics
   *
   * Single-server: delegates to get_content_engagement() for exact main parity.
   * Multi-server: inlined CTE with cross-server dedup by media identity;
   *   each result includes serverIds[] for all servers that contributed plays.
   */
  app.get<{ Querystring: TopContentQueryInput }>(
    '/top-movies',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = topContentQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds, period, sortBy, sortOrder, page, pageSize } = query.data;
      const authUser = request.user;

      const resolvedIds = resolveServerIds(authUser, serverId, serverIds);

      // Empty resolved set means no accessible servers match the requested filter
      if (resolvedIds?.length === 0) {
        const empty: TopMoviesResponse = {
          items: [],
          summary: { totalMovies: 0, totalWatchHours: 0 },
          pagination: { page, pageSize, total: 0 },
        };
        return empty;
      }

      // Gate: single server uses the DB function; multi (or owner-all) uses the inlined CTE
      const singleServer = resolvedIds?.length === 1;

      const serverCacheSegment = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_TOP_MOVIES,
        serverCacheSegment,
        `${period}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as TopMoviesResponse;
        } catch {
          // Fall through to compute
        }
      }

      const { startDate, endDate } = getPeriodDates(period);
      const effectiveStartDate = await resolveStartDate(startDate);
      const offset = (page - 1) * pageSize;

      // Movies don't have binge_score - fall back to total_plays
      const sortColumnMap: Record<string, string> = {
        plays: 'total_plays',
        watch_hours: 'total_watch_hours',
        viewers: 'unique_viewers',
        completion_rate: 'completion_rate',
        binge_score: 'total_plays',
      };
      const sortColumn = sortColumnMap[sortBy] ?? 'total_plays';
      const sortDir = sortOrder === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST';

      let items: TopMoviesResponse['items'];
      let total: number;
      let totalWatchHours: number;

      if (singleServer) {
        // Single-server path: call the DB function exactly as main does.
        // resolvedIds[0] is the one server the user scoped to.
        const filterServerId = resolvedIds[0];

        const itemsResult = await db.execute(sql`
          SELECT
            rating_key,
            media_title,
            year,
            thumb_path,
            server_id,
            total_plays,
            total_watch_hours,
            unique_viewers,
            completion_rate
          FROM get_content_engagement(
            ${effectiveStartDate}::timestamptz,
            ${endDate}::timestamptz,
            ${filterServerId}::uuid,
            'movie'
          )
          WHERE media_title IS NOT NULL
          ORDER BY ${sql.raw(sortColumn)} ${sql.raw(sortDir)}
          LIMIT ${pageSize} OFFSET ${offset}
        `);

        items = (itemsResult.rows as unknown as RawMovieRowSingle[]).map((row) => ({
          ratingKey: row.rating_key,
          title: row.media_title,
          year: row.year,
          thumbPath: row.thumb_path,
          serverId: row.server_id,
          serverIds: [row.server_id],
          totalPlays: parseInt(row.total_plays, 10) || 0,
          totalWatchHours: parseFloat(row.total_watch_hours) || 0,
          uniqueViewers: parseInt(row.unique_viewers, 10) || 0,
          completionRate: parseFloat(row.completion_rate) || 0,
        }));

        const summaryResult = await db.execute(sql`
          SELECT
            COUNT(*) AS total_movies,
            COALESCE(SUM(total_watch_hours), 0) AS total_watch_hours
          FROM get_content_engagement(
            ${effectiveStartDate}::timestamptz,
            ${endDate}::timestamptz,
            ${filterServerId}::uuid,
            'movie'
          )
          WHERE media_title IS NOT NULL
        `);

        const summaryRow = summaryResult.rows[0] as {
          total_movies: string;
          total_watch_hours: string;
        };
        total = parseInt(summaryRow.total_movies, 10) || 0;
        totalWatchHours = parseFloat(summaryRow.total_watch_hours) || 0;
      } else {
        // Multi-server path: inlined CTE with dedup by media identity.
        //
        // Dedup approach: the media_id stamped on sessions (surfaced through the
        // cagg) keys the collapse, falling back to a normalized-title key for
        // unidentified content, then to the server-scoped rating key for titleless
        // rows (rating keys are only unique per server). Rows sharing a key (same
        // movie on multiple servers) collapse into one row; play counts and watch
        // time are summed. ARRAY_AGG collects all contributing server IDs.
        //
        // unique_viewers is counted by identity (server_users.user_id), computed
        // separately from the matched titles' raw viewer rows - summing each
        // server's per-title viewer count would double-count a merged person
        // who watched the same title on two servers.
        const serverFilter = buildMultiServerFragment(resolvedIds, 'd.server_id');

        const itemsResult = await db.execute(sql`
          WITH user_content AS (
            SELECT
              d.rating_key,
              d.server_user_id,
              su.user_id AS identity_user_id,
              MAX(d.media_title) AS media_title,
              MAX(d.content_duration_ms) AS content_duration_ms,
              MAX(d.thumb_path) AS thumb_path,
              MAX(d.server_id::text)::uuid AS server_id,
              -- Fold a merged-loser id to its winner so a duplicate merged after
              -- the fact still collapses with the winner's rows, mirroring
              -- value_rollup's alias fold in catalog.ts. am is only null for
              -- unstamped rows, which fall through to the title/rk keys below.
              MAX(COALESCE(am.merged_into_id, d.media_id)::text)::uuid AS media_id,
              MAX(d.year) AS year,
              SUM(d.watched_ms) AS watched_ms,
              MAX(d.max_progress_ms) AS max_progress_ms
            FROM daily_content_engagement d
            JOIN server_users su ON su.id = d.server_user_id
            LEFT JOIN media am ON am.id = d.media_id
            WHERE d.day >= ${effectiveStartDate}::timestamptz
              AND d.day < ${endDate}::timestamptz
              AND d.media_type = 'movie'
              AND (am.id IS NULL OR am.media_type = 'movie')
              ${serverFilter}
            GROUP BY d.rating_key, d.server_user_id, su.user_id
          ),
          content_agg AS (
            SELECT
              uc.server_id,
              uc.rating_key,
              MAX(uc.media_title) AS media_title,
              MAX(uc.thumb_path) AS thumb_path,
              MAX(uc.media_id::text)::uuid AS media_id,
              MAX(uc.year) AS year,
              SUM(CASE
                WHEN uc.content_duration_ms > 0 THEN
                  GREATEST(
                    CASE WHEN COALESCE(uc.max_progress_ms, 0) >= uc.content_duration_ms * 0.85 THEN 1
                         WHEN uc.watched_ms >= uc.content_duration_ms * 0.85 THEN 1
                         ELSE 0 END,
                    FLOOR(uc.watched_ms::float / uc.content_duration_ms)
                  )
                ELSE 0
              END)::bigint AS total_plays,
              ROUND(SUM(uc.watched_ms) / 3600000.0, 1) AS total_watch_hours,
              ROUND(100.0 * COUNT(DISTINCT uc.server_user_id) FILTER (
                WHERE uc.content_duration_ms > 0
                  AND (COALESCE(uc.max_progress_ms, 0) >= uc.content_duration_ms * 0.85
                       OR uc.watched_ms >= uc.content_duration_ms * 0.85)
              ) / NULLIF(COUNT(DISTINCT uc.server_user_id), 0), 1) AS completion_rate
            FROM user_content uc
            GROUP BY uc.server_id, uc.rating_key
          ),
          with_match_key AS (
            SELECT
              ca.*,
              LOWER(REGEXP_REPLACE(COALESCE(ca.media_title, ''), '[^a-zA-Z0-9]', '', 'g')) AS norm_title,
              COALESCE(
                ca.media_id::text,
                NULLIF('title:' || LOWER(REGEXP_REPLACE(COALESCE(ca.media_title, ''), '[^a-zA-Z0-9]', '', 'g')), 'title:'),
                'rk:' || ca.server_id::text || ':' || ca.rating_key
              ) AS match_key
            FROM content_agg ca
          ),
          -- Per (title, year) bucket, hopping to the media_id stamped on ANY row
          -- sharing that bucket so a stamped and an unstamped copy of the same
          -- movie collapse together (mirrors show_dedup_map, keyed by year too
          -- since two different movies can share a title).
          title_year_raw AS (
            SELECT norm_title, year, MAX(media_id::text) AS raw_media_id
            FROM with_match_key
            WHERE norm_title <> ''
            GROUP BY norm_title, year
          ),
          title_year_counts AS (
            SELECT
              norm_title,
              COUNT(*) FILTER (WHERE year IS NOT NULL) AS non_null_year_count,
              MAX(year) FILTER (WHERE year IS NOT NULL) AS sole_year
            FROM title_year_raw
            GROUP BY norm_title
          ),
          -- A null-year bucket folds into the title's one non-null-year bucket;
          -- with zero or 2+ non-null buckets it stays on its own.
          title_year_effective AS (
            SELECT
              tyr.norm_title,
              tyr.year AS raw_year,
              CASE
                WHEN tyr.year IS NULL AND tyc.non_null_year_count = 1 THEN tyc.sole_year
                ELSE tyr.year
              END AS effective_year,
              tyr.raw_media_id
            FROM title_year_raw tyr
            JOIN title_year_counts tyc ON tyc.norm_title = tyr.norm_title
          ),
          movie_dedup_map AS (
            SELECT
              norm_title,
              raw_year,
              COALESCE(
                MAX(raw_media_id) OVER (PARTITION BY norm_title, effective_year),
                'title:' || norm_title || ':' || COALESCE(effective_year::text, 'null')
              ) AS dedup_key
            FROM title_year_effective
          ),
          with_dedup_key AS (
            SELECT
              wmk.*,
              COALESCE(mdm.dedup_key, wmk.match_key) AS dedup_key
            FROM with_match_key wmk
            LEFT JOIN movie_dedup_map mdm
              ON mdm.norm_title = wmk.norm_title AND mdm.raw_year IS NOT DISTINCT FROM wmk.year
          ),
          rating_key_dedup_map AS (
            SELECT server_id, rating_key, dedup_key
            FROM with_dedup_key
          ),
          identity_counts AS (
            SELECT rkm.dedup_key, COUNT(DISTINCT uc.identity_user_id)::bigint AS unique_viewers
            FROM user_content uc
            JOIN rating_key_dedup_map rkm
              ON rkm.server_id = uc.server_id AND rkm.rating_key = uc.rating_key
            GROUP BY rkm.dedup_key
          ),
          deduped AS (
            SELECT
              dedup_key,
              MAX(media_title) AS media_title,
              MAX(year) AS year,
              MAX(thumb_path) AS thumb_path,
              MIN(server_id::text) AS server_id,
              ARRAY_AGG(DISTINCT server_id::text) AS server_ids,
              SUM(total_plays) AS total_plays,
              ROUND(SUM(total_watch_hours), 1) AS total_watch_hours,
              ROUND(AVG(completion_rate), 1) AS completion_rate
            FROM with_dedup_key
            WHERE media_title IS NOT NULL
            GROUP BY dedup_key
          )
          SELECT
            d.dedup_key AS match_key,
            d.media_title,
            d.year,
            d.thumb_path,
            d.server_id,
            d.server_ids,
            d.total_plays,
            d.total_watch_hours,
            COALESCE(ic.unique_viewers, 0) AS unique_viewers,
            d.completion_rate
          FROM deduped d
          LEFT JOIN identity_counts ic ON ic.dedup_key = d.dedup_key
          ORDER BY ${sql.raw(sortColumn)} ${sql.raw(sortDir)}
          LIMIT ${pageSize} OFFSET ${offset}
        `);

        items = (itemsResult.rows as unknown as RawMovieRowMulti[]).map((row) => ({
          ratingKey: row.match_key ?? '',
          title: row.media_title,
          year: row.year,
          thumbPath: row.thumb_path,
          serverId: row.server_id,
          serverIds: row.server_ids,
          totalPlays: parseInt(String(row.total_plays), 10) || 0,
          totalWatchHours: parseFloat(String(row.total_watch_hours)) || 0,
          uniqueViewers: parseInt(String(row.unique_viewers), 10) || 0,
          completionRate: parseFloat(String(row.completion_rate)) || 0,
        }));

        const summaryResult = await db.execute(sql`
          WITH user_content AS (
            SELECT
              d.rating_key,
              d.server_user_id,
              MAX(d.media_title) AS media_title,
              MAX(d.content_duration_ms) AS content_duration_ms,
              MAX(d.server_id::text)::uuid AS server_id,
              MAX(COALESCE(am.merged_into_id, d.media_id)::text)::uuid AS media_id,
              MAX(d.year) AS year,
              SUM(d.watched_ms) AS watched_ms,
              MAX(d.max_progress_ms) AS max_progress_ms
            FROM daily_content_engagement d
            LEFT JOIN media am ON am.id = d.media_id
            WHERE d.day >= ${effectiveStartDate}::timestamptz
              AND d.day < ${endDate}::timestamptz
              AND d.media_type = 'movie'
              AND (am.id IS NULL OR am.media_type = 'movie')
              ${serverFilter}
            GROUP BY d.rating_key, d.server_user_id
          ),
          content_agg AS (
            SELECT
              uc.server_id,
              uc.rating_key,
              MAX(uc.media_title) AS media_title,
              MAX(uc.media_id::text)::uuid AS media_id,
              MAX(uc.year) AS year,
              ROUND(SUM(uc.watched_ms) / 3600000.0, 1) AS total_watch_hours
            FROM user_content uc
            GROUP BY uc.server_id, uc.rating_key
          ),
          with_match_key AS (
            SELECT
              ca.total_watch_hours,
              ca.media_id,
              ca.year,
              LOWER(REGEXP_REPLACE(COALESCE(ca.media_title, ''), '[^a-zA-Z0-9]', '', 'g')) AS norm_title,
              COALESCE(
                ca.media_id::text,
                NULLIF('title:' || LOWER(REGEXP_REPLACE(COALESCE(ca.media_title, ''), '[^a-zA-Z0-9]', '', 'g')), 'title:'),
                'rk:' || ca.server_id::text || ':' || ca.rating_key
              ) AS match_key
            FROM content_agg ca
          ),
          title_year_raw AS (
            SELECT norm_title, year, MAX(media_id::text) AS raw_media_id
            FROM with_match_key
            WHERE norm_title <> ''
            GROUP BY norm_title, year
          ),
          title_year_counts AS (
            SELECT
              norm_title,
              COUNT(*) FILTER (WHERE year IS NOT NULL) AS non_null_year_count,
              MAX(year) FILTER (WHERE year IS NOT NULL) AS sole_year
            FROM title_year_raw
            GROUP BY norm_title
          ),
          title_year_effective AS (
            SELECT
              tyr.norm_title,
              tyr.year AS raw_year,
              CASE
                WHEN tyr.year IS NULL AND tyc.non_null_year_count = 1 THEN tyc.sole_year
                ELSE tyr.year
              END AS effective_year,
              tyr.raw_media_id
            FROM title_year_raw tyr
            JOIN title_year_counts tyc ON tyc.norm_title = tyr.norm_title
          ),
          movie_dedup_map AS (
            SELECT
              norm_title,
              raw_year,
              COALESCE(
                MAX(raw_media_id) OVER (PARTITION BY norm_title, effective_year),
                'title:' || norm_title || ':' || COALESCE(effective_year::text, 'null')
              ) AS dedup_key
            FROM title_year_effective
          ),
          with_dedup_key AS (
            SELECT
              wmk.total_watch_hours,
              COALESCE(mdm.dedup_key, wmk.match_key) AS dedup_key
            FROM with_match_key wmk
            LEFT JOIN movie_dedup_map mdm
              ON mdm.norm_title = wmk.norm_title AND mdm.raw_year IS NOT DISTINCT FROM wmk.year
          ),
          deduped AS (
            SELECT
              dedup_key,
              ROUND(SUM(total_watch_hours), 1) AS total_watch_hours
            FROM with_dedup_key
            GROUP BY dedup_key
          )
          SELECT
            COUNT(*) AS total_movies,
            COALESCE(SUM(total_watch_hours), 0) AS total_watch_hours
          FROM deduped
        `);

        const summaryRow = summaryResult.rows[0] as {
          total_movies: string;
          total_watch_hours: string;
        };
        total = parseInt(String(summaryRow.total_movies), 10) || 0;
        totalWatchHours = parseFloat(String(summaryRow.total_watch_hours)) || 0;
      }

      const response: TopMoviesResponse = {
        items,
        summary: { totalMovies: total, totalWatchHours },
        pagination: { page, pageSize, total },
      };

      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_TOP_MOVIES, JSON.stringify(response));

      return response;
    }
  );

  /**
   * GET /top-shows - Top TV shows by engagement metrics
   *
   * Single-server: delegates to get_show_engagement() for exact main parity.
   * Multi-server: inlined CTE with cross-server dedup by show media identity;
   *   each result includes serverIds[] for all servers that contributed views.
   */
  app.get<{ Querystring: TopContentQueryInput }>(
    '/top-shows',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = topContentQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds, period, sortBy, sortOrder, page, pageSize } = query.data;
      const authUser = request.user;

      const resolvedIds = resolveServerIds(authUser, serverId, serverIds);

      if (resolvedIds?.length === 0) {
        const empty: TopShowsResponse = {
          items: [],
          summary: { totalShows: 0, totalWatchHours: 0 },
          pagination: { page, pageSize, total: 0 },
        };
        return empty;
      }

      // Gate: single server uses the DB function; multi (or owner-all) uses the inlined CTE
      const singleServer = resolvedIds?.length === 1;

      const serverCacheSegment = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_TOP_SHOWS,
        serverCacheSegment,
        `${period}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as TopShowsResponse;
        } catch {
          // Fall through to compute
        }
      }

      const { startDate, endDate } = getPeriodDates(period);
      const effectiveStartDate = await resolveStartDate(startDate);
      const offset = (page - 1) * pageSize;

      const sortColumnMap: Record<string, string> = {
        plays: 'total_episode_views',
        watch_hours: 'total_watch_hours',
        viewers: 'unique_viewers',
        completion_rate: 'avg_completion_rate',
        binge_score: 'binge_score',
      };
      const sortColumn = sortColumnMap[sortBy] ?? 'total_episode_views';
      const sortDir = sortOrder === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST';

      let items: TopShowsResponse['items'];
      let total: number;
      let totalWatchHours: number;

      if (singleServer) {
        // Single-server path: call the DB function exactly as main does.
        const filterServerId = resolvedIds[0];

        const itemsResult = await db.execute(sql`
          SELECT
            show_title,
            year,
            thumb_path,
            server_id,
            total_episode_views,
            total_watch_hours,
            unique_viewers,
            avg_completion_rate,
            binge_score
          FROM get_show_engagement(
            ${effectiveStartDate}::timestamptz,
            ${endDate}::timestamptz,
            ${filterServerId}::uuid
          )
          WHERE show_title IS NOT NULL
          ORDER BY ${sql.raw(sortColumn)} ${sql.raw(sortDir)}
          LIMIT ${pageSize} OFFSET ${offset}
        `);

        items = (itemsResult.rows as unknown as RawShowRowSingle[]).map((row) => ({
          showTitle: row.show_title,
          year: row.year,
          thumbPath: row.thumb_path,
          serverId: row.server_id,
          serverIds: [row.server_id],
          totalEpisodeViews: parseInt(row.total_episode_views, 10) || 0,
          totalWatchHours: parseFloat(row.total_watch_hours) || 0,
          uniqueViewers: parseInt(row.unique_viewers, 10) || 0,
          avgCompletionRate: parseFloat(row.avg_completion_rate) || 0,
          bingeScore: parseFloat(row.binge_score) || 0,
        }));

        const summaryResult = await db.execute(sql`
          SELECT
            COUNT(*) AS total_shows,
            COALESCE(SUM(total_watch_hours), 0) AS total_watch_hours
          FROM get_show_engagement(
            ${effectiveStartDate}::timestamptz,
            ${endDate}::timestamptz,
            ${filterServerId}::uuid
          )
          WHERE show_title IS NOT NULL
        `);

        const summaryRow = summaryResult.rows[0] as {
          total_shows: string;
          total_watch_hours: string;
        };
        total = parseInt(summaryRow.total_shows, 10) || 0;
        totalWatchHours = parseFloat(summaryRow.total_watch_hours) || 0;
      } else {
        // Multi-server path: inlined CTE with dedup by show media identity.
        //
        // Dedup approach: the show_media_id stamped on sessions (surfaced through
        // the cagg) keys the collapse, falling back to LOWER + strip non-alphanumeric
        // on show_title for unidentified shows. Shows sharing a key across servers
        // collapse into one row; episode views and watch hours are summed.
        //
        // unique_viewers is counted by identity (server_users.user_id) via a
        // separate identity_counts CTE - summing each server's per-show viewer
        // count would double-count a merged person watching the same show on
        // two servers. Its keys come from show_dedup_map (per-title, after the
        // MAX(show_media_id) hop) so they always line up with deduped's keys,
        // even when a show mixes stamped and unstamped episode rows.
        const serverFilter = buildMultiServerFragment(resolvedIds, 'd.server_id');

        const itemsResult = await db.execute(sql`
          WITH user_episodes AS (
            SELECT
              d.rating_key,
              d.server_user_id,
              MAX(d.show_title) AS show_title,
              -- Fold a merged-loser show id to its winner, same as the movie
              -- branch above; am is only null for unstamped episodes.
              MAX(COALESCE(am.merged_into_id, d.show_media_id)::text)::uuid AS show_media_id,
              MAX(d.content_duration_ms) AS content_duration_ms,
              MAX(d.thumb_path) AS thumb_path,
              MAX(d.server_id::text)::uuid AS server_id,
              MAX(d.year) AS year,
              SUM(d.watched_ms) AS watched_ms,
              MAX(d.max_progress_ms) AS max_progress_ms,
              COUNT(DISTINCT d.day) AS viewing_days
            FROM daily_content_engagement d
            LEFT JOIN media am ON am.id = d.show_media_id
            WHERE d.day >= ${effectiveStartDate}::timestamptz
              AND d.day < ${endDate}::timestamptz
              AND d.show_title IS NOT NULL
              AND d.media_type = 'episode'
              AND (am.id IS NULL OR am.media_type = 'show')
              ${serverFilter}
            GROUP BY d.rating_key, d.server_user_id
          ),
          show_dedup_map AS (
            SELECT
              ue.show_title,
              COALESCE(MAX(ue.show_media_id::text), LOWER(REGEXP_REPLACE(COALESCE(ue.show_title, ''), '[^a-zA-Z0-9]', '', 'g'))) AS dedup_key
            FROM user_episodes ue
            GROUP BY ue.show_title
          ),
          identity_counts AS (
            SELECT
              sdm.dedup_key,
              COUNT(DISTINCT su.user_id)::bigint AS unique_viewers
            FROM user_episodes ue
            JOIN show_dedup_map sdm ON sdm.show_title = ue.show_title
            JOIN server_users su ON su.id = ue.server_user_id
            GROUP BY sdm.dedup_key
          ),
          user_shows AS (
            SELECT
              ue.server_user_id,
              ue.show_title,
              MAX(ue.show_media_id::text)::uuid AS show_media_id,
              MAX(ue.thumb_path) AS thumb_path,
              MAX(ue.server_id::text)::uuid AS server_id,
              MAX(ue.year) AS year,
              COUNT(DISTINCT ue.rating_key) AS episodes_watched,
              SUM(ue.watched_ms) AS total_watched_ms,
              SUM(ue.viewing_days) AS total_viewing_days,
              COUNT(DISTINCT ue.rating_key) FILTER (
                WHERE ue.content_duration_ms > 0
                  AND (COALESCE(ue.max_progress_ms, 0) >= ue.content_duration_ms * 0.85
                       OR ue.watched_ms >= ue.content_duration_ms * 0.85)
              ) AS completed_episodes
            FROM user_episodes ue
            GROUP BY ue.server_user_id, ue.show_title
          ),
          show_agg AS (
            SELECT
              us.show_title,
              MAX(us.show_media_id::text)::uuid AS show_media_id,
              MAX(us.server_id::text)::uuid AS server_id,
              MAX(us.thumb_path) AS thumb_path,
              MAX(us.year) AS year,
              SUM(us.episodes_watched)::bigint AS total_episode_views,
              ROUND(SUM(us.total_watched_ms) / 3600000.0, 1) AS total_watch_hours,
              ROUND(100.0 * SUM(us.completed_episodes) / NULLIF(SUM(us.episodes_watched), 0), 1) AS avg_completion_rate,
              LEAST(100, ROUND(
                40 * (AVG(us.episodes_watched)::numeric * ROUND(100.0 * SUM(us.completed_episodes) / NULLIF(SUM(us.episodes_watched), 0), 1) / 100 / 10) +
                30 * (SUM(us.total_viewing_days)::numeric / NULLIF(COUNT(DISTINCT us.server_user_id), 0) * 2) +
                30 * (SUM(us.completed_episodes)::numeric / NULLIF(SUM(us.episodes_watched), 0))
              , 0)) AS binge_score
            FROM user_shows us
            GROUP BY us.show_title
          ),
          deduped AS (
            SELECT
              COALESCE(sa.show_media_id::text, LOWER(REGEXP_REPLACE(COALESCE(sa.show_title, ''), '[^a-zA-Z0-9]', '', 'g'))) AS dedup_key,
              MAX(sa.show_title) AS show_title,
              MAX(sa.year) AS year,
              MAX(sa.thumb_path) AS thumb_path,
              MIN(sa.server_id::text) AS server_id,
              ARRAY_AGG(DISTINCT sa.server_id::text) AS server_ids,
              SUM(sa.total_episode_views)::bigint AS total_episode_views,
              ROUND(SUM(sa.total_watch_hours), 1) AS total_watch_hours,
              ROUND(AVG(sa.avg_completion_rate), 1) AS avg_completion_rate,
              ROUND(AVG(sa.binge_score), 0) AS binge_score
            FROM show_agg sa
            WHERE sa.show_title IS NOT NULL
            GROUP BY COALESCE(sa.show_media_id::text, LOWER(REGEXP_REPLACE(COALESCE(sa.show_title, ''), '[^a-zA-Z0-9]', '', 'g')))
          )
          SELECT
            d.show_title,
            d.year,
            d.thumb_path,
            d.server_id,
            d.server_ids,
            d.total_episode_views,
            d.total_watch_hours,
            COALESCE(ic.unique_viewers, 0) AS unique_viewers,
            d.avg_completion_rate,
            d.binge_score
          FROM deduped d
          LEFT JOIN identity_counts ic ON ic.dedup_key = d.dedup_key
          ORDER BY ${sql.raw(sortColumn)} ${sql.raw(sortDir)}
          LIMIT ${pageSize} OFFSET ${offset}
        `);

        items = (itemsResult.rows as unknown as RawShowRowMulti[]).map((row) => ({
          showTitle: row.show_title,
          year: row.year,
          thumbPath: row.thumb_path,
          serverId: row.server_id,
          serverIds: row.server_ids,
          totalEpisodeViews: parseInt(String(row.total_episode_views), 10) || 0,
          totalWatchHours: parseFloat(String(row.total_watch_hours)) || 0,
          uniqueViewers: parseInt(String(row.unique_viewers), 10) || 0,
          avgCompletionRate: parseFloat(String(row.avg_completion_rate)) || 0,
          bingeScore: parseFloat(String(row.binge_score)) || 0,
        }));

        const summaryResult = await db.execute(sql`
          WITH user_episodes AS (
            SELECT
              d.rating_key,
              d.server_user_id,
              MAX(d.show_title) AS show_title,
              MAX(COALESCE(am.merged_into_id, d.show_media_id)::text)::uuid AS show_media_id,
              MAX(d.content_duration_ms) AS content_duration_ms,
              MAX(d.server_id::text)::uuid AS server_id,
              SUM(d.watched_ms) AS watched_ms,
              MAX(d.max_progress_ms) AS max_progress_ms,
              COUNT(DISTINCT d.day) AS viewing_days
            FROM daily_content_engagement d
            LEFT JOIN media am ON am.id = d.show_media_id
            WHERE d.day >= ${effectiveStartDate}::timestamptz
              AND d.day < ${endDate}::timestamptz
              AND d.show_title IS NOT NULL
              AND d.media_type = 'episode'
              AND (am.id IS NULL OR am.media_type = 'show')
              ${serverFilter}
            GROUP BY d.rating_key, d.server_user_id
          ),
          user_shows AS (
            SELECT
              ue.server_user_id,
              ue.show_title,
              MAX(ue.show_media_id::text)::uuid AS show_media_id,
              MAX(ue.server_id::text)::uuid AS server_id,
              SUM(ue.watched_ms) AS total_watched_ms,
              COUNT(DISTINCT ue.rating_key) AS episodes_watched,
              COUNT(DISTINCT ue.rating_key) FILTER (
                WHERE ue.content_duration_ms > 0
                  AND (COALESCE(ue.max_progress_ms, 0) >= ue.content_duration_ms * 0.85
                       OR ue.watched_ms >= ue.content_duration_ms * 0.85)
              ) AS completed_episodes
            FROM user_episodes ue
            GROUP BY ue.server_user_id, ue.show_title
          ),
          show_agg AS (
            SELECT
              us.show_title,
              MAX(us.show_media_id::text)::uuid AS show_media_id,
              ROUND(SUM(us.total_watched_ms) / 3600000.0, 1) AS total_watch_hours
            FROM user_shows us
            GROUP BY us.show_title
          ),
          deduped AS (
            SELECT
              COALESCE(sa.show_media_id::text, LOWER(REGEXP_REPLACE(COALESCE(sa.show_title, ''), '[^a-zA-Z0-9]', '', 'g'))) AS dedup_key,
              ROUND(SUM(sa.total_watch_hours), 1) AS total_watch_hours
            FROM show_agg sa
            WHERE sa.show_title IS NOT NULL
            GROUP BY COALESCE(sa.show_media_id::text, LOWER(REGEXP_REPLACE(COALESCE(sa.show_title, ''), '[^a-zA-Z0-9]', '', 'g')))
          )
          SELECT
            COUNT(*) AS total_shows,
            COALESCE(SUM(total_watch_hours), 0) AS total_watch_hours
          FROM deduped
        `);

        const summaryRow = summaryResult.rows[0] as {
          total_shows: string;
          total_watch_hours: string;
        };
        total = parseInt(String(summaryRow.total_shows), 10) || 0;
        totalWatchHours = parseFloat(String(summaryRow.total_watch_hours)) || 0;
      }

      const response: TopShowsResponse = {
        items,
        summary: { totalShows: total, totalWatchHours },
        pagination: { page, pageSize, total },
      };

      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_TOP_SHOWS, JSON.stringify(response));

      return response;
    }
  );
};
