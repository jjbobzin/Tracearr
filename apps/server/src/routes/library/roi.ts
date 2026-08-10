/**
 * Library ROI (Return on Investment) Route
 *
 * GET /roi - Calculate watch value per storage cost for content optimization
 *
 * Features:
 * - Watch hours per GB calculation for each item
 * - Value scoring (0-100) with content-type-specific thresholds
 * - Age decay factor for staleness consideration
 * - Deletion suggestions for low-value, unwatched content
 *
 * Uses LEFT JOIN with sessions table to correlate watch time with storage.
 * A play is one resume chain (COALESCE(reference_id, id)) gated at 2 minutes (120000ms).
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import {
  REDIS_KEYS,
  CACHE_TTL,
  libraryRoiQuerySchema,
  type LibraryRoiQueryInput,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';

/** Value category for ROI classification */
type ValueCategory = 'low_value' | 'moderate_value' | 'high_value';

/** Individual ROI item with storage and watch metrics */
interface RoiItem {
  id: string;
  serverId: string;
  serverName: string;
  title: string;
  mediaType: string;
  year: number | null;
  // Storage metrics
  fileSizeBytes: number;
  fileSizeGb: number;
  // Watch metrics
  watchCount: number;
  totalWatchMs: number;
  totalWatchHours: number;
  lastWatchedAt: string | null;
  daysSinceLastWatch: number | null;
  // ROI metrics
  watchHoursPerGb: number;
  valueScore: number; // 0-100 composite score
  valueCategory: ValueCategory;
  // Deletion suggestion
  suggestDeletion: boolean;
}

/** Summary statistics for ROI analysis */
interface RoiSummary {
  totalItems: number;
  totalStorageGb: number;
  totalWatchHours: number;
  avgWatchHoursPerGb: number;
  lowValueItems: number;
  lowValueStorageGb: number;
  potentialSavingsGb: number; // If low-value items were deleted
}

/** Value thresholds by content type */
interface ValueThresholds {
  movie: { lowValue: number; highValue: number };
  episode: { lowValue: number; highValue: number };
  show: { lowValue: number; highValue: number };
}

/** Full response for ROI endpoint */
interface RoiResponse {
  items: RoiItem[];
  summary: RoiSummary;
  thresholds: ValueThresholds;
  pagination: { page: number; pageSize: number; total: number };
}

/** Raw row from database for items */
interface RawRoiItemRow {
  id: string;
  server_id: string;
  server_name: string;
  title: string;
  media_type: string;
  year: number | null;
  file_size_bytes: string;
  file_size_gb: string;
  watch_count: string;
  total_watch_ms: string;
  total_watch_hours: string;
  last_watched_at: string | null;
  days_since_last_watch: string | null;
  watch_hours_per_gb: string;
  value_score: string;
  value_category: ValueCategory;
  suggest_deletion: boolean;
}

/** Raw row from database for summary */
interface RawSummaryRow {
  total_items: string;
  total_storage_gb: string;
  total_watch_hours: string;
  avg_watch_hours_per_gb: string;
  low_value_items: string;
  low_value_storage_gb: string;
  potential_savings_gb: string;
}

/**
 * Value thresholds by content type (watch hours per GB)
 *
 * Movies: Expected to be watched once, so lower threshold
 * Episodes: Often rewatched (series), higher threshold
 * Shows: Aggregated level, middle ground
 */
const VALUE_THRESHOLDS: ValueThresholds = {
  movie: {
    lowValue: 0.1, // < 0.1 watch hours per GB = low value
    highValue: 0.5, // > 0.5 watch hours per GB = high value
  },
  episode: {
    lowValue: 0.5, // Episodes expected to have more rewatches
    highValue: 2.0,
  },
  show: {
    lowValue: 0.3, // Aggregated show level
    highValue: 1.0,
  },
};

