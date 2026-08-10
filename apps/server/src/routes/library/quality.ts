/**
 * Library Quality Evolution Route
 *
 * GET /quality - Quality distribution over time from library_items
 *
 * Uses library_items.video_resolution and created_at for accurate quality tracking
 * based on when items were actually added to the media server.
 *
 * Supports filtering by media type:
 * - 'all': All video content (movies + TV)
 * - 'movies': Only movies
 * - 'shows': Only episodes
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  TIME_MS,
  libraryQualityQuerySchema,
  type LibraryQualityQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import {
  validateServerAccess,
  resolveServerIds,
  buildMultiServerFragment,
} from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

/** Single data point in quality timeline */
interface QualityDataPoint {
  day: string;
  totalItems: number;
  // Absolute counts
  count4k: number;
  count1080p: number;
  count720p: number;
  countSd: number;
  // Percentages
  pct4k: number;
  pct1080p: number;
  pct720p: number;
  pctSd: number;
  // Codec counts
  hevcCount: number;
  h264Count: number;
  av1Count: number;
}

/** Library quality evolution response */
interface LibraryQualityResponse {
  period: string;
  mediaType: 'all' | 'movies' | 'shows';
  data: QualityDataPoint[];
}

/**
 * Calculate start date based on period string.
 */
function getStartDate(period: '7d' | '30d' | '90d' | '1y' | 'all'): Date | null {
  const now = new Date();
  switch (period) {
    case '7d':
      return new Date(now.getTime() - 7 * TIME_MS.DAY);
    case '30d':
      return new Date(now.getTime() - 30 * TIME_MS.DAY);
    case '90d':
      return new Date(now.getTime() - 90 * TIME_MS.DAY);
    case '1y':
      return new Date(now.getTime() - 365 * TIME_MS.DAY);
    case 'all':
      return null;
  }
}

