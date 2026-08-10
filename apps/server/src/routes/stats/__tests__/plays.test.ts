/**
 * Play statistics route tests
 *
 * Tests GET /stats/plays, including the frozen no-param contract mobile
 * consumes and the optional mediaType filter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import type { SQL } from 'drizzle-orm';
import { renderSql } from '../../../test/helpers.js';

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

// Mock resolveDateRange for deterministic bucketing
vi.mock('../utils.js', () => ({
  resolveDateRange: vi.fn((period: string, startDate?: string, endDate?: string) => {
    if (period === 'custom') {
      return {
        start: startDate ? new Date(startDate) : null,
        end: endDate ? new Date(endDate) : null,
      };
    }
    if (period === 'all') {
      return { start: null, end: new Date('2024-06-15T12:00:00Z') };
    }
    return {
      start: new Date('2024-06-08T12:00:00Z'),
      end: new Date('2024-06-15T12:00:00Z'),
    };
  }),
}));

import { db } from '../../../db/client.js';
import { playsRoutes } from '../plays.js';

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });

  await app.register(playsRoutes, { prefix: '/stats' });

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

// Fixed seed pinning the current /stats/plays no-param shape (mobile-consumed, frozen).
const PINNED_PLAYS_ROWS = [
  { date: '2024-06-08T00:00:00.000Z', serverId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', count: 5 },
  { date: '2024-06-09T00:00:00.000Z', serverId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', count: 3 },
];
const PINNED_PLAYS_RESPONSE = { data: PINNED_PLAYS_ROWS };

describe('Plays Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('GET /stats/plays', () => {
    it('pins the current no-param response shape byte-for-byte (frozen mobile contract)', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);
      vi.mocked(db.execute).mockResolvedValueOnce({ rows: PINNED_PLAYS_ROWS } as never);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/plays',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(PINNED_PLAYS_RESPONSE);

      // No mediaType filter clause should be present when the param is absent.
      const { sql: query } = renderSql(vi.mocked(db.execute).mock.calls[0]![0] as SQL);
      expect(query).not.toContain('media_type =');
    });

    it('filters to the requested mediaType and keeps the same response shape', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);
      const filteredRows = [
        {
          date: '2024-06-08T00:00:00.000Z',
          serverId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          count: 2,
        },
      ];
      vi.mocked(db.execute).mockResolvedValueOnce({ rows: filteredRows } as never);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/plays?mediaType=movie',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: filteredRows });

      const { sql: query, params } = renderSql(vi.mocked(db.execute).mock.calls[0]![0] as SQL);
      expect(query).toContain('media_type =');
      expect(params).toContain('movie');
    });

    it('accepts mediaType=episode', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);
      vi.mocked(db.execute).mockResolvedValueOnce({ rows: [] } as never);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/plays?mediaType=episode',
      });

      expect(response.statusCode).toBe(200);
      const { params } = renderSql(vi.mocked(db.execute).mock.calls[0]![0] as SQL);
      expect(params).toContain('episode');
    });

    it('rejects a mediaType value outside the primary media types', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/plays?mediaType=track',
      });

      expect(response.statusCode).toBe(400);
    });

    it('still validates and rejects invalid serverId', async () => {
      const ownerUser = createOwnerUser();
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'GET',
        url: '/stats/plays?serverId=not-a-uuid',
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
        url: `/stats/plays?serverId=${unauthorizedServer}`,
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
