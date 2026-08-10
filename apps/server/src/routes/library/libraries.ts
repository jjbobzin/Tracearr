/**
 * Library options endpoint
 *
 * GET /libraries - Names/media type per library, scoped to the caller's
 * accessible servers. Powers the catalog browse Library filter select.
 * Cached per sorted serverIds.
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { resolveServerIds, buildMultiServerFragment } from '../../utils/serverFiltering.js';
import { buildLibraryCacheKey } from './utils.js';
import {
  serverIdsQuerySchema,
  REDIS_KEYS,
  CACHE_TTL,
  type LibraryOption,
  type LibrariesResponse,
} from '@tracearr/shared';

const librariesQuerySchema = z.object({
  serverIds: serverIdsQuerySchema,
});

interface RawLibraryRow {
  server_id: string;
  server_name: string;
  library_id: string;
  name: string;
  media_type: string;
}

async function fetchLibraries(serverIds: string[] | undefined): Promise<LibraryOption[]> {
  const serverFragment = buildMultiServerFragment(serverIds, 'l.server_id');
  const result = await db.execute(sql`
    SELECT l.server_id, s.name AS server_name, l.library_id, l.name, l.media_type
    FROM libraries l
    JOIN servers s ON s.id = l.server_id
    WHERE 1=1 ${serverFragment}
    ORDER BY s.name, l.name
  `);
  return (result.rows as unknown as RawLibraryRow[]).map((row) => ({
    serverId: row.server_id,
    serverName: row.server_name,
    libraryId: row.library_id,
    name: row.name,
    mediaType: row.media_type,
  }));
}

export const libraryLibrariesRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /libraries - Per-server library names/media types for the catalog
   * Library filter, scoped to the caller's accessible servers.
   */
  app.get<{ Querystring: Record<string, unknown> }>(
    '/libraries',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = librariesQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const authUser = request.user;

      // Guard: server scope, fail-closed.
      const resolvedIds = resolveServerIds(authUser, undefined, query.data.serverIds);

      const serverCacheKey = resolvedIds !== undefined ? [...resolvedIds].sort().join(',') : 'all';
      const cacheKey = buildLibraryCacheKey(REDIS_KEYS.LIBRARY_LIBRARIES, serverCacheKey);

      const cached = await app.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as LibrariesResponse;
        } catch {
          // Fall through to compute.
        }
      }

      const data = await fetchLibraries(resolvedIds);
      const response: LibrariesResponse = { data };
      await app.redis.setex(cacheKey, CACHE_TTL.LIBRARY_LIBRARIES, JSON.stringify(response));

      return response;
    }
  );
};
