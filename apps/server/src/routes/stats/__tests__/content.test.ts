/**
 * Content statistics route tests
 *
 * Tests GET /stats/libraries - the per-library plays + watch time ranking.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

// Mock database before imports
vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

// Mock server filtering utilities, mirroring the real implementation
vi.mock('../../../utils/serverFiltering.js', async () => {
  const { sql } = await import('drizzle-orm');
  const { ForbiddenError } = await import('../../../utils/errors.js');
  return {
    resolveServerIds: vi.fn((authUser, serverId, serverIds) => {
      if (serverId && authUser.role !== 'owner' && !authUser.serverIds.includes(serverId)) {
        throw new ForbiddenError('You do not have access to this server');
      }
      const requested = serverIds ?? (serverId ? [serverId] : undefined);
      if (authUser.role === 'owner') return requested ?? undefined;
      if (!requested) return authUser.serverIds;
      return requested.filter((id: string) => authUser.serverIds.includes(id));
    }),
    buildMultiServerFragment: vi.fn(() => sql``),
  };
});

import { db } from '../../../db/client.js';
import { contentRoutes } from '../content.js';

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });

  await app.register(contentRoutes, { prefix: '/stats' });

  return app;
}

function createOwnerUser(): AuthUser {
  return {
    userId: randomUUID(),
    username: 'owner',
    role: 'owner',
    serverIds: [],
  };
}

function createViewerUser(serverIds: string[]): AuthUser {
  return {
    userId: randomUUID(),
    username: 'viewer',
    role: 'viewer',
    serverIds,
  };
}

describe('GET /stats/libraries', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns a per-library plays + watch time ranking, mapped to camelCase', async () => {
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);
    const serverId = randomUUID();

    vi.mocked(db.execute).mockResolvedValueOnce({
      rows: [
        { server_id: serverId, library_id: 'lib-movies', plays: 42, watch_time_ms: '3600000' },
        { server_id: serverId, library_id: 'lib-shows', plays: 10, watch_time_ms: '600000' },
      ],
    } as never);

    const response = await app.inject({
      method: 'GET',
      url: '/stats/libraries',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [
        { serverId, libraryId: 'lib-movies', plays: 42, watchTimeMs: 3600000 },
        { serverId, libraryId: 'lib-shows', plays: 10, watchTimeMs: 600000 },
      ],
    });
  });

  it('returns an empty ranking when no libraries have plays', async () => {
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);

    vi.mocked(db.execute).mockResolvedValueOnce({ rows: [] } as never);

    const response = await app.inject({
      method: 'GET',
      url: '/stats/libraries',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [] });
  });

  it('validates and rejects invalid serverId', async () => {
    const ownerUser = createOwnerUser();
    app = await buildTestApp(ownerUser);

    const response = await app.inject({
      method: 'GET',
      url: '/stats/libraries?serverId=not-a-uuid',
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects access to unauthorized server', async () => {
    const authorizedServer = randomUUID();
    const unauthorizedServer = randomUUID();
    const viewerUser = createViewerUser([authorizedServer]);
    app = await buildTestApp(viewerUser);

    const response = await app.inject({
      method: 'GET',
      url: `/stats/libraries?serverId=${unauthorizedServer}`,
    });

    expect(response.statusCode).toBe(403);
  });

  it('requires authentication', async () => {
    const noAuthApp = Fastify({ logger: false });
    await noAuthApp.register(sensible);
    noAuthApp.decorate('authenticate', async () => {
      throw new Error('Unauthorized');
    });
    await noAuthApp.register(contentRoutes, { prefix: '/stats' });

    const response = await noAuthApp.inject({
      method: 'GET',
      url: '/stats/libraries',
    });

    expect(response.statusCode).toBe(500);
    await noAuthApp.close();
  });
});
