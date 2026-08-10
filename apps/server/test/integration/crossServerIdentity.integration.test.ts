/**
 * Cross-server media identity acceptance proof.
 *
 * Exercises the Phase 1 scenario end to end: one movie synced onto three
 * servers with asymmetric provider ids resolves to a single canonical media
 * row carrying the union of ids, and one watch per server groups under that
 * single media id after backfill (each session counts once as a chain start).
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- crossServerIdentity
 */

import { describe, it, expect } from 'vitest';
import { isNull, sql } from 'drizzle-orm';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { media, libraryItems } from '../../src/db/schema.js';
import { librarySyncService } from '../../src/services/librarySync.js';
import { backfillSessionIdentityBatch } from '../../src/jobs/sessionIdentityBackfill.js';

describe('cross-server media identity', () => {
  it('one movie on three servers resolves to one media row with asymmetric ids', async () => {
    const plex = await createTestServer({ type: 'plex' });
    const emby = await createTestServer({ type: 'emby' });
    const jf = await createTestServer({ type: 'jellyfin' });
    await librarySyncService.upsertItems(plex.id, 'lib', [
      {
        ratingKey: '2733',
        title: '2 Fast 2 Furious',
        mediaType: 'movie',
        year: 2003,
        imdbId: 'tt0322259',
        tmdbId: 584,
        tvdbId: 20800,
        addedAt: new Date(),
      },
    ] as never);
    await librarySyncService.upsertItems(emby.id, 'lib', [
      {
        ratingKey: '1955',
        title: '2 Fast 2 Furious',
        mediaType: 'movie',
        year: 2003,
        imdbId: 'tt0322259',
        tmdbId: 584,
        addedAt: new Date(),
      },
    ] as never);
    await librarySyncService.upsertItems(jf.id, 'lib', [
      {
        ratingKey: 'f707aa56',
        title: '2 Fast 2 Furious',
        mediaType: 'movie',
        year: 2003,
        tmdbId: 584,
        addedAt: new Date(),
      },
    ] as never);

    const mediaRows = await db.select().from(media).where(isNull(media.mergedIntoId));
    expect(mediaRows).toHaveLength(1);
    expect(mediaRows[0]!.imdbId).toBe('tt0322259');
    expect(mediaRows[0]!.tvdbId).toBe(20800);

    const items = await db.select().from(libraryItems);
    expect(new Set(items.map((i) => i.mediaId))).toEqual(new Set([mediaRows[0]!.id]));
  });

  it('a watch on each server groups under one media id', async () => {
    const plex = await createTestServer({ type: 'plex' });
    const emby = await createTestServer({ type: 'emby' });
    const jf = await createTestServer({ type: 'jellyfin' });
    await librarySyncService.upsertItems(plex.id, 'lib', [
      {
        ratingKey: '2733',
        title: '2 Fast 2 Furious',
        mediaType: 'movie',
        year: 2003,
        imdbId: 'tt0322259',
        tmdbId: 584,
        tvdbId: 20800,
        addedAt: new Date(),
      },
    ] as never);
    await librarySyncService.upsertItems(emby.id, 'lib', [
      {
        ratingKey: '1955',
        title: '2 Fast 2 Furious',
        mediaType: 'movie',
        year: 2003,
        imdbId: 'tt0322259',
        tmdbId: 584,
        addedAt: new Date(),
      },
    ] as never);
    await librarySyncService.upsertItems(jf.id, 'lib', [
      {
        ratingKey: 'f707aa56',
        title: '2 Fast 2 Furious',
        mediaType: 'movie',
        year: 2003,
        tmdbId: 584,
        addedAt: new Date(),
      },
    ] as never);

    const plexUser = await createTestUser();
    const plexSu = await createTestServerUser({ userId: plexUser.id, serverId: plex.id });
    await createTestSession({ serverId: plex.id, serverUserId: plexSu.id, ratingKey: '2733' });

    const embyUser = await createTestUser();
    const embySu = await createTestServerUser({ userId: embyUser.id, serverId: emby.id });
    await createTestSession({ serverId: emby.id, serverUserId: embySu.id, ratingKey: '1955' });

    const jfUser = await createTestUser();
    const jfSu = await createTestServerUser({ userId: jfUser.id, serverId: jf.id });
    await createTestSession({ serverId: jf.id, serverUserId: jfSu.id, ratingKey: 'f707aa56' });

    await backfillSessionIdentityBatch(1000);

    const { rows } = await db.execute(sql`
      SELECT COUNT(DISTINCT media_id) AS media_count,
             COUNT(*) FILTER (WHERE reference_id IS NULL) AS plays
      FROM sessions WHERE media_id IS NOT NULL
    `);
    const row = rows[0] as { media_count: string; plays: string };
    expect(Number(row.media_count)).toBe(1);
    expect(Number(row.plays)).toBe(3);
  });
});
