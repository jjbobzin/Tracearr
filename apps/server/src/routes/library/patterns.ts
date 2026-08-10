/**
 * Library Watch Patterns Route
 *
 * GET /patterns - Analyze viewing patterns including binge behavior, peak times, and seasonal trends
 *
 * Multi-server support:
 * - Hourly/monthly aggregates: SUM across all accessible servers (events).
 * - Binge shows: deduped by show matchKey (same show on two servers = one journey).
 *   The `primaryServerId` is the server with the most episodes watched in that binge.
 *   The `serverIds` array lists all servers involved.
 *
 * Uses episode_continuity_stats view for binge detection and sessions table for time distribution.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryPatternsQuerySchema,
  type LibraryPatternsQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

/** Show with binge metrics (deduped across servers by show matchKey) */
interface BingeShow {
  showTitle: string;
  /** Server where the most episodes were watched in this binge journey. */
  primaryServerId: string;
  thumbPath: string | null;
  totalEpisodeWatches: number;
  consecutiveEpisodes: number;
  consecutivePct: number;
  avgGapMinutes: number;
  bingeScore: number;
  maxEpisodesInOneDay: number;
  /** All server IDs involved in this binge journey. */
  serverIds: string[];
}

/** Hourly viewing distribution */
interface HourlyDistribution {
  hour: number;
  watchCount: number;
  totalWatchMs: number;
  pctOfTotal: number;
}

/** Monthly viewing trends */
interface MonthlyTrend {
  month: string;
  watchCount: number;
  totalWatchMs: number;
  uniqueItems: number;
  avgWatchesPerDay: number;
}

/** Full patterns response */
interface PatternsResponse {
  bingeShows: BingeShow[];
  peakTimes: {
    hourlyDistribution: HourlyDistribution[];
    peakHour: number;
    peakDayOfWeek: number;
  };
  seasonalTrends: {
    monthlyTrends: MonthlyTrend[];
    busiestMonth: string;
    quietestMonth: string;
  };
  summary: {
    totalWatchSessions: number;
    avgSessionsPerDay: number;
    bingeSessionsPct: number;
  };
}

/** Raw binge row from database */
interface RawBingeRow {
  show_title: string;
  primary_server_id: string;
  thumb_path: string | null;
  total_episode_watches: string;
  consecutive_episodes: string;
  consecutive_pct: string | null;
  avg_gap_minutes: string | null;
  max_episodes_in_one_day: string | null;
  binge_score: string;
  server_ids: string;
}

/** Raw hourly row from database */
interface RawHourlyRow {
  hour: string;
  watch_count: string;
  total_watch_ms: string;
  pct_of_total: string;
}

/** Raw monthly row from database */
interface RawMonthlyRow {
  month: string;
  watch_count: string;
  total_watch_ms: string;
  unique_items: string;
  avg_watches_per_day: string;
}

/** Raw summary row from database */
interface RawSummaryRow {
  total_watch_sessions: string;
  avg_sessions_per_day: string;
  binge_sessions_pct: string;
}

