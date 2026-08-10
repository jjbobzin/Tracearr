/**
 * Public API v2 - GET /streams
 */

import { booleanStringSchema, formatBitrate } from '@tracearr/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { getCacheService } from '../../services/cache.js';
import { buildAvatarUrl, buildPosterUrl } from '../../services/imageProxy.js';
import { displayValues, emptyToNull, type RouteConfig } from './shared.js';

interface SessionIdentityRow {
  id: string;
  media_id: string | null;
  show_media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  rating_key: string | null;
  parent_rating_key: string | null;
  grandparent_rating_key: string | null;
  library_id: string | null;
  genres: string[] | null;
}

export function registerStreamsRoutes(app: FastifyInstance, routeConfig: RouteConfig): void {
  /**
   * GET /streams - Currently active playback sessions with media identity
   *
   * Reads the session cache and enriches each stream with identity, library,
   * and genre data from the session rows when the cached payload lacks it.
   */
  app.get(
    '/streams',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const streamsQuerySchema = z.object({
        server_id: z.uuid().optional(),
        summary: booleanStringSchema.optional(),
      });

      const query = streamsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const { server_id: serverId, summary: summaryOnly } = query.data;

      const cacheService = getCacheService();
      let activeSessions = cacheService ? await cacheService.getAllActiveSessions() : [];
      if (serverId) {
        activeSessions = activeSessions.filter((s) => s.serverId === serverId);
      }

      const identityById = new Map<string, SessionIdentityRow>();
      if (!summaryOnly && activeSessions.length > 0) {
        const identityResult = await db.execute(sql`
          SELECT
            s.id,
            s.media_id,
            s.show_media_id,
            s.imdb_id,
            s.tmdb_id,
            s.tvdb_id,
            s.rating_key,
            s.parent_rating_key,
            s.grandparent_rating_key,
            li.library_id,
            m.genres
          FROM sessions s
          LEFT JOIN media m ON m.id = s.media_id
          LEFT JOIN library_items li ON li.server_id = s.server_id AND li.rating_key = s.rating_key
          WHERE s.id IN (${sql.join(
            activeSessions.map((s) => sql`${s.id}`),
            sql`, `
          )})
        `);
        for (const row of identityResult.rows as unknown as SessionIdentityRow[]) {
          identityById.set(row.id, row);
        }
      }

      const streams = summaryOnly
        ? []
        : activeSessions.map((session) => {
            const identity = identityById.get(session.id);
            return {
              id: session.id,
              server_id: session.serverId,
              server_name: session.server.name,
              server_type: session.server.type,
              username: session.user.identityName ?? session.user.username,
              user_thumb: session.user.thumbUrl,
              user_avatar_url: buildAvatarUrl(session.serverId, session.user.thumbUrl),
              media_title: session.mediaTitle,
              media_type: session.mediaType,
              show_title: session.grandparentTitle,
              season_number: session.seasonNumber,
              episode_number: session.episodeNumber,
              year: session.year,
              artist_name: session.artistName,
              album_name: session.albumName,
              track_number: session.trackNumber,
              disc_number: session.discNumber,
              thumb_path: session.thumbPath,
              poster_url: buildPosterUrl(session.serverId, session.thumbPath),
              duration_ms: session.totalDurationMs,
              state: session.state,
              progress_ms: session.progressMs ?? 0,
              started_at: session.startedAt,
              is_transcode: session.isTranscode,
              video_decision: session.videoDecision,
              audio_decision: session.audioDecision,
              bitrate: session.bitrate,
              source_video_codec: session.sourceVideoCodec,
              source_audio_codec: session.sourceAudioCodec,
              source_audio_channels: session.sourceAudioChannels,
              source_video_width: session.sourceVideoWidth,
              source_video_height: session.sourceVideoHeight,
              source_video_details: session.sourceVideoDetails,
              source_audio_details: session.sourceAudioDetails,
              stream_video_codec: session.streamVideoCodec,
              stream_audio_codec: session.streamAudioCodec,
              stream_video_details: session.streamVideoDetails,
              stream_audio_details: session.streamAudioDetails,
              transcode_info: session.transcodeInfo,
              subtitle_info: session.subtitleInfo,
              ...displayValues(session),
              device: session.device,
              player: session.playerName,
              product: session.product,
              platform: session.platform,
              media_id: identity ? identity.media_id : (session.mediaId ?? null),
              show_media_id: identity ? identity.show_media_id : (session.showMediaId ?? null),
              imdb_id: identity ? identity.imdb_id : (session.imdbId ?? null),
              tmdb_id: identity ? identity.tmdb_id : (session.tmdbId ?? null),
              tvdb_id: identity ? identity.tvdb_id : (session.tvdbId ?? null),
              rating_key: emptyToNull(identity ? identity.rating_key : session.ratingKey),
              parent_rating_key: emptyToNull(
                identity ? identity.parent_rating_key : session.parentRatingKey
              ),
              grandparent_rating_key: emptyToNull(
                identity ? identity.grandparent_rating_key : session.grandparentRatingKey
              ),
              library_id: identity?.library_id ?? null,
              genres: identity?.genres ?? null,
            };
          });

      const categorizeStream = (session: (typeof activeSessions)[0]) => {
        if (session.isTranscode) return 'transcode';
        if (session.videoDecision === 'copy' || session.audioDecision === 'copy')
          return 'directStream';
        return 'directPlay';
      };

      let transcodeCount = 0;
      let directStreamCount = 0;
      let directPlayCount = 0;
      let totalBitrate = 0;

      for (const session of activeSessions) {
        const category = categorizeStream(session);
        if (category === 'transcode') transcodeCount++;
        else if (category === 'directStream') directStreamCount++;
        else directPlayCount++;
        if (session.bitrate) totalBitrate += session.bitrate;
      }

      const serverBreakdown: Record<
        string,
        {
          serverId: string;
          serverName: string;
          total: number;
          transcodes: number;
          directStreams: number;
          directPlays: number;
          bitrateKbps: number;
        }
      > = {};

      for (const session of activeSessions) {
        let serverStats = serverBreakdown[session.serverId];
        if (!serverStats) {
          serverStats = {
            serverId: session.serverId,
            serverName: session.server.name,
            total: 0,
            transcodes: 0,
            directStreams: 0,
            directPlays: 0,
            bitrateKbps: 0,
          };
          serverBreakdown[session.serverId] = serverStats;
        }
        const category = categorizeStream(session);
        serverStats.total++;
        if (category === 'transcode') serverStats.transcodes++;
        else if (category === 'directStream') serverStats.directStreams++;
        else serverStats.directPlays++;
        if (session.bitrate) serverStats.bitrateKbps += session.bitrate;
      }

      const summary = {
        total: activeSessions.length,
        transcodes: transcodeCount,
        direct_streams: directStreamCount,
        direct_plays: directPlayCount,
        total_bitrate: formatBitrate(totalBitrate),
        by_server: Object.values(serverBreakdown).map((s) => ({
          server_id: s.serverId,
          server_name: s.serverName,
          total: s.total,
          transcodes: s.transcodes,
          direct_streams: s.directStreams,
          direct_plays: s.directPlays,
          total_bitrate: formatBitrate(s.bitrateKbps),
        })),
      };

      if (summaryOnly) {
        return { summary };
      }

      return { data: streams, summary };
    }
  );
}
