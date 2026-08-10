/**
 * Library Stats Route
 *
 * GET /stats - Current library statistics
 *
 * SINGLE-SERVER PATH (exactly one server in scope):
 *   Uses library_snapshots for consistency with growth charts. Snapshots already
 *   filter out invalid items (missing episodes with no file size), ensuring
 *   accurate counts that match the graph data.
 *
 * MULTI-SERVER PATH (more than one server in scope):
 *   COUNT(DISTINCT matchKey) deduplication across library_items so the same title
 *   on two servers counts once. Storage is always SUM (physical bytes are never deduped).
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryStatsQuerySchema,
  type LibraryStatsQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { hasVersionInBucket } from '../../utils/resolutionBuckets.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey, dedupedStorageBytesSql } from './utils.js';

/** Library stats response shape */
interface LibraryStatsResponse {
  totalItems: number;
  totalSizeBytes: string;
  movieCount: number;
  episodeCount: number;
  showCount: number;
  qualityBreakdown: {
    count4k: number;
    count1080p: number;
    count720p: number;
    countSd: number;
  };
  asOf: string | null;
}

export const libraryStatsRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /stats - Current library statistics
   *
   * Returns aggregated library statistics. Single-server requests use
   * library_snapshots for consistency with growth charts; multi-server requests
   * use library_items with COUNT(DISTINCT matchKey) deduplication.
   */
  app.get<{ Querystring: LibraryStatsQueryInput }>(
    '/stats',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryStatsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { serverId, serverIds, libraryId, timezone } = query.data;
      const authUser = request.user;
      const tz = timezone ?? 'UTC';

      const resolvedIds = resolveServerIds(authUser, serverId, serverIds);

      // Use snapshot path when scoped to exactly one server — values match growth charts
      const singleServer = resolvedIds?.length === 1;

      // Build cache key - include sorted server IDs so order doesn't cause misses
      const serverCacheKey = resolvedIds !== undefined ? [...resolvedIds].sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(REDIS_KEYS.LIBRARY_STATS, serverCacheKey, tz);
      const fullCacheKey = libraryId ? `${cacheKey}:${libraryId}` : cacheKey;

      const cached = await app.redis.get(fullCacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibraryStatsResponse;
        } catch {
          // Fall through to compute
        }
      }

      let stats: LibraryStatsResponse;

      // Mirror-deduped bytes (#478): the same physical file in several
      // libraries or servers counts once. Used by both paths below in place
      // of snapshot/flat sums, which per-library-sum mirrored files.
      const dedupedServerFilter = buildMultiServerFragment(resolvedIds, 'li.server_id');
      const dedupedLibraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;
      const dedupedResult = await db.execute(sql`
        SELECT ${dedupedStorageBytesSql(dedupedServerFilter, dedupedLibraryFilter)}::bigint AS total
      `);
      const dedupedBytes = String(
        (dedupedResult.rows[0] as { total: string } | undefined)?.total ?? '0'
      );

      if (singleServer) {
        // Single-server: query library_snapshots verbatim (matches main branch + growth charts)
        const serverFilter = sql`AND ls.server_id = ${resolvedIds[0]}::uuid`;
        const libraryFilter = libraryId ? sql`AND ls.library_id = ${libraryId}` : sql``;

        const result = await db.execute(sql`
          WITH latest_snapshots AS (
            SELECT DISTINCT ON (ls.server_id, ls.library_id)
              ls.item_count,
              ls.total_size,
              ls.movie_count,
              ls.episode_count,
              ls.show_count,
              ls.count_4k,
              ls.count_1080p,
              ls.count_720p,
              ls.count_sd,
              ls.snapshot_time
            FROM library_snapshots ls
            WHERE 1=1
              ${serverFilter}
              ${libraryFilter}
            ORDER BY ls.server_id, ls.library_id, ls.snapshot_time DESC
          )
          SELECT
            COALESCE(SUM(item_count), 0)::int AS total_items,
            COALESCE(SUM(total_size), 0)::bigint AS total_size_bytes,
            COALESCE(SUM(movie_count), 0)::int AS movie_count,
            COALESCE(SUM(episode_count), 0)::int AS episode_count,
            COALESCE(SUM(show_count), 0)::int AS show_count,
            COALESCE(SUM(count_4k), 0)::int AS count_4k,
            COALESCE(SUM(count_1080p), 0)::int AS count_1080p,
            COALESCE(SUM(count_720p), 0)::int AS count_720p,
            COALESCE(SUM(count_sd), 0)::int AS count_sd,
            MAX(snapshot_time) AS as_of
          FROM latest_snapshots
        `);

        const row = result.rows[0] as
          | {
              total_items: number;
              total_size_bytes: string;
              movie_count: number;
              episode_count: number;
              show_count: number;
              count_4k: number;
              count_1080p: number;
              count_720p: number;
              count_sd: number;
              as_of: string | null;
            }
          | undefined;

        stats = {
          totalItems: row?.total_items ?? 0,
          totalSizeBytes: dedupedBytes,
          movieCount: row?.movie_count ?? 0,
          episodeCount: row?.episode_count ?? 0,
          showCount: row?.show_count ?? 0,
          qualityBreakdown: {
            count4k: row?.count_4k ?? 0,
            count1080p: row?.count_1080p ?? 0,
            count720p: row?.count_720p ?? 0,
            countSd: row?.count_sd ?? 0,
          },
          asOf: row?.as_of ?? null,
        };
      } else {
        // Multi-server: deduplicate inventory via COUNT(DISTINCT matchKey)
        const serverFilter = buildMultiServerFragment(resolvedIds, 'li.server_id');
        const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;

        const matchKey = sql`COALESCE(li.media_id::text, li.id::text)`;

        const result = await db.execute(sql`
          SELECT
            COUNT(DISTINCT CASE WHEN li.file_size > 0 OR li.media_type IN ('show', 'season') THEN ${matchKey} END)::int AS total_items,
            0::bigint AS total_size_bytes,
            COUNT(DISTINCT CASE WHEN li.media_type = 'movie' THEN ${matchKey} END)::int AS movie_count,
            COUNT(DISTINCT CASE WHEN li.media_type = 'episode' THEN ${matchKey} END)::int AS episode_count,
            COUNT(DISTINCT CASE WHEN li.media_type = 'show' THEN ${matchKey} END)::int AS show_count,
            COUNT(CASE WHEN (li.file_size > 0 OR li.media_type IN ('show', 'season')) AND ${hasVersionInBucket('li.id', '4k')} THEN 1 END)::int AS count_4k,
            COUNT(CASE WHEN (li.file_size > 0 OR li.media_type IN ('show', 'season')) AND ${hasVersionInBucket('li.id', '1080p')} THEN 1 END)::int AS count_1080p,
            COUNT(CASE WHEN (li.file_size > 0 OR li.media_type IN ('show', 'season')) AND ${hasVersionInBucket('li.id', '720p')} THEN 1 END)::int AS count_720p,
            COUNT(CASE WHEN (li.file_size > 0 OR li.media_type IN ('show', 'season')) AND ${hasVersionInBucket('li.id', 'sd')} THEN 1 END)::int AS count_sd,
            MAX(li.updated_at)::text AS as_of
          FROM library_items li
          WHERE 1=1
            AND li.removed_at IS NULL
            ${serverFilter}
            ${libraryFilter}
        `);

        const row = result.rows[0] as
          | {
              total_items: number;
              total_size_bytes: string;
              movie_count: number;
              episode_count: number;
              show_count: number;
              count_4k: number;
              count_1080p: number;
              count_720p: number;
              count_sd: number;
              as_of: string | null;
            }
          | undefined;

        stats = {
          totalItems: row?.total_items ?? 0,
          totalSizeBytes: dedupedBytes,
          movieCount: row?.movie_count ?? 0,
          episodeCount: row?.episode_count ?? 0,
          showCount: row?.show_count ?? 0,
          qualityBreakdown: {
            count4k: row?.count_4k ?? 0,
            count1080p: row?.count_1080p ?? 0,
            count720p: row?.count_720p ?? 0,
            countSd: row?.count_sd ?? 0,
          },
          asOf: row?.as_of ?? null,
        };
      }

      await app.redis.setex(fullCacheKey, CACHE_TTL.LIBRARY_STATS, JSON.stringify(stats));

      return stats;
    }
  );
};
