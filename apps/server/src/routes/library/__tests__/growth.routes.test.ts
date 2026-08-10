/**
 * Library growth route tests
 *
 * db.execute is mocked (this suite's convention, see catalog.routes.test.ts),
 * so these prove handler mechanics, response shape, and the custom-range
 * override - not SQL correctness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';
import { renderSql } from '../../../test/helpers.js';

vi.mock('../../../db/client.js', () => ({
  db: {
    execute: vi.fn(),
  },
}));

import { db } from '../../../db/client.js';
import { libraryGrowthRoute } from '../growth.js';

function normalize(sqlText: string): string {
  return sqlText.replace(/\s+/g, ' ').trim();
}

function renderQuery(query: unknown): { text: string; params: unknown[] } {
  const { sql, params } = renderSql(query as never);
  return { text: normalize(sql), params };
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
  await app.register(libraryGrowthRoute, { prefix: '/library' });
  return app;
}

function createOwnerUser(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

const isEarliestLookup = (text: string) => text.includes('MIN(day)::date AS earliest');
const isMainQuery = (text: string) => text.includes('WITH day_scope AS');

function mockEmptyCompute() {
  vi.mocked(db.execute).mockResolvedValue({ rows: [] } as never);
}

describe('GET /library/growth', () => {
  let app: FastifyInstance;
  const dbExecute = vi.mocked(db.execute);

  beforeEach(() => {
    dbExecute.mockReset();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('rejects a malformed period token', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);

    const response = await app.inject({ method: 'GET', url: '/library/growth?period=fortnight' });
    expect(response.statusCode).toBe(400);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('rejects a custom range where startDate is after endDate', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);

    const response = await app.inject({
      method: 'GET',
      url: '/library/growth?startDate=2026-02-01T00:00:00.000Z&endDate=2026-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(400);
    expect(dbExecute).not.toHaveBeenCalled();
  });

  it('uses the custom startDate/endDate window instead of the period token when both are present', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);

    let mainQueryParams: unknown[] = [];
    dbExecute.mockImplementation(((query: unknown) => {
      const { text, params } = renderQuery(query);
      if (isMainQuery(text)) mainQueryParams = params;
      return Promise.resolve({ rows: [] });
    }) as never);

    const response = await app.inject({
      method: 'GET',
      // period=30d would normally bound the window to "now - 30d", but a
      // custom range takes over entirely when both dates are present.
      url: '/library/growth?period=30d&startDate=2026-01-01T00:00:00.000Z&endDate=2026-01-05T00:00:00.000Z',
    });

    expect(response.statusCode).toBe(200);
    expect(mainQueryParams).toContain('2026-01-01T00:00:00.000Z');
    expect(mainQueryParams).toContain('2026-01-05T00:00:00.000Z');
    expect(response.json().period).toBe('custom');
  });

  it('skips the earliest-date lookup when a custom range is provided, even with no period=all', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    mockEmptyCompute();

    await app.inject({
      method: 'GET',
      url: '/library/growth?startDate=2026-01-01T00:00:00.000Z&endDate=2026-01-05T00:00:00.000Z',
    });

    expect(dbExecute.mock.calls.some((call) => isEarliestLookup(renderQuery(call[0]).text))).toBe(
      false
    );
  });

  it('falls back to the period token when only one of startDate/endDate is present', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    mockEmptyCompute();

    const response = await app.inject({
      method: 'GET',
      url: '/library/growth?period=7d&startDate=2026-01-01T00:00:00.000Z',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().period).toBe('7d');
  });

  it('scopes the cache key by the raw custom dates so it never collides with the period-token entry', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    mockEmptyCompute();

    await app.inject({ method: 'GET', url: '/library/growth?period=30d' });
    expect(dbExecute).toHaveBeenCalled();

    dbExecute.mockClear();
    await app.inject({
      method: 'GET',
      url: '/library/growth?period=30d&startDate=2026-01-01T00:00:00.000Z&endDate=2026-01-05T00:00:00.000Z',
    });
    // A distinct (custom) cache key -> full recompute, not a hit off the
    // plain 30d entry cached above.
    expect(dbExecute).toHaveBeenCalled();
    expect(redis.setex).toHaveBeenCalledTimes(2);
  });

  it('two different custom ranges never share a cache entry', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    mockEmptyCompute();

    await app.inject({
      method: 'GET',
      url: '/library/growth?startDate=2026-01-01T00:00:00.000Z&endDate=2026-01-05T00:00:00.000Z',
    });
    dbExecute.mockClear();
    await app.inject({
      method: 'GET',
      url: '/library/growth?startDate=2026-02-01T00:00:00.000Z&endDate=2026-02-05T00:00:00.000Z',
    });

    expect(dbExecute).toHaveBeenCalled();
    expect(redis.setex).toHaveBeenCalledTimes(2);
  });

  it('caches a plain period-token response and serves it back verbatim on a hit', async () => {
    const redis = createSpyRedis();
    app = await buildTestApp(createOwnerUser(), redis);
    mockEmptyCompute();

    const first = await app.inject({ method: 'GET', url: '/library/growth?period=7d' });
    expect(first.statusCode).toBe(200);
    expect(redis.setex).toHaveBeenCalledTimes(1);

    dbExecute.mockClear();
    const second = await app.inject({ method: 'GET', url: '/library/growth?period=7d' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(dbExecute).not.toHaveBeenCalled();
  });
});
