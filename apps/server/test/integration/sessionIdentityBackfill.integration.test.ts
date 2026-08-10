/**
 * Backfill of canonical media identity onto historical sessions.
 *
 * backfillSessionIdentityBatch stamps media_id and provider ids onto existing
 * sessions rows by joining library_items on (server_id, rating_key). It runs in
 * bounded batches and is resumable: sessions whose rating key has no resolvable
 * library item are excluded so they never re-select.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- sessionIdentityBackfill
 */

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestLibraryItem,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
import { backfillSessionIdentityBatch } from '../../src/jobs/sessionIdentityBackfill.js';

describe('session identity backfill', () => {
  it('backfills identity onto old sessions from library items', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: '2733',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: '2733',
      imdbId: 'tt0322259',
      mediaId,
    });
    await createTestSession({ serverId: server.id, serverUserId: su.id, ratingKey: '2733' });

    const { updated } = await backfillSessionIdentityBatch(1000);
    expect(updated).toBe(1);

    const { rows } = await db.execute(
      sql`SELECT media_id, imdb_id FROM sessions WHERE rating_key = '2733'`
    );
    const row = rows[0] as { media_id: string; imdb_id: string };
    expect(row.media_id).toBe(mediaId);
    expect(row.imdb_id).toBe('tt0322259');
  });

  it('is resumable: second run finds nothing left', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: '2733',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: '2733',
      imdbId: 'tt0322259',
      mediaId,
    });
    await createTestSession({ serverId: server.id, serverUserId: su.id, ratingKey: '2733' });

    await backfillSessionIdentityBatch(1000);
    const { updated } = await backfillSessionIdentityBatch(1000);
    expect(updated).toBe(0);
  });

  it('returns oldest as a real Date usable by refreshAggregates', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: '2733',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: '2733',
      imdbId: 'tt0322259',
      mediaId,
    });
    await createTestSession({ serverId: server.id, serverUserId: su.id, ratingKey: '2733' });

    const { updated, oldest } = await backfillSessionIdentityBatch(1000);
    expect(updated).toBeGreaterThanOrEqual(1);
    expect(oldest).toBeInstanceOf(Date);
    expect(typeof oldest?.toISOString).toBe('function');
    expect(() => oldest?.toISOString()).not.toThrow();
  });

  it('leaves sessions whose rating key has no library item untouched', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const su = await createTestServerUser({ userId: user.id, serverId: server.id });
    await createTestSession({ serverId: server.id, serverUserId: su.id, ratingKey: 'orphan-rk' });

    const { updated } = await backfillSessionIdentityBatch(1000);
    expect(updated).toBe(0);

    const { rows } = await db.execute(
      sql`SELECT media_id FROM sessions WHERE rating_key = 'orphan-rk'`
    );
    expect((rows[0] as { media_id: string | null }).media_id).toBeNull();
  });
});
