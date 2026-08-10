/**
 * Duplicates endpoint at scale: two fully mirrored servers, 91k library
 * items, 91.4k version rows. Proves the SQL grouping finds exactly the
 * seeded real duplicates under ~85k mirror-noise candidates, stays inside a
 * sane request budget, and never trips postgres's 65535 bind-parameter cap.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- duplicatesScale
 */

import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AuthUser, DuplicatesResponse } from '@tracearr/shared';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { libraryDuplicatesRoute } from '../../src/routes/library/duplicates.js';

const SERVER_A = randomUUID();
const SERVER_B = randomUUID();
const MOVIES = 5500;
const DUP_MOVIES = 200;
const EPISODES = 40000;

async function buildApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = authUser;
  });
  app.decorate('redis', createMockRedis() as unknown as Redis);
  await app.register(libraryDuplicatesRoute, { prefix: '/library' });
  return app;
}

async function seedMirroredFleet(): Promise<void> {
  await db.execute(sql`
    INSERT INTO servers (id, name, type, url, token) VALUES
      (${SERVER_A}::uuid, 'scale-a', 'plex', 'http://a', 'tok-a'),
      (${SERVER_B}::uuid, 'scale-b', 'plex', 'http://b', 'tok-b')
  `);

  // Movies mirrored on both servers: same imdb id, same byte size. The first
  // DUP_MOVIES titles live in lib-dup and later gain a second distinct file.
  await db.execute(sql`
    INSERT INTO library_items
      (server_id, library_id, rating_key, title, media_type, year, imdb_id, video_resolution, file_size)
    SELECT
      s.id, CASE WHEN i <= ${DUP_MOVIES} THEN 'lib-dup' ELSE 'lib-movies' END,
      'mv-' || i::text, 'Scale Movie ' || i::text, 'movie', 2000 + (i % 25),
      'tt9' || lpad(i::text, 6, '0'), '4k',
      2000000000 + i * 2000
    FROM generate_series(1, ${MOVIES}) AS i
    CROSS JOIN (VALUES (${SERVER_A}::uuid), (${SERVER_B}::uuid)) AS s(id)
  `);

  // Episodes mirrored on both servers: same tvdb id, same byte size
  await db.execute(sql`
    INSERT INTO library_items
      (server_id, library_id, rating_key, title, media_type, year, tvdb_id, video_resolution, file_size)
    SELECT
      s.id, 'lib-tv', 'ep-' || i::text, 'Scale Episode ' || i::text, 'episode', 2010 + (i % 15),
      9000000 + i, '1080p',
      300000000 + i * 100
    FROM generate_series(1, ${EPISODES}) AS i
    CROSS JOIN (VALUES (${SERVER_A}::uuid), (${SERVER_B}::uuid)) AS s(id)
  `);

  await db.execute(sql`
    INSERT INTO library_item_versions
      (library_item_id, server_version_key, video_resolution, file_size, part_count)
    SELECT id, 'v1', video_resolution, file_size, 1
    FROM library_items
    WHERE server_id IN (${SERVER_A}::uuid, ${SERVER_B}::uuid)
  `);

  // The second, genuinely distinct file for the dup titles (mirrored too, so
  // it counts once): half the primary's size
  await db.execute(sql`
    INSERT INTO library_item_versions
      (library_item_id, server_version_key, video_resolution, file_size, part_count)
    SELECT id, 'v2', '1080p', file_size / 2, 1
    FROM library_items
    WHERE server_id IN (${SERVER_A}::uuid, ${SERVER_B}::uuid) AND library_id = 'lib-dup'
  `);

  // A real installation has autovacuum statistics; freshly seeded tables do
  // not, and rows=1 estimates turn the group query into nested-loop plans
  await db.execute(sql`ANALYZE library_items, library_item_versions`);
}

describe('duplicates at mirrored-fleet scale', () => {
  it(
    'finds exactly the real duplicates among ~91k mirrored items, fast enough',
    { timeout: 180_000 },
    async () => {
      await seedMirroredFleet();

      const app = await buildApp({
        userId: randomUUID(),
        username: 'owner',
        role: 'owner',
        serverIds: [],
      });

      const started = performance.now();
      const response = await app.inject({
        method: 'GET',
        url: `/library/duplicates?serverIds=${SERVER_A}&serverIds=${SERVER_B}&pageSize=10`,
      });
      const elapsedMs = Math.round(performance.now() - started);
      console.log(`[duplicatesScale] cold request took ${elapsedMs}ms`);

      expect(response.statusCode).toBe(200);
      const body = response.json<DuplicatesResponse>();

      expect(body.summary.totalGroups).toBe(DUP_MOVIES);
      expect(body.summary.byMatchType.imdb).toBe(DUP_MOVIES);
      // Savings = the smaller file of each dup title, counted once across
      // both servers: sum over i of (1000000000 + i*1000)
      const expectedSavings =
        DUP_MOVIES * 1000000000 + (1000 * (DUP_MOVIES * (DUP_MOVIES + 1))) / 2;
      expect(body.summary.totalPotentialSavingsBytes).toBe(expectedSavings);

      expect(body.duplicates).toHaveLength(10);
      const savings = body.duplicates.map((g) => g.potentialSavingsBytes);
      expect([...savings].sort((a, b) => b - a)).toEqual(savings);
      for (const group of body.duplicates) {
        expect(group.serverCount).toBe(2);
        expect(group.uniqueFileCount).toBe(2);
      }

      // Generous CI bound; the point is "seconds, not minutes, never a crash"
      expect(elapsedMs).toBeLessThan(20000);
    }
  );
});
