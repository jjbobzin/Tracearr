/**
 * Stale and ROI identity-dedup correctness, against a real database.
 *
 * A title merged across two libraries (the issue #958 shape: Jellyfin
 * merge-versions, both entries listing both physical files) must appear
 * ONCE in the stale and ROI tables with mirror-deduped bytes, and a watch
 * on either entry must count for the title. Dead Weight already behaves
 * this way; these prove stale and ROI agree with it.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- storageIdentity
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import type { AuthUser } from '@tracearr/shared';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
  createTestLibraryItemVersion,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { media } from '../../src/db/schema.js';
import { libraryStaleRoute } from '../../src/routes/library/stale.js';
import { libraryRoiRoute } from '../../src/routes/library/roi.js';

async function buildApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('authenticate', async (request: FastifyRequest) => {
    (request as FastifyRequest & { user: AuthUser }).user = authUser;
  });
  app.decorate('redis', createMockRedis() as unknown as Redis);
  await app.register(libraryStaleRoute, { prefix: '/library' });
  await app.register(libraryRoiRoute, { prefix: '/library' });
  return app;
}

function ownerUser(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}

/**
 * Seed the #958 shape: one canonical movie, two library entries on the same
 * server (different libraries), each listing the SAME two physical files
 * (sizes 100 and 60), item file_size carrying the per-entry sum (160).
 */
async function seedMergedMovie(serverId: string, title: string) {
  const [mediaRow] = await db
    .insert(media)
    .values({
      mediaType: 'movie',
      matchKey: `movie:test:${randomUUID()}`,
      title,
      normalizedTitle: title.toLowerCase(),
      year: 2023,
    })
    .returning({ id: media.id });
  const mediaId = mediaRow!.id;

  const itemA = await createTestLibraryItem({
    serverId,
    libraryId: 'lib-movies',
    title,
    mediaType: 'movie',
    mediaId,
    fileSize: 160,
    withoutVersion: true,
  });
  const itemB = await createTestLibraryItem({
    serverId,
    libraryId: 'lib-movies-4k',
    title,
    mediaType: 'movie',
    mediaId,
    fileSize: 160,
    withoutVersion: true,
  });
  for (const item of [itemA, itemB]) {
    await createTestLibraryItemVersion({
      libraryItemId: item.id,
      serverVersionKey: 'v-4k',
      fileSize: 100,
      videoResolution: '4k',
    });
    await createTestLibraryItemVersion({
      libraryItemId: item.id,
      serverVersionKey: 'v-1080',
      fileSize: 60,
      videoResolution: '1080p',
    });
  }
  return { mediaId, itemA, itemB };
}

describe('stale content identity dedup', () => {
  it('lists a merged never-watched movie once with mirror-deduped bytes', async () => {
    const server = await createTestServer({ type: 'jellyfin' });
    const title = `Merged Movie ${randomUUID().slice(0, 8)}`;
    await seedMergedMovie(server.id, title);

    const app = await buildApp(ownerUser());
    const response = await app.inject({
      method: 'GET',
      url: `/library/stale?serverIds=${server.id}&category=never_watched&pageSize=50`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: { title: string; fileSize: number | null }[];
      summary: { neverWatched: { count: number; sizeBytes: number } };
    }>();

    const rows = body.items.filter((item) => item.title === title);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileSize).toBe(160);
    expect(body.summary.neverWatched.count).toBe(1);
    expect(body.summary.neverWatched.sizeBytes).toBe(160);
  });

  it('counts a watch on either library entry for the title', async () => {
    const server = await createTestServer({ type: 'jellyfin' });
    const person = await createTestUser({ role: 'member' });
    const serverUser = await createTestServerUser({ userId: person.id, serverId: server.id });
    const title = `Watched Merged ${randomUUID().slice(0, 8)}`;
    const { itemB } = await seedMergedMovie(server.id, title);

    // Watched five minutes ago through the 4K library entry only
    await createTestSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      ratingKey: itemB.ratingKey,
      durationMs: 3_600_000,
      stoppedAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const app = await buildApp(ownerUser());
    const response = await app.inject({
      method: 'GET',
      url: `/library/stale?serverIds=${server.id}&pageSize=50`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json<{ items: { title: string }[] }>();
    // Recently watched via one entry: the title is neither never-watched nor
    // stale, so it must not appear at all - not even via its sibling entry
    expect(body.items.filter((item) => item.title === title)).toHaveLength(0);
  });
});

describe('roi identity dedup', () => {
  it('scores a merged movie once over mirror-deduped bytes', async () => {
    const server = await createTestServer({ type: 'jellyfin' });
    const title = `ROI Merged ${randomUUID().slice(0, 8)}`;
    await seedMergedMovie(server.id, title);

    const app = await buildApp(ownerUser());
    const response = await app.inject({
      method: 'GET',
      url: `/library/roi?serverIds=${server.id}&pageSize=100`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      items: { title: string; fileSizeBytes: number }[];
    }>();

    const rows = body.items.filter((item) => item.title === title);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileSizeBytes).toBe(160);
  });
});
