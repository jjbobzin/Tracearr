/**
 * GET /stats/plays mediaType filter integration test.
 *
 * Confirms the optional mediaType param actually narrows the underlying
 * sessions query (movie-filtered excludes episode/show plays) while the
 * no-param response keeps counting every primary media type, unchanged.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- statsPlaysMediaType
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
} from '@tracearr/test-utils/factories';
import { playsRoutes } from '../../src/routes/stats/plays.js';

function ownerAuth(): AuthUser {
  return { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = ownerAuth();
  });
  await app.register(playsRoutes as never);
  return app;
}

interface PlaysRow {
  date: string;
  serverId: string;
  count: number;
}

function totalCount(rows: PlaysRow[]): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

describe('GET /stats/plays mediaType filter', () => {
  it('movie-filtered excludes show (episode) plays', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });

    await createTestSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      mediaType: 'movie',
      ratingKey: 'plays-mediatype-movie-1',
      durationMs: 150_000,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      mediaType: 'episode',
      grandparentTitle: 'Plays Mediatype Show',
      ratingKey: 'plays-mediatype-episode-1',
      durationMs: 150_000,
    });

    const app = await buildApp();

    const unfiltered = await app.inject({
      method: 'GET',
      url: `/plays?period=all&serverId=${server.id}`,
    });
    const movieOnly = await app.inject({
      method: 'GET',
      url: `/plays?period=all&serverId=${server.id}&mediaType=movie`,
    });
    await app.close();

    expect(unfiltered.statusCode).toBe(200);
    expect(movieOnly.statusCode).toBe(200);

    expect(totalCount(unfiltered.json().data as PlaysRow[])).toBe(2);
    expect(totalCount(movieOnly.json().data as PlaysRow[])).toBe(1);
  });
});
