/**
 * Public API v2 - GET /recently-added and GET /libraries
 */

import { booleanStringSchema } from '@tracearr/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { getCacheService } from '../../services/cache.js';
import { decodeCursor, encodeCursor } from '../../utils/cursor.js';
import { cursorPage, cursorPaginationSchema, emptyToNull, type RouteConfig } from './shared.js';

const LIBRARY_MEDIA_TYPES = [
  'movie',
  'episode',
  'season',
  'show',
  'artist',
  'album',
  'track',
  'photo',
] as const;

interface RecentlyAddedRow {
  id: string;
  server_id: string;
  server_type: string;
  library_id: string;
  media_type: string;
  title: string;
  year: number | null;
  added_at: Date;
  removed_at: Date | null;
  media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  rating_key: string | null;
  parent_rating_key: string | null;
  grandparent_rating_key: string | null;
}

function mapRecentlyAdded(row: RecentlyAddedRow) {
  return {
    id: row.id,
    server_id: row.server_id,
    server_type: row.server_type,
    library_id: row.library_id,
    media_type: row.media_type,
    title: row.title,
    year: row.year,
    added_at: new Date(row.added_at).toISOString(),
    removed_at: row.removed_at ? new Date(row.removed_at).toISOString() : null,
    media_id: row.media_id,
    imdb_id: row.imdb_id,
    tmdb_id: row.tmdb_id,
    tvdb_id: row.tvdb_id,
    rating_key: emptyToNull(row.rating_key),
    parent_rating_key: emptyToNull(row.parent_rating_key),
    grandparent_rating_key: emptyToNull(row.grandparent_rating_key),
  };
}

interface LibraryCountRow {
  server_id: string;
  server_type: string;
  library_id: string;
  item_count: string | number;
  movie_count: string | number;
  episode_count: string | number;
  show_count: string | number;
  track_count: string | number;
  total_file_size: string | number;
}

interface LibraryResolutionRow {
  server_id: string;
  library_id: string;
  resolution: string;
  count: string | number;
}

async function buildLibraryRollups() {
  const counts = await db.execute(sql`
    SELECT
      li.server_id,
      sv.type AS server_type,
      li.library_id,
      COUNT(*) AS item_count,
      COUNT(*) FILTER (WHERE li.media_type = 'movie') AS movie_count,
      COUNT(*) FILTER (WHERE li.media_type = 'episode') AS episode_count,
      COUNT(*) FILTER (WHERE li.media_type = 'show') AS show_count,
      COUNT(*) FILTER (WHERE li.media_type = 'track') AS track_count,
      COALESCE(SUM(li.file_size), 0) AS total_file_size
    FROM library_items li
    JOIN servers sv ON sv.id = li.server_id
    WHERE li.removed_at IS NULL AND li.media_type != 'season'
    GROUP BY li.server_id, sv.type, li.library_id
    ORDER BY li.server_id, li.library_id
  `);

  const resolutions = await db.execute(sql`
    SELECT
      li.server_id,
      li.library_id,
      COALESCE(li.video_resolution, 'unknown') AS resolution,
      COUNT(*) AS count
    FROM library_items li
    WHERE li.removed_at IS NULL AND li.media_type != 'season'
    GROUP BY li.server_id, li.library_id, COALESCE(li.video_resolution, 'unknown')
  `);

  const resByLibrary = new Map<string, Record<string, number>>();
  for (const r of resolutions.rows as unknown as LibraryResolutionRow[]) {
    const key = `${r.server_id}::${r.library_id}`;
    const bucket = resByLibrary.get(key) ?? {};
    bucket[r.resolution] = Number(r.count);
    resByLibrary.set(key, bucket);
  }

  return (counts.rows as unknown as LibraryCountRow[]).map((row) => ({
    server_id: row.server_id,
    server_type: row.server_type,
    library_id: row.library_id,
    item_count: Number(row.item_count),
    movie_count: Number(row.movie_count),
    episode_count: Number(row.episode_count),
    show_count: Number(row.show_count),
    track_count: Number(row.track_count),
    total_file_size: Number(row.total_file_size),
    resolutions: resByLibrary.get(`${row.server_id}::${row.library_id}`) ?? {},
  }));
}

export function registerLibrariesRoutes(app: FastifyInstance, routeConfig: RouteConfig): void {
  /**
   * GET /recently-added - Library items newest first by server-reported added date
   *
   * The keyset pages on the full (created_at, id) tuple: added dates are
   * server-reported at 1-second resolution and a bulk sync stamps a whole
   * library with one timestamp, so a single-column cursor would skip or repeat
   * rows across a tied group.
   */
  app.get(
    '/recently-added',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const querySchema = cursorPaginationSchema.extend({
        server_id: z.uuid().optional(),
        library_id: z.string().min(1).max(100).optional(),
        media_type: z.enum(LIBRARY_MEDIA_TYPES).optional(),
        include_removed: booleanStringSchema.default(false),
      });
      const query = querySchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');
      const {
        cursor,
        pageSize,
        server_id: serverId,
        library_id: libraryId,
        media_type: mediaType,
        include_removed: includeRemoved,
      } = query.data;

      let cursorValue: { startedAt: Date; id: string } | null = null;
      if (cursor) {
        cursorValue = decodeCursor(cursor);
        if (!cursorValue || !z.uuid().safeParse(cursorValue.id).success) {
          return reply.badRequest('Invalid cursor');
        }
      }

      const conditions: SQL[] = [];
      if (!includeRemoved) conditions.push(sql`li.removed_at IS NULL`);
      if (serverId) conditions.push(sql`li.server_id = ${serverId}`);
      if (libraryId) conditions.push(sql`li.library_id = ${libraryId}`);
      if (mediaType) conditions.push(sql`li.media_type = ${mediaType}`);
      if (cursorValue) {
        conditions.push(
          sql`(li.created_at, li.id) < (${cursorValue.startedAt}::timestamptz, ${cursorValue.id}::uuid)`
        );
      }
      const whereClause =
        conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``;

      const result = await db.execute(sql`
        SELECT
          li.id,
          li.server_id,
          sv.type AS server_type,
          li.library_id,
          li.media_type,
          li.title,
          li.year,
          li.created_at AS added_at,
          li.removed_at,
          li.media_id,
          li.imdb_id,
          li.tmdb_id,
          li.tvdb_id,
          li.rating_key,
          li.parent_rating_key,
          li.grandparent_rating_key
        FROM library_items li
        JOIN servers sv ON sv.id = li.server_id
        ${whereClause}
        ORDER BY li.created_at DESC, li.id DESC
        LIMIT ${pageSize}
      `);

      const rows = result.rows as unknown as RecentlyAddedRow[];
      const data = rows.map(mapRecentlyAdded);
      const lastRow = rows.length === pageSize ? rows[rows.length - 1] : undefined;
      const nextCursor = lastRow ? encodeCursor(new Date(lastRow.added_at), lastRow.id) : null;
      return cursorPage(data, nextCursor, pageSize);
    }
  );

  /**
   * GET /libraries - Per-library item counts, total size, and resolution mix
   *
   * Tombstones (removed_at IS NOT NULL) are excluded from every count and sum.
   * Cached 60s.
   */
  app.get(
    '/libraries',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async () => {
      const cache = getCacheService();
      const cacheKey = 'libraries';
      if (cache) {
        const cached = await cache.getMediaStats<unknown>(cacheKey);
        if (cached) return cached;
      }

      const response = { data: await buildLibraryRollups() };
      if (cache) await cache.setMediaStats(cacheKey, response);
      return response;
    }
  );
}
