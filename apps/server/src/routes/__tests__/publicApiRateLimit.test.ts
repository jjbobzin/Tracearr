// Registers @fastify/rate-limit with the same keyGenerator shape as index.ts and
// the same shared-limiter wiring as publicV2/index.ts; keep the three in sync.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createPublicApiRateLimitKey } from '../../utils/publicApiRateLimitKey.js';

const validTokens = new Set(['trr_pub_tokenA', 'trr_pub_tokenB']);
const isValidToken = vi.fn(async (token: string) => validTokens.has(token));
const keyGenerator = createPublicApiRateLimitKey(isValidToken);

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(rateLimit, {
    max: 1000,
    timeWindow: '1 minute',
    keyGenerator,
  });

  app.get('/limited', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => ({
    ok: true,
  }));

  // Mirrors publicV2/index.ts: one limiter hook shared by every route in the
  // scope, with per-route limiting disabled, so the budget spans all routes.
  await app.register(async (v2) => {
    v2.addHook('preHandler', v2.rateLimit({ max: 2, timeWindow: '1 minute' }));
    v2.get('/v2/a', { config: { rateLimit: false } }, async () => ({ ok: 'a' }));
    v2.get('/v2/b', { config: { rateLimit: false } }, async () => ({ ok: 'b' }));
  });

  return app;
}

describe('public API rate limit keyGenerator', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows two requests then 429s the third for the same validated token', async () => {
    const headers = { authorization: 'Bearer trr_pub_tokenA' };

    const first = await app.inject({ method: 'GET', url: '/limited', headers });
    const second = await app.inject({ method: 'GET', url: '/limited', headers });
    const third = await app.inject({ method: 'GET', url: '/limited', headers });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });

  it('gives a different validated token on the same IP its own bucket', async () => {
    const headersA = { authorization: 'Bearer trr_pub_tokenA' };
    const headersB = { authorization: 'Bearer trr_pub_tokenB' };

    await app.inject({ method: 'GET', url: '/limited', headers: headersA });
    await app.inject({ method: 'GET', url: '/limited', headers: headersA });
    const exhaustedA = await app.inject({ method: 'GET', url: '/limited', headers: headersA });
    const firstB = await app.inject({ method: 'GET', url: '/limited', headers: headersB });

    expect(exhaustedA.statusCode).toBe(429);
    expect(firstB.statusCode).toBe(200);
  });

  it('keys requests without a token by IP', async () => {
    const first = await app.inject({ method: 'GET', url: '/limited' });
    const second = await app.inject({ method: 'GET', url: '/limited' });
    const third = await app.inject({ method: 'GET', url: '/limited' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });

  it('shares the plain per-IP bucket across rotating fabricated tokens', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/limited',
      headers: { authorization: 'Bearer trr_pub_fake1' },
    });
    const second = await app.inject({
      method: 'GET',
      url: '/limited',
      headers: { authorization: 'Bearer trr_pub_fake2' },
    });
    const third = await app.inject({
      method: 'GET',
      url: '/limited',
      headers: { authorization: 'Bearer trr_pub_fake3' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });

  it('a fabricated token and an anonymous request share the same exhausted bucket', async () => {
    await app.inject({
      method: 'GET',
      url: '/limited',
      headers: { authorization: 'Bearer trr_pub_fake1' },
    });
    await app.inject({
      method: 'GET',
      url: '/limited',
      headers: { authorization: 'Bearer trr_pub_fake2' },
    });
    const anon = await app.inject({ method: 'GET', url: '/limited' });

    expect(anon.statusCode).toBe(429);
  });
});

describe('shared scope-wide rate limit (publicV2 wiring)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('one validated token budget spans every route in the scope', async () => {
    const headers = { authorization: 'Bearer trr_pub_tokenA' };

    const first = await app.inject({ method: 'GET', url: '/v2/a', headers });
    const second = await app.inject({ method: 'GET', url: '/v2/b', headers });
    const third = await app.inject({ method: 'GET', url: '/v2/a', headers });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
  });

  it('a second validated token still gets its own scope-wide budget', async () => {
    const headersA = { authorization: 'Bearer trr_pub_tokenA' };
    const headersB = { authorization: 'Bearer trr_pub_tokenB' };

    await app.inject({ method: 'GET', url: '/v2/a', headers: headersA });
    await app.inject({ method: 'GET', url: '/v2/b', headers: headersA });
    const exhaustedA = await app.inject({ method: 'GET', url: '/v2/b', headers: headersA });
    const firstB = await app.inject({ method: 'GET', url: '/v2/a', headers: headersB });

    expect(exhaustedA.statusCode).toBe(429);
    expect(firstB.statusCode).toBe(200);
  });
});
