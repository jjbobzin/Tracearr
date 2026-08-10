/**
 * Library Watch Statistics Route
 *
 * GET /watch - Per-item watch counts and watched/unwatched ratios
 *
 * Joins library_items with sessions table to provide:
 * - Watch count per item
 * - Total watch time per item
 * - Last watched timestamp
 * - Summary with watched/unwatched ratio
 *
 * Single-server path: counts are per library_items row, no external-ID dedup —
 * matches main branch behavior exactly.
 *
 * Multi-server path: titles are collapsed by media identity (media_id, falling back
 * to the item id) so the same movie on two servers counts as ONE title in the summary
 * KPIs and in the Most Watched list. Watch events (plays, duration) are SUMMED across
 * servers.
 *
 * Uses LEFT JOIN to ensure items without sessions return 0 watch count.
 * A play is one resume chain (COALESCE(reference_id, id)) gated at 2 minutes (120000ms).
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryWatchQuerySchema,
  type LibraryWatchQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { resolutionRankSql } from '../../utils/resolutionBuckets.js';
import { buildLibraryCacheKey } from './utils.js';

/** Individual library item with watch statistics (deduped across servers when multiple in scope) */
interface WatchItem {
  id: string;
  serverId: string;
  serverName: string;
  libraryId: string;
  title: string;
  mediaType: string;
  year: number | null;
  fileSize: number | null;
  resolution: string | null;
  addedAt: string;
  watchCount: number;
  totalWatchMs: number;
  lastWatchedAt: string | null;
  serverIds: string[];
}

/** Summary statistics for watch data (deduped titles for counts, summed for events) */
interface WatchSummary {
  totalItems: number;
  watchedCount: number;
  unwatchedCount: number;
  watchedPct: number;
  totalWatchMs: number;
  avgWatchesPerItem: number;
  completedCount: number;
}

/** Full response for watch statistics endpoint */
interface WatchResponse {
  items: WatchItem[];
  summary: WatchSummary;
  pagination: { page: number; pageSize: number; total: number };
}

/** Raw row returned when items exist on the current page — single-server path */
interface RawSingleRow {
  id: string;
  server_id: string;
  server_name: string;
  library_id: string;
  title: string;
  media_type: string;
  year: number | null;
  file_size: string | null;
  video_resolution: string | null;
  added_at: string;
  watch_count: string;
  total_watch_ms: string;
  last_watched_at: string | null;
  // summary fields (same for all rows via cross join)
  _total_items: string;
  _watched_count: string;
  _unwatched_count: string;
  _total_watch_ms: string;
  _avg_watches_per_item: string | null;
  _completed_count: string;
}

/** Raw row returned when items exist on the current page — multi-server (deduped) path */
interface RawCombinedRow {
  match_key: string | null;
  primary_id: string;
  primary_server_id: string;
  primary_server_name: string;
  primary_library_id: string;
  title: string;
  media_type: string;
  year: number | null;
  file_size: string | null;
  video_resolution: string | null;
  added_at: string;
  watch_count: string;
  total_watch_ms: string;
  last_watched_at: string | null;
  // aggregated server ids for this deduped title
  server_ids: string;
  // summary fields (same for all rows via cross join)
  _total_items: string;
  _watched_count: string;
  _unwatched_count: string;
  _total_watch_ms: string;
  _avg_watches_per_item: string | null;
  _completed_count: string;
}

/** Raw summary row used when the current page is empty */
interface RawSummaryRow {
  total_items: string;
  watched_count: string;
  unwatched_count: string;
  total_watch_ms: string;
  avg_watches_per_item: string | null;
  completed_count: string;
}