export const libraryRoiRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /roi - Content ROI analysis
   *
   * Returns library items with watch value per storage cost calculations.
   * Identifies low-value content for potential deletion.
   */
  app.get<{ Querystring: LibraryRoiQueryInput }>(
    '/roi',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = libraryRoiQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        serverId,
        serverIds: rawServerIds,
        libraryId,
        mediaType,
        valueCategory,
        periodDays,
        includeAgeDecay,
        minFileSize,
        sortBy,
        sortOrder,
        page,
        pageSize,
      } = query.data;
      const authUser = request.user;

      const resolvedIds = resolveServerIds(authUser, serverId, rawServerIds);

      // Build cache key with all varying params
      const serverCacheSegment = resolvedIds ? resolvedIds.slice().sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(
        REDIS_KEYS.LIBRARY_ROI,
        serverCacheSegment,
        `${libraryId ?? 'all'}-${mediaType}-${valueCategory}-${periodDays}-${includeAgeDecay}-${minFileSize}-${sortBy}-${sortOrder}-${page}-${pageSize}`
      );

      // Try cache first
      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as RoiResponse;
        } catch {
          // Fall through to compute
        }
      }

      // Build filters
      const serverFilter = buildMultiServerFragment(resolvedIds, 'li.server_id');
      const libraryFilter = libraryId ? sql`AND li.library_id = ${libraryId}` : sql``;
      const mediaTypeFilter =
        mediaType && mediaType !== 'all' ? sql`AND li.media_type = ${mediaType}` : sql``;

      // Value category filter for final results
      const valueCategoryFilter =
        valueCategory === 'low_value'
          ? sql`AND value_category = 'low_value'`
          : valueCategory === 'moderate_value'
            ? sql`AND value_category = 'moderate_value'`
            : valueCategory === 'high_value'
              ? sql`AND value_category = 'high_value'`
              : sql``;

      // Sort column mapping - use sql.raw() for identifiers
      const sortColumnMap: Record<string, string> = {
        watch_hours_per_gb: 'watch_hours_per_gb',
        value_score: 'value_score',
        file_size: 'file_size_bytes',
        title: 'title',
      };
      const sortColumnName = sortColumnMap[sortBy] || 'watch_hours_per_gb';
      const sortDirStr = sortOrder === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS FIRST';
      const orderByClause = sql.raw(`${sortColumnName} ${sortDirStr}`);

      const offset = (page - 1) * pageSize;

      // Combined ROI query: items, summary, and count in one round-trip
      // Uses window functions for summary aggregation alongside item results
      const combinedResult = await db.execute(sql`
        WITH top_items AS (
          -- Every top-level entry with its identity key. A title merged
          -- across libraries or servers has several entries sharing one
          -- ident; unmatched items fall back to their own id.
          SELECT li.id, li.server_id, li.library_id, li.rating_key, li.title,
                 li.media_type, li.year, li.created_at,
                 COALESCE(li.media_id::text, li.id::text) AS ident
          FROM library_items li
          WHERE li.media_type NOT IN ('episode', 'track', 'season', 'album')  -- Exclude children/containers, only show content
            AND li.removed_at IS NULL
            ${serverFilter}
            ${libraryFilter}
            ${mediaTypeFilter}
        ),
        ident_sizes AS (
          -- Physical bytes per identity, mirror-deduped by (ident, byte size)
          -- so a merged entry listing the same file twice counts it once and
          -- the GB denominator stops halving the title's ROI
          SELECT ident, SUM(sz) AS file_size
          FROM (
            SELECT DISTINCT b.ident, v.file_size AS sz
            FROM top_items b
            LEFT JOIN library_items child ON b.media_type IN ('show', 'artist')
              AND child.grandparent_rating_key = b.rating_key
              AND child.server_id = b.server_id
              AND child.removed_at IS NULL
            JOIN library_item_versions v
              ON v.library_item_id = COALESCE(child.id, b.id)
              AND v.removed_at IS NULL AND v.file_size IS NOT NULL
          ) d
          GROUP BY ident
        ),
        ident_watch AS (
          -- Watch stats per identity within the period: a play on ANY entry
          -- (or any entry's children) counts for the title
          SELECT b.ident,
                 COUNT(DISTINCT COALESCE(sess.reference_id, sess.id))
                   FILTER (WHERE COALESCE(sess.duration_ms, 0) >= 120000) AS watch_count,
                 COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0) AS total_watch_ms,
                 MAX(sess.stopped_at) AS last_watched_at
          FROM top_items b
          LEFT JOIN library_items child ON b.media_type IN ('show', 'artist')
            AND child.grandparent_rating_key = b.rating_key
            AND child.server_id = b.server_id
            AND child.removed_at IS NULL
          LEFT JOIN sessions sess ON sess.server_id = b.server_id
            AND sess.rating_key = COALESCE(child.rating_key, b.rating_key)
            AND sess.started_at >= NOW() - INTERVAL '1 day' * ${periodDays}
          GROUP BY b.ident
        ),
        ident_reps AS (
          -- One representative entry per identity for display fields
          SELECT DISTINCT ON (ident) ident, id, server_id, title, media_type, year, created_at
          FROM top_items
          ORDER BY ident, created_at ASC NULLS LAST, id
        ),
        item_roi AS (
          SELECT
            r.id,
            r.server_id,
            s.name AS server_name,
            r.title,
            r.media_type,
            r.year,
            isz.file_size AS file_size_bytes,
            isz.file_size / 1073741824.0 AS file_size_gb,
            r.created_at AS added_at,
            COALESCE(iw.watch_count, 0) AS watch_count,
            COALESCE(iw.total_watch_ms, 0) AS total_watch_ms,
            COALESCE(iw.total_watch_ms, 0) / 3600000.0 AS total_watch_hours,
            iw.last_watched_at,
            EXTRACT(DAY FROM NOW() - iw.last_watched_at)::int AS days_since_last_watch
          FROM ident_reps r
          JOIN servers s ON r.server_id = s.id
          LEFT JOIN ident_sizes isz ON isz.ident = r.ident
          LEFT JOIN ident_watch iw ON iw.ident = r.ident
          WHERE COALESCE(isz.file_size, 0) > ${minFileSize}
        ),
        roi_scored AS (
          SELECT
            *,
            -- Watch hours per GB (core ROI metric)
            CASE
              WHEN file_size_gb > 0 THEN ROUND((total_watch_hours / file_size_gb)::numeric, 3)
              ELSE 0
            END AS watch_hours_per_gb,
            -- Value score (0-100) with optional age decay
            CASE
              WHEN file_size_gb > 0 THEN
                LEAST(100, GREATEST(0,
                  -- Base score from watch hours per GB (0-70 points)
                  LEAST(70, (total_watch_hours / file_size_gb) *
                    CASE media_type
                      WHEN 'movie' THEN 140  -- 0.5 hrs/GB = 70 points
                      WHEN 'episode' THEN 35 -- 2.0 hrs/GB = 70 points
                      ELSE 70               -- 1.0 hrs/GB = 70 points
                    END
                  ) +
                  -- Recency bonus (0-30 points, decays with age if includeAgeDecay)
                  CASE
                    WHEN days_since_last_watch IS NULL THEN 0
                    WHEN ${includeAgeDecay} AND days_since_last_watch > 90 THEN
                      GREATEST(0, 30 - (days_since_last_watch - 90) * 0.2)
                    ELSE 30
                  END
                ))
              ELSE 0
            END AS value_score,
            -- Value category based on type-specific thresholds
            CASE
              WHEN file_size_gb = 0 THEN 'moderate_value'
              WHEN media_type = 'movie' AND (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.1 THEN 'low_value'
              WHEN media_type = 'movie' AND (total_watch_hours / NULLIF(file_size_gb, 0)) > 0.5 THEN 'high_value'
              WHEN media_type = 'episode' AND (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.5 THEN 'low_value'
              WHEN media_type = 'episode' AND (total_watch_hours / NULLIF(file_size_gb, 0)) > 2.0 THEN 'high_value'
              WHEN (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.3 THEN 'low_value'
              WHEN (total_watch_hours / NULLIF(file_size_gb, 0)) > 1.0 THEN 'high_value'
              ELSE 'moderate_value'
            END AS value_category
          FROM item_roi
        ),
        filtered_items AS (
          SELECT
            *,
            -- Suggest deletion for low-value items with no recent watches
            (value_category = 'low_value' AND (days_since_last_watch IS NULL OR days_since_last_watch > 180)) AS suggest_deletion
          FROM roi_scored
          WHERE 1=1
            ${valueCategoryFilter}
        ),
        -- Summary aggregation computed once over all filtered items
        summary_stats AS (
          SELECT
            COUNT(*) AS total_items,
            COALESCE(SUM(file_size_gb), 0) AS total_storage_gb,
            COALESCE(SUM(total_watch_hours), 0) AS total_watch_hours,
            CASE
              WHEN SUM(file_size_gb) > 0 THEN ROUND((SUM(total_watch_hours) / SUM(file_size_gb))::numeric, 2)
              ELSE 0
            END AS avg_watch_hours_per_gb,
            COUNT(*) FILTER (WHERE value_category = 'low_value') AS low_value_items,
            COALESCE(SUM(file_size_gb) FILTER (WHERE value_category = 'low_value'), 0) AS low_value_storage_gb,
            COALESCE(SUM(file_size_gb) FILTER (WHERE suggest_deletion), 0) AS potential_savings_gb
          FROM filtered_items
        ),
        paginated_items AS (
          SELECT * FROM filtered_items
          ORDER BY ${orderByClause}
          LIMIT ${pageSize} OFFSET ${offset}
        )
        SELECT
          -- Item fields
          pi.id,
          pi.server_id,
          pi.server_name,
          pi.title,
          pi.media_type,
          pi.year,
          pi.file_size_bytes::text AS file_size_bytes,
          pi.file_size_gb::text AS file_size_gb,
          pi.watch_count::text AS watch_count,
          pi.total_watch_ms::text AS total_watch_ms,
          pi.total_watch_hours::text AS total_watch_hours,
          pi.last_watched_at::text AS last_watched_at,
          pi.days_since_last_watch::text AS days_since_last_watch,
          pi.watch_hours_per_gb::text AS watch_hours_per_gb,
          pi.value_score::text AS value_score,
          pi.value_category,
          pi.suggest_deletion,
          -- Summary fields (same for all rows)
          ss.total_items::text AS _total_items,
          ss.total_storage_gb::text AS _total_storage_gb,
          ss.total_watch_hours::text AS _total_watch_hours,
          ss.avg_watch_hours_per_gb::text AS _avg_watch_hours_per_gb,
          ss.low_value_items::text AS _low_value_items,
          ss.low_value_storage_gb::text AS _low_value_storage_gb,
          ss.potential_savings_gb::text AS _potential_savings_gb
        FROM paginated_items pi
        CROSS JOIN summary_stats ss
      `);

      // Extract items and summary from combined result
      interface CombinedRoiRow extends RawRoiItemRow {
        _total_items: string;
        _total_storage_gb: string;
        _total_watch_hours: string;
        _avg_watch_hours_per_gb: string;
        _low_value_items: string;
        _low_value_storage_gb: string;
        _potential_savings_gb: string;
      }

      const rows = combinedResult.rows as unknown as CombinedRoiRow[];

      const items: RoiItem[] = rows.map((row) => ({
        id: row.id,
        serverId: row.server_id,
        serverName: row.server_name,
        title: row.title,
        mediaType: row.media_type,
        year: row.year,
        fileSizeBytes: parseInt(row.file_size_bytes, 10) || 0,
        fileSizeGb: parseFloat(row.file_size_gb) || 0,
        watchCount: parseInt(row.watch_count, 10) || 0,
        totalWatchMs: parseInt(row.total_watch_ms, 10) || 0,
        totalWatchHours: parseFloat(row.total_watch_hours) || 0,
        lastWatchedAt: row.last_watched_at,
        daysSinceLastWatch: row.days_since_last_watch
          ? parseInt(row.days_since_last_watch, 10)
          : null,
        watchHoursPerGb: parseFloat(row.watch_hours_per_gb) || 0,
        valueScore: parseFloat(row.value_score) || 0,
        valueCategory: row.value_category,
        suggestDeletion: row.suggest_deletion,
      }));

      // Extract summary from first row (or fetch separately if no items)
      let summary: RoiSummary;
      let total: number;

      if (rows.length > 0) {
        const firstRow = rows[0]!;
        summary = {
          totalItems: parseInt(firstRow._total_items, 10) || 0,
          totalStorageGb: parseFloat(firstRow._total_storage_gb) || 0,
          totalWatchHours: parseFloat(firstRow._total_watch_hours) || 0,
          avgWatchHoursPerGb: parseFloat(firstRow._avg_watch_hours_per_gb) || 0,
          lowValueItems: parseInt(firstRow._low_value_items, 10) || 0,
          lowValueStorageGb: parseFloat(firstRow._low_value_storage_gb) || 0,
          potentialSavingsGb: parseFloat(firstRow._potential_savings_gb) || 0,
        };
        total = summary.totalItems;
      } else {
        // No items on current page - need summary separately for empty page case
        const summaryResult = await db.execute(sql`
          WITH top_items AS (
            SELECT li.id, li.server_id, li.rating_key, li.media_type,
              COALESCE(li.media_id::text, li.id::text) AS ident
            FROM library_items li
            WHERE li.media_type NOT IN ('episode', 'track', 'season', 'album')
              AND li.removed_at IS NULL ${serverFilter} ${libraryFilter} ${mediaTypeFilter}
          ),
          ident_sizes AS (
            SELECT ident, SUM(sz) AS file_size FROM (
              SELECT DISTINCT b.ident, v.file_size AS sz
              FROM top_items b
              LEFT JOIN library_items child ON b.media_type IN ('show', 'artist')
                AND child.grandparent_rating_key = b.rating_key AND child.server_id = b.server_id AND child.removed_at IS NULL
              JOIN library_item_versions v ON v.library_item_id = COALESCE(child.id, b.id)
                AND v.removed_at IS NULL AND v.file_size IS NOT NULL
            ) d GROUP BY ident
          ),
          ident_watch AS (
            SELECT b.ident,
              COALESCE(SUM(sess.duration_ms) FILTER (WHERE sess.duration_ms >= 120000), 0) AS total_watch_ms,
              MAX(sess.stopped_at) AS last_watched_at
            FROM top_items b
            LEFT JOIN library_items child ON b.media_type IN ('show', 'artist')
              AND child.grandparent_rating_key = b.rating_key AND child.server_id = b.server_id AND child.removed_at IS NULL
            LEFT JOIN sessions sess ON sess.server_id = b.server_id
              AND sess.rating_key = COALESCE(child.rating_key, b.rating_key)
              AND sess.started_at >= NOW() - INTERVAL '1 day' * ${periodDays}
            GROUP BY b.ident
          ),
          ident_types AS (
            SELECT DISTINCT ON (ident) ident, media_type FROM top_items ORDER BY ident, id
          ),
          item_roi AS (
            SELECT i.ident AS id, isz.file_size / 1073741824.0 AS file_size_gb,
              COALESCE(iw.total_watch_ms, 0) / 3600000.0 AS total_watch_hours,
              EXTRACT(DAY FROM NOW() - iw.last_watched_at)::int AS days_since_last_watch, i.media_type
            FROM ident_types i
            LEFT JOIN ident_sizes isz ON isz.ident = i.ident
            LEFT JOIN ident_watch iw ON iw.ident = i.ident
            WHERE COALESCE(isz.file_size, 0) > ${minFileSize}
          ),
          roi_scored AS (
            SELECT *, CASE
              WHEN file_size_gb = 0 THEN 'moderate_value'
              WHEN media_type = 'movie' AND (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.1 THEN 'low_value'
              WHEN media_type = 'movie' AND (total_watch_hours / NULLIF(file_size_gb, 0)) > 0.5 THEN 'high_value'
              WHEN media_type = 'episode' AND (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.5 THEN 'low_value'
              WHEN media_type = 'episode' AND (total_watch_hours / NULLIF(file_size_gb, 0)) > 2.0 THEN 'high_value'
              WHEN (total_watch_hours / NULLIF(file_size_gb, 0)) < 0.3 THEN 'low_value'
              WHEN (total_watch_hours / NULLIF(file_size_gb, 0)) > 1.0 THEN 'high_value'
              ELSE 'moderate_value' END AS value_category
            FROM item_roi
          ),
          filtered AS (
            SELECT *, (value_category = 'low_value' AND (days_since_last_watch IS NULL OR days_since_last_watch > 180)) AS suggest_deletion
            FROM roi_scored WHERE 1=1 ${valueCategoryFilter}
          )
          SELECT COUNT(*) AS total_items, COALESCE(SUM(file_size_gb), 0)::text AS total_storage_gb,
            COALESCE(SUM(total_watch_hours), 0)::text AS total_watch_hours,
            CASE WHEN SUM(file_size_gb) > 0 THEN ROUND((SUM(total_watch_hours) / SUM(file_size_gb))::numeric, 2)::text ELSE '0' END AS avg_watch_hours_per_gb,
            COUNT(*) FILTER (WHERE value_category = 'low_value') AS low_value_items,
            COALESCE(SUM(file_size_gb) FILTER (WHERE value_category = 'low_value'), 0)::text AS low_value_storage_gb,
            COALESCE(SUM(file_size_gb) FILTER (WHERE suggest_deletion), 0)::text AS potential_savings_gb
          FROM filtered
        `);
        const summaryRow = summaryResult.rows[0] as unknown as RawSummaryRow;
        summary = {
          totalItems: parseInt(summaryRow.total_items, 10) || 0,
          totalStorageGb: parseFloat(summaryRow.total_storage_gb) || 0,
          totalWatchHours: parseFloat(summaryRow.total_watch_hours) || 0,
          avgWatchHoursPerGb: parseFloat(summaryRow.avg_watch_hours_per_gb) || 0,
          lowValueItems: parseInt(summaryRow.low_value_items, 10) || 0,
          lowValueStorageGb: parseFloat(summaryRow.low_value_storage_gb) || 0,
          potentialSavingsGb: parseFloat(summaryRow.potential_savings_gb) || 0,
        };
        total = summary.totalItems;
      }

      const response: RoiResponse = {
        items,
        summary,
        thresholds: VALUE_THRESHOLDS,
        pagination: { page, pageSize, total },
      };

      // Cache response
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_ROI, JSON.stringify(response));

      return response;
    }
  );
};
