/**
 * Genres aggregate route tests
 *
 * db.execute is mocked (this suite's convention, see catalog.routes.test.ts),
 * so these prove handler mechanics, response shape, and the cache contract -
 * not SQL correctness. Real-DB query correctness (merge bucketing, scoping,
 * type filtering) lives in apps/server/test/integration/genres.integration.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, GenresResponse } from '@tracearr/shared';
import { renderSql } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

import { db } from '../../../db/client.js';
import { libraryGenresRoute } from '../genres.js';

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function createSpyRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    setex: vi.fn(async (key: string, _seconds: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
  };
}

async function buildTestApp(
  authUser: AuthUser,
  redis: ReturnType<typeof createSpyRedis>
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: AuthUser }) => {
    request.user = authUser;
  });
  app.decorate('redis', redis as never);
  await app.register(libraryGenresRoute, { prefix: '/library' });
  return app;
}

function createOwnerUser(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

function createViewerUser(serverIds: string[]): AuthUser {
  return { userId: randomUUID(), username: 'viewer', role: 'viewer', serverIds };
}

describe('GET /library/genres', () => {
  let app: FastifyInstance;
  const dbExecute = vi.mocked(db.execute);

  beforeEach(() => {
    dbExecute.mockReset();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('rejects a request missing the required type param', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const response = await app.inject({ method: 'GET', url: '/library/genres' });
    expect(response.statusCode).toBe(400);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('rejects an invalid type value', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    const response = await app.inject({ method: 'GET', url: '/library/genres?type=song' });
    expect(response.statusCode).toBe(400);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('shapes a populated response merging item counts and engagement per genre', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);

    dbExecute
      .mockResolvedValueOnce({
        rows: [
          { genre: 'Action', item_count: '3' },
          { genre: 'Drama', item_count: '1' },
        ],
      } as never) // item counts
      .mockResolvedValueOnce({
        rows: [{ genre: 'Action', plays: '10', watch_time_ms: '600000' }],
      } as never); // engagement (Drama has zero plays, so no row)

    const response = await app.inject({ method: 'GET', url: '/library/genres?type=movie' });
    expect(response.statusCode).toBe(200);
    const body: GenresResponse = response.json();
    expect(body.data).toEqual([
      { genre: 'Action', itemCount: 3, plays: 10, watchTimeMs: 600000 },
      { genre: 'Drama', itemCount: 1, plays: 0, watchTimeMs: 0 },
    ]);
    expect(dbExecute).toHaveBeenCalledTimes(2);
  });

  it('threads the type filter into both queries', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);

    dbExecute
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const response = await app.inject({ method: 'GET', url: '/library/genres?type=show' });
    expect(response.statusCode).toBe(200);
    const [itemCountCall, engagementCall] = dbExecute.mock.calls;
    const itemCountQuery = renderSql(itemCountCall![0] as never);
    const engagementQuery = renderSql(engagementCall![0] as never);
    expect(normalize(itemCountQuery.sql)).toContain('m.media_type =');
    expect(itemCountQuery.params).toContain('show');
    expect(normalize(engagementQuery.sql)).toContain('p.show_media_id IS NOT NULL');
    expect(normalize(engagementQuery.sql)).toContain('pm.id = p.show_media_id');
  });

  it('caches the computed genres per (scope, type) and skips recompute on a hit', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);

    dbExecute
      .mockResolvedValueOnce({ rows: [{ genre: 'Action', item_count: '1' }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const first = await app.inject({ method: 'GET', url: '/library/genres?type=movie' });
    expect(first.statusCode).toBe(200);
    expect(dbExecute).toHaveBeenCalledTimes(2);
    expect(redis.setex).toHaveBeenCalledTimes(1);

    dbExecute.mockReset();
    const second = await app.inject({ method: 'GET', url: '/library/genres?type=movie' });
    expect(second.statusCode).toBe(200);
    expect(dbExecute).not.toHaveBeenCalled();
    expect(second.json()).toEqual(first.json());
    // setex is only called on a cache miss - still just the one call from before.
    expect(redis.setex).toHaveBeenCalledTimes(1);
  });

  it('uses a distinct cache entry per scope for the same type', async () => {
    const redisA = createSpyRedis();
    const redisB = createSpyRedis();
    const serverA = randomUUID();
    const serverB = randomUUID();

    const appA = await buildTestApp(createViewerUser([serverA]), redisA);
    dbExecute
      .mockResolvedValueOnce({ rows: [{ genre: 'Action', item_count: '1' }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    await appA.inject({ method: 'GET', url: '/library/genres?type=movie' });
    await appA.close();

    dbExecute.mockReset();
    const appB = await buildTestApp(createViewerUser([serverB]), redisB);
    dbExecute
      .mockResolvedValueOnce({ rows: [{ genre: 'Drama', item_count: '1' }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    await appB.inject({ method: 'GET', url: '/library/genres?type=movie' });
    await appB.close();

    expect(dbExecute).toHaveBeenCalledTimes(2);
  });
});