export const libraryWatchRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /watch - Library watch statistics
   *
   * Returns per-title watch counts with summary ratios.
   * Supports filtering by server(s), library, media type, and watch count ranges.
   */
  app.get<{ Querystring: LibraryWatchQueryInput }>(
    '/watch',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryWatchQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        serverIds: rawServerIds,
        libraryId,
        mediaType,
        minWatchCount,
        maxWatchCount,
        includeUnwatched,
        sortBy,
        sortOrder,
        page,
        pageSize,
      } = query.data;
      const authUser = request.user;

      const resolvedIds = resolveServerIds(authUser, serverId, rawServerIds);
      // Empty resolvedIds means user has no accessible servers
      if (resolvedIds?.length === 0) {
        const empty: WatchResponse = {
          items: [],
          summary: {
            totalItems: 0,
            watchedCount: 0,
            unwatchedCount: 0,
            watchedPct: 0,
            totalWatchMs: 0,
            avgWatchesPerItem: 0,
            completedCount: 0,
          },
          pagination: { page, pageSize, total: 0 },
        };
        return empty;
      }

      // Single-server when the caller scoped to exactly one server;
      // undefined (owner-all) is treated as multi so dedup applies.
      const singleServer = resolvedIds?.length === 1;

      const serverFragment = buildMultiServerFragment(resolvedIds, 'li.server_id');

      // Build cache key incorporating serverIds so multi/single-server don't collide
      const serverCacheKey = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_WATCH,
        serverCacheKey,
        `${libraryId ?? 'all'}-${mediaType ?? 'all'}-${minWatchCount ?? 'none'}-${maxWatchCount ?? 'none'}-${includeUnwatched}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as WatchResponse;
        } catch {
          // Fall through to compute
        }
      }

      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;
      // mediaType is always one of movie/episode/show (see libraryWatchQuerySchema); season
      // is never selectable and, unfiltered, would show up as a permanent 0-watch item.
      const mediaTypeFilter = mediaType
        ? sql`AND li.media_type = ${mediaType}`
        : sql`AND li.media_type != 'season'`;

      const minWatchFilter =
        minWatchCount !== undefined ? sql`AND watch_count >= ${minWatchCount}` : sql``;
      const maxWatchFilter =
        maxWatchCount !== undefined ? sql`AND watch_count <= ${maxWatchCount}` : sql``;
      const unwatchedFilter = !includeUnwatched ? sql`AND watch_count > 0` : sql``;

      const sortColumnMap = {
        watch_count: sql`watch_count`,
        last_watched: sql`last_watched_at`,
        title: sql`title`,
        file_size: sql`file_size`,
      };
      const sortColumn = sortColumnMap[sortBy] || sql`watch_count`;
      const sortDir = sortOrder === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS FIRST`;

      const offset = (page - 1) * pageSize;

      let items: WatchItem[];
      let totalItems: number;
      let watchedCount: number;
      let summary: WatchSummary;

      if (singleServer) {
        // Single-server path: per library_items row, no match_key dedup — matches main.
        // item_watch_stats -> filtered_items -> summary_stats -> paginated_items
        const combinedResult = await db.execute(sql`
          WITH item_watch_stats AS (
            -- One row per library_item; attaches session aggregates
            SELECT
              li.id,
              li.server_id,
              s.name AS server_name,
              li.library_id,
              li.title,
              li.media_type,
              li.year,
              li.file_size,
              li.video_resolution,
              li.created_at AS added_at,
              COUNT(DISTINCT COALESCE(sess.reference_id, sess.id)) FILTER (WHERE COALESCE(sess.duration_ms, 0) >= 120000) AS watch_count,
              COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0) AS total_watch_ms,
              MAX(sess.stopped_at) AS last_watched_at,
              BOOL_OR(
                sess.duration_ms IS NOT NULL
                AND sess.total_duration_ms IS NOT NULL
                AND sess.total_duration_ms > 0
                AND (sess.duration_ms::float / sess.total_duration_ms) >= 0.85
              ) AS has_completion
            FROM library_items li
            JOIN servers s ON li.server_id = s.id
            LEFT JOIN sessions sess ON sess.rating_key = li.rating_key
              AND sess.server_id = li.server_id
            WHERE 1=1
              AND li.removed_at IS NULL
              ${serverFragment}
              ${libraryFilter}
              ${mediaTypeFilter}
            GROUP BY li.id, li.server_id, s.name, li.library_id, li.title,
                     li.media_type, li.year, li.file_size, li.video_resolution, li.created_at
          ),
          filtered_items AS (
            SELECT * FROM item_watch_stats
            WHERE 1=1
              ${minWatchFilter}
              ${maxWatchFilter}
              ${unwatchedFilter}
          ),
          summary_stats AS (
            SELECT
              COUNT(*) AS total_items,
              COUNT(*) FILTER (WHERE watch_count > 0) AS watched_count,
              COUNT(*) FILTER (WHERE watch_count = 0) AS unwatched_count,
              COALESCE(SUM(total_watch_ms), 0) AS total_watch_ms,
              ROUND(AVG(watch_count)::numeric, 2) AS avg_watches_per_item,
              COUNT(*) FILTER (WHERE has_completion) AS completed_count
            FROM filtered_items
          ),
          paginated_items AS (
            SELECT * FROM filtered_items
            ORDER BY ${sortColumn} ${sortDir}
            LIMIT ${pageSize} OFFSET ${offset}
          )
          SELECT
            pi.id,
            pi.server_id,
            pi.server_name,
            pi.library_id,
            pi.title,
            pi.media_type,
            pi.year,
            pi.file_size::text AS file_size,
            pi.video_resolution,
            pi.added_at::text AS added_at,
            pi.watch_count::text AS watch_count,
            pi.total_watch_ms::text AS total_watch_ms,
            pi.last_watched_at::text AS last_watched_at,
            ss.total_items::text AS _total_items,
            ss.watched_count::text AS _watched_count,
            ss.unwatched_count::text AS _unwatched_count,
            ss.total_watch_ms::text AS _total_watch_ms,
            ss.avg_watches_per_item::text AS _avg_watches_per_item,
            ss.completed_count::text AS _completed_count
          FROM paginated_items pi
          CROSS JOIN summary_stats ss
        `);

        const rows = combinedResult.rows as unknown as RawSingleRow[];

        items = rows.map((row) => ({
          id: row.id,
          serverId: row.server_id,
          serverName: row.server_name,
          libraryId: row.library_id,
          title: row.title,
          mediaType: row.media_type,
          year: row.year,
          fileSize: row.file_size ? parseInt(row.file_size, 10) : null,
          resolution: row.video_resolution,
          addedAt: row.added_at,
          watchCount: parseInt(row.watch_count, 10),
          totalWatchMs: parseInt(row.total_watch_ms, 10),
          lastWatchedAt: row.last_watched_at,
          // Single-server: the item's own server is the only server
          serverIds: [row.server_id],
        }));

        if (rows.length > 0) {
          const firstRow = rows[0]!;
          totalItems = parseInt(firstRow._total_items, 10) || 0;
          watchedCount = parseInt(firstRow._watched_count, 10) || 0;
          const unwatchedCount = parseInt(firstRow._unwatched_count, 10) || 0;
          summary = {
            totalItems,
            watchedCount,
            unwatchedCount,
            watchedPct:
              totalItems > 0 ? Math.round((watchedCount / totalItems) * 100 * 10) / 10 : 0,
            totalWatchMs: parseInt(firstRow._total_watch_ms, 10) || 0,
            avgWatchesPerItem: parseFloat(firstRow._avg_watches_per_item || '0'),
            completedCount: parseInt(firstRow._completed_count, 10) || 0,
          };
        } else {
          // No items on current page; run a minimal summary-only query
          const summaryResult = await db.execute(sql`
            WITH item_watch_stats AS (
              SELECT
                li.id,
                li.server_id,
                COUNT(DISTINCT COALESCE(sess.reference_id, sess.id)) FILTER (WHERE COALESCE(sess.duration_ms, 0) >= 120000) AS watch_count,
                COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0) AS total_watch_ms,
                BOOL_OR(
                  sess.duration_ms IS NOT NULL
                  AND sess.total_duration_ms IS NOT NULL
                  AND sess.total_duration_ms > 0
                  AND (sess.duration_ms::float / sess.total_duration_ms) >= 0.85
                ) AS has_completion
              FROM library_items li
              LEFT JOIN sessions sess ON sess.rating_key = li.rating_key AND sess.server_id = li.server_id
              WHERE 1=1 AND li.removed_at IS NULL ${serverFragment} ${libraryFilter} ${mediaTypeFilter}
              GROUP BY li.id, li.server_id
            ),
            filtered AS (
              SELECT * FROM item_watch_stats
              WHERE 1=1 ${minWatchFilter} ${maxWatchFilter} ${unwatchedFilter}
            )
            SELECT
              COUNT(*)::text AS total_items,
              COUNT(*) FILTER (WHERE watch_count > 0)::text AS watched_count,
              COUNT(*) FILTER (WHERE watch_count = 0)::text AS unwatched_count,
              COALESCE(SUM(total_watch_ms), 0)::text AS total_watch_ms,
              ROUND(AVG(watch_count)::numeric, 2)::text AS avg_watches_per_item,
              COUNT(*) FILTER (WHERE has_completion)::text AS completed_count
            FROM filtered
          `);
          const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow;
          totalItems = parseInt(summaryRow.total_items, 10) || 0;
          watchedCount = parseInt(summaryRow.watched_count, 10) || 0;
          const unwatchedCount = parseInt(summaryRow.unwatched_count, 10) || 0;
          summary = {
            totalItems,
            watchedCount,
            unwatchedCount,
            watchedPct:
              totalItems > 0 ? Math.round((watchedCount / totalItems) * 100 * 10) / 10 : 0,
            totalWatchMs: parseInt(summaryRow.total_watch_ms, 10) || 0,
            avgWatchesPerItem: parseFloat(summaryRow.avg_watches_per_item || '0'),
            completedCount: parseInt(summaryRow.completed_count, 10) || 0,
          };
        }
      } else {
        // Multi-server path: collapse the same media across servers by match_key.
        // Plays and duration are SUMMED; inventory/completion are DISTINCT.
        const combinedResult = await db.execute(sql`
          WITH item_watch_stats AS (
            -- One row per library_item; attaches session aggregates
            SELECT
              li.id,
              li.server_id,
              s.name AS server_name,
              li.library_id,
              li.title,
              li.media_type,
              li.year,
              li.file_size,
              li.video_resolution,
              li.created_at AS added_at,
              COALESCE(li.media_id::text, li.id::text) AS match_key,
              COUNT(DISTINCT COALESCE(sess.reference_id, sess.id)) FILTER (WHERE COALESCE(sess.duration_ms, 0) >= 120000) AS watch_count,
              COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0) AS total_watch_ms,
              MAX(sess.stopped_at) AS last_watched_at,
              -- Completion signal: any session covering 85%+ of total_duration_ms
              BOOL_OR(
                sess.duration_ms IS NOT NULL
                AND sess.total_duration_ms IS NOT NULL
                AND sess.total_duration_ms > 0
                AND (sess.duration_ms::float / sess.total_duration_ms) >= 0.85
              ) AS has_completion
            FROM library_items li
            JOIN servers s ON li.server_id = s.id
            LEFT JOIN sessions sess ON sess.rating_key = li.rating_key
              AND sess.server_id = li.server_id
            WHERE 1=1
              AND li.removed_at IS NULL
              ${serverFragment}
              ${libraryFilter}
              ${mediaTypeFilter}
            GROUP BY li.id, li.server_id, s.name, li.library_id, li.title,
                     li.media_type, li.year, li.file_size, li.video_resolution, li.created_at
          ),
          deduped_stats AS (
            -- Collapse same title across servers into one row using match_key.
            -- Plays and duration are SUMMED (events); inventory/completion are DISTINCT.
            SELECT
              match_key,
              -- Pick the lexicographically smallest id/server to provide a stable primary row
              -- (id/server_id are uuid; cast to text since Postgres has no min(uuid))
              MIN(id::text) AS primary_id,
              MIN(server_id::text) AS primary_server_id,
              MIN(server_name) AS primary_server_name,
              MIN(library_id) AS primary_library_id,
              MIN(title) AS title,
              MIN(media_type) AS media_type,
              MIN(year) AS year,
              MAX(file_size) AS file_size,
              (ARRAY_AGG(video_resolution ORDER BY ${resolutionRankSql('video_resolution')} DESC))[1]
                AS video_resolution,
              MIN(added_at::text) AS added_at,
              -- Sum events across all copies of this title
              SUM(watch_count) AS watch_count,
              SUM(total_watch_ms) AS total_watch_ms,
              MAX(last_watched_at::text) AS last_watched_at,
              BOOL_OR(has_completion) AS has_completion,
              -- Collect all server_ids that own a copy (for frontend color dots)
              ARRAY_AGG(DISTINCT server_id ORDER BY server_id) AS server_ids_arr
            FROM item_watch_stats
            GROUP BY match_key
          ),
          filtered_items AS (
            SELECT * FROM deduped_stats
            WHERE 1=1
              ${minWatchFilter}
              ${maxWatchFilter}
              ${unwatchedFilter}
          ),
          summary_stats AS (
            SELECT
              COUNT(*) AS total_items,
              COUNT(*) FILTER (WHERE watch_count > 0) AS watched_count,
              COUNT(*) FILTER (WHERE watch_count = 0) AS unwatched_count,
              COALESCE(SUM(total_watch_ms), 0) AS total_watch_ms,
              ROUND(AVG(watch_count)::numeric, 2) AS avg_watches_per_item,
              COUNT(*) FILTER (WHERE has_completion) AS completed_count
            FROM filtered_items
          ),
          paginated_items AS (
            SELECT * FROM filtered_items
            ORDER BY ${sortColumn} ${sortDir}
            LIMIT ${pageSize} OFFSET ${offset}
          )
          SELECT
            pi.match_key,
            pi.primary_id,
            pi.primary_server_id,
            pi.primary_server_name,
            pi.primary_library_id,
            pi.title,
            pi.media_type,
            pi.year,
            pi.file_size::text AS file_size,
            pi.video_resolution,
            pi.added_at,
            pi.watch_count::text AS watch_count,
            pi.total_watch_ms::text AS total_watch_ms,
            pi.last_watched_at,
            ARRAY_TO_STRING(pi.server_ids_arr, ',') AS server_ids,
            ss.total_items::text AS _total_items,
            ss.watched_count::text AS _watched_count,
            ss.unwatched_count::text AS _unwatched_count,
            ss.total_watch_ms::text AS _total_watch_ms,
            ss.avg_watches_per_item::text AS _avg_watches_per_item,
            ss.completed_count::text AS _completed_count
          FROM paginated_items pi
          CROSS JOIN summary_stats ss
        `);

        const rows = combinedResult.rows as unknown as RawCombinedRow[];

        items = rows.map((row) => ({
          id: row.primary_id,
          serverId: row.primary_server_id,
          serverName: row.primary_server_name,
          libraryId: row.primary_library_id,
          title: row.title,
          mediaType: row.media_type,
          year: row.year,
          fileSize: row.file_size ? parseInt(row.file_size, 10) : null,
          resolution: row.video_resolution,
          addedAt: row.added_at,
          watchCount: parseInt(row.watch_count, 10),
          totalWatchMs: parseInt(row.total_watch_ms, 10),
          lastWatchedAt: row.last_watched_at,
          serverIds: row.server_ids ? row.server_ids.split(',') : [row.primary_server_id],
        }));

        if (rows.length > 0) {
          const firstRow = rows[0]!;
          totalItems = parseInt(firstRow._total_items, 10) || 0;
          watchedCount = parseInt(firstRow._watched_count, 10) || 0;
          const unwatchedCount = parseInt(firstRow._unwatched_count, 10) || 0;
          summary = {
            totalItems,
            watchedCount,
            unwatchedCount,
            watchedPct:
              totalItems > 0 ? Math.round((watchedCount / totalItems) * 100 * 10) / 10 : 0,
            totalWatchMs: parseInt(firstRow._total_watch_ms, 10) || 0,
            avgWatchesPerItem: parseFloat(firstRow._avg_watches_per_item || '0'),
            completedCount: parseInt(firstRow._completed_count, 10) || 0,
          };
        } else {
          // No items on current page; run a minimal summary-only query
          const summaryResult = await db.execute(sql`
            WITH item_watch_stats AS (
              SELECT
                li.id,
                li.server_id,
                COALESCE(li.media_id::text, li.id::text) AS match_key,
                COUNT(DISTINCT COALESCE(sess.reference_id, sess.id)) FILTER (WHERE COALESCE(sess.duration_ms, 0) >= 120000) AS watch_count,
                COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0) AS total_watch_ms,
                BOOL_OR(
                  sess.duration_ms IS NOT NULL
                  AND sess.total_duration_ms IS NOT NULL
                  AND sess.total_duration_ms > 0
                  AND (sess.duration_ms::float / sess.total_duration_ms) >= 0.85
                ) AS has_completion
              FROM library_items li
              LEFT JOIN sessions sess ON sess.rating_key = li.rating_key AND sess.server_id = li.server_id
              WHERE 1=1 AND li.removed_at IS NULL ${serverFragment} ${libraryFilter} ${mediaTypeFilter}
              GROUP BY li.id, li.server_id
            ),
            deduped AS (
              SELECT match_key, SUM(watch_count) AS watch_count, SUM(total_watch_ms) AS total_watch_ms,
                BOOL_OR(has_completion) AS has_completion
              FROM item_watch_stats GROUP BY match_key
            ),
            filtered AS (SELECT * FROM deduped WHERE 1=1 ${minWatchFilter} ${maxWatchFilter} ${unwatchedFilter})
            SELECT
              COUNT(*)::text AS total_items,
              COUNT(*) FILTER (WHERE watch_count > 0)::text AS watched_count,
              COUNT(*) FILTER (WHERE watch_count = 0)::text AS unwatched_count,
              COALESCE(SUM(total_watch_ms), 0)::text AS total_watch_ms,
              ROUND(AVG(watch_count)::numeric, 2)::text AS avg_watches_per_item,
              COUNT(*) FILTER (WHERE has_completion)::text AS completed_count
            FROM filtered
          `);
          const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow;
          totalItems = parseInt(summaryRow.total_items, 10) || 0;
          watchedCount = parseInt(summaryRow.watched_count, 10) || 0;
          const unwatchedCount = parseInt(summaryRow.unwatched_count, 10) || 0;
          summary = {
            totalItems,
            watchedCount,
            unwatchedCount,
            watchedPct:
              totalItems > 0 ? Math.round((watchedCount / totalItems) * 100 * 10) / 10 : 0,
            totalWatchMs: parseInt(summaryRow.total_watch_ms, 10) || 0,
            avgWatchesPerItem: parseFloat(summaryRow.avg_watches_per_item || '0'),
            completedCount: parseInt(summaryRow.completed_count, 10) || 0,
          };
        }
      }

      const response: WatchResponse = {
        items,
        summary,
        pagination: { page, pageSize, total: totalItems },
      };

      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_WATCH, JSON.stringify(response));
      return response;
    }
  );
};