export const libraryPatternsRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /patterns - Watch pattern analysis
   *
   * Analyzes viewing patterns including:
   * - Binge shows deduped by show identity across servers
   * - Peak viewing times (hour and day of week) aggregated across servers
   * - Seasonal trends (monthly patterns) aggregated across servers
   */
  app.get<{ Querystring: LibraryPatternsQueryInput }>(
    '/patterns',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryPatternsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        serverIds: rawServerIds,
        libraryId,
        periodWeeks,
        includeBinge,
        includePeakTimes,
        includeSeasonalTrends,
        bingeThreshold,
        limit,
        timezone,
      } = query.data;
      const tz = timezone ?? 'UTC';
      const authUser = request.user;

      const resolvedIds = resolveServerIds(authUser, serverId, rawServerIds);
      // Build fragment for sessions (no table alias needed for raw joins below)
      const serverFragmentLi = buildMultiServerFragment(resolvedIds, 'li.server_id');
      // For queries filtering directly on sessions
      const serverFragmentSess = buildMultiServerFragment(resolvedIds, 'sess.server_id');

      // Build cache key
      const serverCacheKey = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_PATTERNS,
        serverCacheKey,
        `${libraryId ?? 'all'}-${periodWeeks}-${bingeThreshold}-${limit}-${includeBinge}-${includePeakTimes}-${includeSeasonalTrends}-${tz}`
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as PatternsResponse;
        } catch {
          // Fall through to compute
        }
      }

      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;

      let bingeShows: BingeShow[] = [];
      let hourlyDistribution: HourlyDistribution[] = [];
      let peakHour = 0;
      let peakDayOfWeek = 0;
      let monthlyTrends: MonthlyTrend[] = [];
      let busiestMonth = '';
      let quietestMonth = '';
      let totalWatchSessions = 0;
      let avgSessionsPerDay = 0;
      let bingeSessionsPct = 0;

      const queries: Promise<void>[] = [];

      if (includeBinge) {
        queries.push(
          (async () => {
            // Binge dedup: group by show matchKey so the same show on two servers
            // is one row. primary_server_id = server with the most episodes watched.
            const bingeResult = await db.execute(sql`
              WITH binge_base AS (
                SELECT
                  ecs.show_title,
                  MAX(ses.server_id::text) AS raw_server_id,
                  MAX(ses.thumb_path) AS thumb_path,
                  SUM(ecs.total_episode_watches) AS total_episode_watches,
                  SUM(ecs.consecutive_episodes) AS consecutive_episodes,
                  ROUND(AVG(ecs.consecutive_pct)::numeric, 1) AS consecutive_pct,
                  ROUND(AVG(ecs.avg_gap_minutes)::numeric, 1) AS avg_gap_minutes,
                  MAX(dsi.max_episodes_in_one_day) AS max_episodes_in_one_day,
                  -- Collect per-server episode counts to determine primary server
                  ARRAY_AGG(DISTINCT ses.server_id::text) AS server_ids_arr,
                  -- Primary server = one with highest episode contribution
                  (
                    SELECT s2.server_id::text
                    FROM (
                      SELECT ecs2.server_user_id,
                        MAX(su2.server_id::text) AS server_id,
                        SUM(ecs2.total_episode_watches) AS ep_count
                      FROM episode_continuity_stats ecs2
                      JOIN server_users su2 ON su2.id = ecs2.server_user_id
                      WHERE ecs2.show_title = ecs.show_title
                      GROUP BY ecs2.server_user_id
                    ) s2
                    ORDER BY s2.ep_count DESC
                    LIMIT 1
                  ) AS primary_server_id
                FROM episode_continuity_stats ecs
                LEFT JOIN show_engagement_summary ses ON ecs.show_title = ses.show_title
                  AND ecs.server_user_id = ses.server_user_id
                LEFT JOIN (
                  SELECT server_user_id, show_title, MAX(episodes_watched_this_day) AS max_episodes_in_one_day
                  FROM daily_show_intensity
                  GROUP BY server_user_id, show_title
                ) dsi ON ecs.show_title = dsi.show_title AND ecs.server_user_id = dsi.server_user_id
                WHERE ecs.consecutive_episodes >= ${bingeThreshold}
                  AND EXISTS (
                    SELECT 1 FROM sessions sess
                    JOIN server_users su ON su.id = sess.server_user_id
                    WHERE sess.server_user_id = ecs.server_user_id
                      AND sess.grandparent_title = ecs.show_title
                      AND sess.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                      ${serverFragmentSess}
                  )
                GROUP BY ecs.show_title
              )
              SELECT
                show_title,
                COALESCE(primary_server_id, raw_server_id) AS primary_server_id,
                thumb_path,
                total_episode_watches::text AS total_episode_watches,
                consecutive_episodes::text AS consecutive_episodes,
                consecutive_pct::text AS consecutive_pct,
                avg_gap_minutes::text AS avg_gap_minutes,
                COALESCE(max_episodes_in_one_day, 1)::text AS max_episodes_in_one_day,
                ARRAY_TO_STRING(server_ids_arr, ',') AS server_ids,
                ROUND(
                  LEAST(consecutive_episodes * 5, 40) +
                  LEAST(COALESCE(consecutive_pct, 0), 30) +
                  LEAST(COALESCE(max_episodes_in_one_day, 1) * 6, 30)
                , 1)::text AS binge_score
              FROM binge_base
              ORDER BY binge_score DESC
              LIMIT ${limit}
            `);

            bingeShows = (bingeResult.rows as unknown as RawBingeRow[]).map((row) => ({
              showTitle: row.show_title,
              primaryServerId: row.primary_server_id,
              thumbPath: row.thumb_path,
              totalEpisodeWatches: parseInt(row.total_episode_watches, 10),
              consecutiveEpisodes: parseInt(row.consecutive_episodes, 10),
              consecutivePct: parseFloat(row.consecutive_pct || '0'),
              avgGapMinutes: parseFloat(row.avg_gap_minutes || '0'),
              bingeScore: parseFloat(row.binge_score),
              maxEpisodesInOneDay: parseInt(row.max_episodes_in_one_day || '1', 10),
              serverIds: row.server_ids ? row.server_ids.split(',') : [row.primary_server_id],
            }));
          })()
        );
      }

      if (includePeakTimes) {
        queries.push(
          (async () => {
            const hourlyResult = await db.execute(sql`
              WITH hourly AS (
                SELECT
                  EXTRACT(HOUR FROM sess.started_at AT TIME ZONE ${tz})::int AS hour,
                  COUNT(*) AS watch_count,
                  SUM(sess.duration_ms) AS total_watch_ms
                FROM sessions sess
                JOIN library_items li ON sess.rating_key = li.rating_key
                  AND sess.server_id = li.server_id
                  AND li.removed_at IS NULL
                WHERE sess.duration_ms >= 120000
                  AND sess.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                  ${serverFragmentLi}
                  ${libraryFilter}
                GROUP BY 1
              ),
              total AS (
                SELECT SUM(watch_count) AS total FROM hourly
              )
              SELECT
                h.hour::text AS hour,
                h.watch_count::text AS watch_count,
                h.total_watch_ms::text AS total_watch_ms,
                ROUND((100.0 * h.watch_count / NULLIF(t.total, 0))::numeric, 1)::text AS pct_of_total
              FROM hourly h
              CROSS JOIN total t
              ORDER BY h.hour
            `);

            hourlyDistribution = (hourlyResult.rows as unknown as RawHourlyRow[]).map((row) => ({
              hour: parseInt(row.hour, 10),
              watchCount: parseInt(row.watch_count, 10),
              totalWatchMs: parseInt(row.total_watch_ms, 10),
              pctOfTotal: parseFloat(row.pct_of_total || '0'),
            }));

            if (hourlyDistribution.length > 0) {
              peakHour = hourlyDistribution.reduce((max, h) =>
                h.watchCount > max.watchCount ? h : max
              ).hour;
            }

            const peakResult = await db.execute(sql`
              SELECT
                (SELECT EXTRACT(DOW FROM sess.started_at AT TIME ZONE ${tz})::int AS day_of_week
                 FROM sessions sess
                 JOIN library_items li ON sess.rating_key = li.rating_key
                   AND sess.server_id = li.server_id
                   AND li.removed_at IS NULL
                 WHERE sess.duration_ms >= 120000
                   AND sess.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                   ${serverFragmentLi}
                   ${libraryFilter}
                 GROUP BY 1
                 ORDER BY COUNT(*) DESC
                 LIMIT 1
                )::text AS peak_day_of_week
            `);

            const peakRow = peakResult.rows[0] as unknown as { peak_day_of_week: string | null };
            peakDayOfWeek = parseInt(peakRow?.peak_day_of_week || '0', 10);
          })()
        );
      }

      if (includeSeasonalTrends) {
        queries.push(
          (async () => {
            const monthlyResult = await db.execute(sql`
              WITH monthly AS (
                SELECT
                  TO_CHAR(sess.started_at AT TIME ZONE ${tz}, 'YYYY-MM') AS month,
                  COUNT(*) AS watch_count,
                  SUM(sess.duration_ms) AS total_watch_ms,
                  COUNT(DISTINCT li.id) AS unique_items,
                  COUNT(*)::float / EXTRACT(DAY FROM
                    (DATE_TRUNC('month', MIN(sess.started_at AT TIME ZONE ${tz})) + INTERVAL '1 month' - INTERVAL '1 day')
                  ) AS avg_watches_per_day
                FROM sessions sess
                JOIN library_items li ON sess.rating_key = li.rating_key
                  AND sess.server_id = li.server_id
                  AND li.removed_at IS NULL
                WHERE sess.duration_ms >= 120000
                  AND sess.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                  ${serverFragmentLi}
                  ${libraryFilter}
                GROUP BY 1
              )
              SELECT
                month,
                watch_count::text AS watch_count,
                total_watch_ms::text AS total_watch_ms,
                unique_items::text AS unique_items,
                ROUND(avg_watches_per_day::numeric, 1)::text AS avg_watches_per_day
              FROM monthly
              ORDER BY month
            `);

            monthlyTrends = (monthlyResult.rows as unknown as RawMonthlyRow[]).map((row) => ({
              month: row.month,
              watchCount: parseInt(row.watch_count, 10),
              totalWatchMs: parseInt(row.total_watch_ms, 10),
              uniqueItems: parseInt(row.unique_items, 10),
              avgWatchesPerDay: parseFloat(row.avg_watches_per_day),
            }));

            if (monthlyTrends.length > 0) {
              const sorted = [...monthlyTrends].sort((a, b) => b.watchCount - a.watchCount);
              busiestMonth = sorted[0]?.month ?? '';
              quietestMonth = sorted[sorted.length - 1]?.month ?? '';
            }
          })()
        );
      }

      // Summary query (always run) - aggregate across all accessible servers
      queries.push(
        (async () => {
          const summaryResult = await db.execute(sql`
            WITH session_stats AS (
              SELECT
                COUNT(*) AS total_sessions,
                COUNT(*) FILTER (
                  WHERE li.media_type = 'episode'
                    AND (stopped_at - started_at) < INTERVAL '30 minutes'
                ) AS potential_binge_sessions
              FROM sessions sess
              JOIN library_items li ON sess.rating_key = li.rating_key
                AND sess.server_id = li.server_id
                AND li.removed_at IS NULL
              WHERE sess.duration_ms >= 120000
                AND sess.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                ${serverFragmentLi}
                ${libraryFilter}
            ),
            day_count AS (
              SELECT COUNT(DISTINCT DATE(sess.started_at)) AS days
              FROM sessions sess
              JOIN library_items li ON sess.rating_key = li.rating_key
                AND sess.server_id = li.server_id
                AND li.removed_at IS NULL
              WHERE sess.duration_ms >= 120000
                AND sess.started_at >= NOW() - INTERVAL '1 week' * ${periodWeeks}
                ${serverFragmentLi}
                ${libraryFilter}
            )
            SELECT
              s.total_sessions::text AS total_watch_sessions,
              ROUND((s.total_sessions::numeric / NULLIF(d.days, 0)), 1)::text AS avg_sessions_per_day,
              ROUND((100.0 * s.potential_binge_sessions / NULLIF(s.total_sessions, 0))::numeric, 1)::text AS binge_sessions_pct
            FROM session_stats s
            CROSS JOIN day_count d
          `);

          const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow | undefined;
          if (summaryRow) {
            totalWatchSessions = parseInt(summaryRow.total_watch_sessions || '0', 10);
            avgSessionsPerDay = parseFloat(summaryRow.avg_sessions_per_day || '0');
            bingeSessionsPct = parseFloat(summaryRow.binge_sessions_pct || '0');
          }
        })()
      );

      await Promise.all(queries);

      const response: PatternsResponse = {
        bingeShows,
        peakTimes: {
          hourlyDistribution,
          peakHour,
          peakDayOfWeek,
        },
        seasonalTrends: {
          monthlyTrends,
          busiestMonth,
          quietestMonth,
        },
        summary: {
          totalWatchSessions,
          avgSessionsPerDay,
          bingeSessionsPct,
        },
      };

      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_PATTERNS, JSON.stringify(response));
      return response;
    }
  );
};
