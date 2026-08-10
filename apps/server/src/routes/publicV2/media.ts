/**
 * Public API v2 - GET /media/{ref} and sub-resources
 *
 * Query bodies live in services/library/mediaDetailService.ts, shared with
 * the internal /library/media routes. Every service call here passes
 * `serverIds: undefined` (v2 has no server-scoping concept), so this is
 * unscoped exactly as before the extraction.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getCacheService } from '../../services/cache.js';
import { resolveMediaAliases } from '../../services/library/mediaResolutionService.js';
import {
  buildMediaScope,
  getAvailability,
  getChildren,
  getMediaHistoryPage,
  getMediaStats,
  getMediaWatchers,
  resolveCanonicalMediaByRef,
} from '../../services/library/mediaDetailService.js';
import { decodeCursor } from '../../utils/cursor.js';
import { cursorPage, cursorPaginationSchema, type RouteConfig } from './shared.js';

export function registerMediaRoutes(app: FastifyInstance, routeConfig: RouteConfig): void {
  /**
   * GET /media/:ref - Canonical media identity with per-server availability
   *
   * ref is a media uuid or a type-qualified provider ref (movie:tmdb:584).
   * Seasons are uuid-only and reached through a show's children.
   */
  app.get(
    '/media/:ref',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const { ref } = request.params as { ref: string };
      const canonical = await resolveCanonicalMediaByRef(ref);
      if (!canonical) return reply.notFound();

      const aliases = await resolveMediaAliases(canonical.id);
      const mergedIds = aliases.filter((id) => id !== canonical.id);

      const { availability, seasonCount, episodeCount } = await getAvailability(
        canonical.id,
        canonical.mediaType,
        undefined
      );

      return {
        id: canonical.id,
        media_type: canonical.mediaType,
        title: canonical.title,
        year: canonical.year,
        imdb_id: canonical.imdbId,
        tmdb_id: canonical.tmdbId,
        tvdb_id: canonical.tvdbId,
        genres: canonical.genres,
        show_media_id: canonical.showMediaId,
        merged_ids: mergedIds,
        availability: availability.map((r) => ({
          server_id: r.server_id,
          server_type: r.server_type,
          library_id: r.library_id,
          rating_key: r.rating_key,
          added_at: new Date(r.added_at).toISOString(),
          removed_at: r.removed_at ? new Date(r.removed_at).toISOString() : null,
          video_resolution: r.video_resolution,
          file_size: r.file_size === null ? null : Number(r.file_size),
          versions: r.versions.map((v) => ({
            resolution: v.resolution,
            video_codec: v.videoCodec,
            audio_codec: v.audioCodec,
            dynamic_range: v.dynamicRange,
            container: v.container,
            file_size: v.fileSize === null ? null : Number(v.fileSize),
          })),
        })),
        season_count: seasonCount,
        episode_count: episodeCount,
      };
    }
  );

  /**
   * GET /media/:ref/children - Seasons of a show, or episodes of a season
   *
   * Shows list their season media rows; seasons list their episode media rows.
   * Movie and episode refs have no children and return 404.
   */
  app.get(
    '/media/:ref/children',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const { ref } = request.params as { ref: string };
      const canonical = await resolveCanonicalMediaByRef(ref);
      if (!canonical) return reply.notFound();

      const data = await getChildren(canonical, undefined);
      if (data === null) return reply.notFound();
      return { data };
    }
  );

  /**
   * GET /media/:ref/stats - Play counts, watch time, and distinct viewers
   *
   * Movies and episodes read the media_id rollup; shows roll up their episodes
   * via show_media_id; seasons compute live from raw sessions since neither
   * aggregate records season membership. unique_users counts distinct Tracearr
   * identities, so one person on several servers counts once. Cached 60s.
   */
  app.get(
    '/media/:ref/stats',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const { ref } = request.params as { ref: string };
      const canonical = await resolveCanonicalMediaByRef(ref);
      if (!canonical) return reply.notFound();
      const scope = await buildMediaScope(canonical);
      if (!scope) return reply.notFound();

      const cache = getCacheService();
      const cacheKey = `stats:${canonical.id}`;
      if (cache) {
        const cached = await cache.getMediaStats<unknown>(cacheKey);
        if (cached) return cached;
      }

      const windows = await getMediaStats(scope, undefined);

      const response = {
        media_id: canonical.id,
        media_type: canonical.mediaType,
        windows,
      };
      if (cache) await cache.setMediaStats(cacheKey, response);
      return response;
    }
  );

  /**
   * GET /media/:ref/watchers - Per server-user rollup for a media item
   *
   * One entry per server account, not per identity. Movies and episodes read
   * the media_id rollup; shows roll up episodes via show_media_id; seasons
   * compute live from raw sessions. Cached 60s.
   */
  app.get(
    '/media/:ref/watchers',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const { ref } = request.params as { ref: string };

      const querySchema = z.object({
        window: z.enum(['all_time', 'last_30', 'last_7']).default('all_time'),
        server_id: z.uuid().optional(),
      });
      const query = querySchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');
      const { window: windowKey, server_id: serverId } = query.data;

      const canonical = await resolveCanonicalMediaByRef(ref);
      if (!canonical) return reply.notFound();
      const scope = await buildMediaScope(canonical);
      if (!scope) return reply.notFound();

      const cache = getCacheService();
      const cacheKey = `watchers:${canonical.id}:${windowKey}:${serverId ?? 'all'}`;
      if (cache) {
        const cached = await cache.getMediaStats<unknown>(cacheKey);
        if (cached) return cached;
      }

      // The internal detail page's avatar fields (server_id, thumb) stay off
      // this documented v2 shape, so the user object is picked explicitly.
      const rows = await getMediaWatchers({ scope, windowKey, serverId, serverIds: undefined });
      const watchers = rows.map((r) => ({
        ...r,
        user: {
          server_user_id: r.user.server_user_id,
          user_id: r.user.user_id,
          username: r.user.username,
          identity_name: r.user.identity_name,
        },
      }));

      const response = {
        media_id: canonical.id,
        media_type: canonical.mediaType,
        window: windowKey,
        watchers,
      };
      if (cache) await cache.setMediaStats(cacheKey, response);
      return response;
    }
  );

  /**
   * GET /media/:ref/history - Watch history for a single media item as plays
   *
   * Same chain-grain paging as /history, scoped to the item's alias/rollup set
   * (movies/episodes by media_id, shows by show_media_id, seasons additionally
   * by season number). Computed live.
   */
  app.get(
    '/media/:ref/history',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const { ref } = request.params as { ref: string };

      const query = cursorPaginationSchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');
      const { cursor, pageSize } = query.data;

      let cursorValue: { startedAt: Date; id: string } | null = null;
      if (cursor) {
        cursorValue = decodeCursor(cursor);
        if (!cursorValue || !z.uuid().safeParse(cursorValue.id).success) {
          return reply.badRequest('Invalid cursor');
        }
      }

      const canonical = await resolveCanonicalMediaByRef(ref);
      if (!canonical) return reply.notFound();
      const scope = await buildMediaScope(canonical);
      if (!scope) return reply.notFound();

      const { data, nextCursor } = await getMediaHistoryPage({
        scope,
        pageSize,
        cursorValue,
        serverIds: undefined,
      });
      return cursorPage(data, nextCursor, pageSize);
    }
  );
}