export const libraryQualityRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /quality - Quality evolution timeline
   *
   * Returns daily quality distribution snapshots showing resolution breakdowns.
   * Uses library_stats_daily continuous aggregate with media type filtering.
   *
   * Media type filtering:
   * - 'all': All video libraries (movie_count > 0 OR episode_count > 0)
   * - 'movies': Only movie libraries (movie_count > 0 AND episode_count = 0)
   * - 'shows': Only TV libraries (episode_count > 0)
   */
  app.get<{ Querystring: LibraryQualityQueryInput }>(
    '/quality',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryQualityQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, period, mediaType, timezone } = query.data;
      const authUser = request.user;
      const tz = timezone ?? 'UTC';

      // Validate server access if specific server requested
      if (serverId) {
        const error = validateServerAccess(authUser, serverId);
        if (error) {
          return reply.forbidden(error);
        }
      }

      const resolvedIds = resolveServerIds(authUser, serverId, undefined, { strict: false });
      const serverCacheSegment =
        resolvedIds !== undefined ? resolvedIds.slice().sort().join(',') : 'all';

      // Build cache key with all varying params including mediaType
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_QUALITY,
        serverCacheSegment,
        `${period}:${mediaType}`,
        tz
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibraryQualityResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Calculate date range
      const startDate = getStartDate(period);
      const endDate = new Date();

      // Build server filter for library_stats_daily
      const serverFilter = buildMultiServerFragment(resolvedIds, 'lsd.server_id');

      // Media type filter - filter by library type (movie-only vs TV vs all video)
      // Libraries are typically homogeneous in Plex, so we filter based on content counts
      let mediaTypeFilter: ReturnType<typeof sql>;
      switch (mediaType) {
        case 'movies':
          // Movie-only libraries: have movies but no episodes
          mediaTypeFilter = sql`AND lsd.movie_count > 0 AND lsd.episode_count = 0`;
          break;
        case 'shows':
          // TV libraries: have episodes
          mediaTypeFilter = sql`AND lsd.episode_count > 0`;
          break;
        case 'all':
        default:
          // All video libraries: have either movies or episodes
          mediaTypeFilter = sql`AND (lsd.movie_count > 0 OR lsd.episode_count > 0)`;
          break;
      }

      // For 'all' period, find the earliest snapshot date from library_stats_daily
      let effectiveStartDate: Date;
      if (startDate) {
        effectiveStartDate = startDate;
      } else {
        const earliestResult = await db.execute(sql`
          SELECT MIN(day)::date AS earliest
          FROM library_stats_daily lsd
          WHERE 1=1
            ${serverFilter}
        `);
        const earliest = (earliestResult.rows[0] as { earliest: string | null })?.earliest;
        effectiveStartDate = earliest ? new Date(earliest) : new Date('2020-01-01');
      }

      // Query library_stats_daily continuous aggregate
      // This uses pre-computed daily snapshots that already contain cumulative totals
      // After backfill, every day should have a snapshot, so gaps are unlikely
      const result = await db.execute(sql`
        WITH date_series AS (
          -- Generate all dates in the range
          SELECT d::date AS day
          FROM generate_series(
            ${effectiveStartDate.toISOString()}::date,
            ${endDate.toISOString()}::date,
            '1 day'::interval
          ) d
        ),
        filtered_libraries AS (
          -- Pre-filter libraries by media type before aggregating
          SELECT
            lsd.day,
            lsd.total_items,
            lsd.count_4k,
            lsd.count_1080p,
            lsd.count_720p,
            lsd.count_sd
          FROM library_stats_daily lsd
          WHERE lsd.day >= ${effectiveStartDate.toISOString()}::date
            AND lsd.day <= ${endDate.toISOString()}::date
            ${serverFilter}
            ${mediaTypeFilter}
        ),
        daily_stats AS (
          -- Aggregate quality counts across all matching libraries per day
          SELECT
            fl.day::date AS day,
            COALESCE(SUM(fl.total_items), 0)::int AS total_items,
            COALESCE(SUM(fl.count_4k), 0)::int AS count_4k,
            COALESCE(SUM(fl.count_1080p), 0)::int AS count_1080p,
            COALESCE(SUM(fl.count_720p), 0)::int AS count_720p,
            COALESCE(SUM(fl.count_sd), 0)::int AS count_sd
          FROM filtered_libraries fl
          GROUP BY fl.day::date
        ),
        filled_data AS (
          -- Join date series with actual stats
          -- Use subquery to carry forward last known value for gaps
          SELECT
            ds.day,
            COALESCE(dst.total_items, (
              SELECT total_items FROM daily_stats dst2
              WHERE dst2.day < ds.day ORDER BY dst2.day DESC LIMIT 1
            ), 0)::int AS total_items,
            COALESCE(dst.count_4k, (
              SELECT count_4k FROM daily_stats dst2
              WHERE dst2.day < ds.day ORDER BY dst2.day DESC LIMIT 1
            ), 0)::int AS count_4k,
            COALESCE(dst.count_1080p, (
              SELECT count_1080p FROM daily_stats dst2
              WHERE dst2.day < ds.day ORDER BY dst2.day DESC LIMIT 1
            ), 0)::int AS count_1080p,
            COALESCE(dst.count_720p, (
              SELECT count_720p FROM daily_stats dst2
              WHERE dst2.day < ds.day ORDER BY dst2.day DESC LIMIT 1
            ), 0)::int AS count_720p,
            COALESCE(dst.count_sd, (
              SELECT count_sd FROM daily_stats dst2
              WHERE dst2.day < ds.day ORDER BY dst2.day DESC LIMIT 1
            ), 0)::int AS count_sd
          FROM date_series ds
          LEFT JOIN daily_stats dst ON dst.day = ds.day
        )
        SELECT
          fd.day::text,
          fd.total_items,
          fd.count_4k,
          fd.count_1080p,
          fd.count_720p,
          fd.count_sd
        FROM filled_data fd
        ORDER BY fd.day ASC
      `);

      const rows = result.rows as Array<{
        day: string;
        total_items: number;
        count_4k: number;
        count_1080p: number;
        count_720p: number;
        count_sd: number;
      }>;

      // Calculate percentages in application code
      // totalItems = sum of all quality tiers (we filter out music libraries in the query)
      const data: QualityDataPoint[] = rows.map((row) => {
        // Buckets are overlapping (a 4K+1080p title counts in both), so the
        // denominator is the real title count, not the bucket sum, and
        // percentages describe "share of titles having this tier".
        const total = row.total_items || 1; // Avoid division by zero
        return {
          day: row.day,
          totalItems: row.total_items,
          // Absolute counts
          count4k: row.count_4k,
          count1080p: row.count_1080p,
          count720p: row.count_720p,
          countSd: row.count_sd,
          // Percentages (rounded to 2 decimal places)
          pct4k: Math.round((row.count_4k / total) * 10000) / 100,
          pct1080p: Math.round((row.count_1080p / total) * 10000) / 100,
          pct720p: Math.round((row.count_720p / total) * 10000) / 100,
          pctSd: Math.round((row.count_sd / total) * 10000) / 100,
          // Codec counts not available per-library (set to 0)
          // Codec distribution is shown separately in CodecDistributionSection
          hevcCount: 0,
          h264Count: 0,
          av1Count: 0,
        };
      });

      const response: LibraryQualityResponse = {
        period,
        mediaType,
        data,
      };

      // Cache for 5 minutes
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_QUALITY, JSON.stringify(response));

      return response;
    }
  );
};
