/**
 * Identity-aware plays aggregate integration test.
 *
 * user_media_plays_daily counts one play per user-media-day that was actually
 * watched: a chain start (reference_id null) past the 120s play gate. Chained
 * continuations and short sessions must not add plays. media_plays_daily rolls
 * the per-user cagg up to per-media-day with a distinct-user count.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- mediaPlaysAggregate
 */

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';

describe('identity-aware plays aggregates', () => {
  it('counts one play per watched chain start, excluding continuations and short sessions', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ userId: user.id, serverId: server.id });

    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 27205,
      title: 'Inception',
      year: 2010,
      serverId: server.id,
      ratingKey: 'rk-1',
    });

    const chainStart = await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId,
      ratingKey: 'rk-1',
      durationMs: 1_800_000,
      totalDurationMs: 7_200_000,
      referenceId: null,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId,
      ratingKey: 'rk-1',
      durationMs: 1_800_000,
      totalDurationMs: 7_200_000,
      referenceId: chainStart.id,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId,
      ratingKey: 'rk-1',
      durationMs: 60_000,
      totalDurationMs: 7_200_000,
      referenceId: null,
      shortSession: true,
    });

    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    const userRows = await db.execute(sql`
      SELECT plays::int AS plays
      FROM user_media_plays_daily
      WHERE server_user_id = ${account.id} AND media_id = ${mediaId}
    `);
    expect(userRows.rows).toHaveLength(1);
    expect((userRows.rows[0] as { plays: number }).plays).toBe(1);

    const mediaRows = await db.execute(sql`
      SELECT plays::int AS plays, unique_users::int AS unique_users
      FROM media_plays_daily
      WHERE server_id = ${server.id} AND media_id = ${mediaId}
    `);
    expect(mediaRows.rows).toHaveLength(1);
    const row = mediaRows.rows[0] as { plays: number; unique_users: number };
    expect(row.plays).toBe(1);
    expect(row.unique_users).toBe(1);
  });

  it('tracks any_watched per user-media-day', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ userId: user.id, serverId: server.id });

    const watchedMediaId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 27206,
      title: 'Inception 2',
      year: 2010,
      serverId: server.id,
      ratingKey: 'rk-2',
    });
    const unwatchedMediaId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 27207,
      title: 'Inception 3',
      year: 2010,
      serverId: server.id,
      ratingKey: 'rk-3',
    });

    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: watchedMediaId,
      ratingKey: 'rk-2',
      durationMs: 1_800_000,
      totalDurationMs: 7_200_000,
      referenceId: null,
      watched: true,
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: unwatchedMediaId,
      ratingKey: 'rk-3',
      durationMs: 1_800_000,
      totalDurationMs: 7_200_000,
      referenceId: null,
      watched: false,
    });

    await db.execute(
      sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );

    const watchedRows = await db.execute(sql`
      SELECT any_watched
      FROM user_media_plays_daily
      WHERE server_user_id = ${account.id} AND media_id = ${watchedMediaId}
    `);
    expect(watchedRows.rows).toHaveLength(1);
    expect((watchedRows.rows[0] as { any_watched: boolean }).any_watched).toBe(true);

    const unwatchedRows = await db.execute(sql`
      SELECT any_watched
      FROM user_media_plays_daily
      WHERE server_user_id = ${account.id} AND media_id = ${unwatchedMediaId}
    `);
    expect(unwatchedRows.rows).toHaveLength(1);
    expect((unwatchedRows.rows[0] as { any_watched: boolean }).any_watched).toBe(false);
  });
});
