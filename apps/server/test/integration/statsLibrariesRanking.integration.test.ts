/**
 * GET /stats/libraries integration test.
 *
 * Confirms the real per-library plays + watch time ranking: sessions joined
 * to their library_items row on (rating_key, server_id), rolled up per
 * (server_id, library_id), ordered by plays desc, and scoped so a server
 * outside the caller's access never contributes a library to the ranking.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- statsLibrariesRanking
 */

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { AuthUser } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { contentRoutes } from '../../src/routes/stats/content.js';

function ownerAuth(): AuthUser {
  return { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
}

function viewerAuth(serverIds: string[]): AuthUser {
  return { userId: 'viewer', username: 'viewer', role: 'viewer', serverIds };
}

async function buildApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  await app.register(contentRoutes as never);
  return app;
}

interface LibraryRankingRow {
  serverId: string;
  libraryId: string;
  plays: number;
  watchTimeMs: number;
}

describe('GET /stats/libraries', () => {
  it('ranks libraries by plays desc and sums watch time, per server+library', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });

    const movieItem = await createTestLibraryItem({
      serverId: server.id,
      libraryId: 'lib-movies',
      ratingKey: 'ranking-movie-1',
      mediaType: 'movie',
    });
    const showEpisodeItem = await createTestLibraryItem({
      serverId: server.id,
      libraryId: 'lib-shows',
      ratingKey: 'ranking-episode-1',
      mediaType: 'episode',
    });

    // lib-movies: 3 qualifying plays, 390_000ms watched
    for (let i = 0; i < 3; i++) {
      await createTestSession({
        serverId: server.id,
        serverUserId: serverUser.id,
        mediaType: 'movie',
        ratingKey: movieItem.ratingKey,
        durationMs: 130_000,
      });
    }
    // lib-shows: 1 qualifying play, 200_000ms watched
    await createTestSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      mediaType: 'episode',
      ratingKey: showEpisodeItem.ratingKey,
      durationMs: 200_000,
    });
    // Sub-2-minute session must not count toward plays or watch time.
    await createTestSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      mediaType: 'movie',
      ratingKey: movieItem.ratingKey,
      durationMs: 60_000,
    });

    const app = await buildApp(ownerAuth());
    const response = await app.inject({
      method: 'GET',
      url: `/libraries?serverIds=${server.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const data = response.json().data as LibraryRankingRow[];

    expect(data).toEqual([
      { serverId: server.id, libraryId: 'lib-movies', plays: 3, watchTimeMs: 390_000 },
      { serverId: server.id, libraryId: 'lib-shows', plays: 1, watchTimeMs: 200_000 },
    ]);
  });

  it('excludes a library on a server outside the caller access scope', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const userA = await createTestUser({ role: 'member' });
    const userB = await createTestUser({ role: 'member' });
    const suA = await createTestServerUser({ userId: userA.id, serverId: serverA.id });
    const suB = await createTestServerUser({ userId: userB.id, serverId: serverB.id });

    const itemA = await createTestLibraryItem({
      serverId: serverA.id,
      libraryId: 'lib-a',
      ratingKey: 'scope-a-1',
      mediaType: 'movie',
    });
    const itemB = await createTestLibraryItem({
      serverId: serverB.id,
      libraryId: 'lib-b',
      ratingKey: 'scope-b-1',
      mediaType: 'movie',
    });

    await createTestSession({
      serverId: serverA.id,
      serverUserId: suA.id,
      mediaType: 'movie',
      ratingKey: itemA.ratingKey,
      durationMs: 150_000,
    });
    await createTestSession({
      serverId: serverB.id,
      serverUserId: suB.id,
      mediaType: 'movie',
      ratingKey: itemB.ratingKey,
      durationMs: 150_000,
    });

    // Viewer only has access to serverA but asks for both servers explicitly.
    const app = await buildApp(viewerAuth([serverA.id]));
    const response = await app.inject({
      method: 'GET',
      url: `/libraries?serverIds=${serverA.id}&serverIds=${serverB.id}`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const data = response.json().data as LibraryRankingRow[];
    const libraryIds = data.map((row) => row.libraryId);

    expect(libraryIds).toContain('lib-a');
    expect(libraryIds).not.toContain('lib-b');
  });
});
