/**
 * Library sync browsing-column integration tests.
 *
 * Confirms upsertItems carries thumbPath into the row (and updates it on
 * resync), never touches dominantColor, and that media.latest_added_at
 * tracks the newest active copy across upserts and removals.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- librarySyncBrowsingColumns
 */

import { describe, it, expect } from 'vitest';
import { createTestServer } from '@tracearr/test-utils/factories';
import { executeRawSql } from '@tracearr/test-utils/db';
import { db } from '../../src/db/client.js';
import { libraryItems, media } from '../../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { librarySyncService } from '../../src/services/librarySync.js';

function makeItem(overrides: Record<string, unknown>) {
  return {
    ratingKey: 'rk-1',
    title: 'Browsing Columns Movie',
    mediaType: 'movie',
    year: 2005,
    imdbId: 'tt0400000',
    addedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

describe('library sync browsing columns', () => {
  it('carries thumbPath into the insert and updates it on resync', async () => {
    const server = await createTestServer({ type: 'plex' });
    await librarySyncService.upsertItems(server.id, 'lib', [
      makeItem({ thumbPath: '/library/metadata/rk-1/thumb/1' }),
    ] as never);

    let [row] = await db.select().from(libraryItems).where(eq(libraryItems.serverId, server.id));
    expect(row!.thumbPath).toBe('/library/metadata/rk-1/thumb/1');

    await librarySyncService.upsertItems(server.id, 'lib', [
      makeItem({ thumbPath: '/library/metadata/rk-1/thumb/2' }),
    ] as never);

    [row] = await db.select().from(libraryItems).where(eq(libraryItems.serverId, server.id));
    expect(row!.thumbPath).toBe('/library/metadata/rk-1/thumb/2');
  });

  it('never nulls or overwrites dominantColor on resync', async () => {
    const server = await createTestServer({ type: 'plex' });
    await librarySyncService.upsertItems(server.id, 'lib', [makeItem({})] as never);

    await executeRawSql(
      `UPDATE library_items SET dominant_color = '#abcdef' WHERE server_id = '${server.id}'`
    );

    await librarySyncService.upsertItems(server.id, 'lib', [
      makeItem({ title: 'Retitled' }),
    ] as never);

    const [row] = await db.select().from(libraryItems).where(eq(libraryItems.serverId, server.id));
    expect(row!.dominantColor).toBe('#abcdef');
    expect(row!.title).toBe('Retitled');
  });

  it('tracks the newest active copy across upserts and removals, dropping to NULL when empty', async () => {
    const s1 = await createTestServer({ type: 'plex' });
    const s2 = await createTestServer({ type: 'jellyfin' });

    // Older copy on s1
    await librarySyncService.upsertItems(s1.id, 'lib', [
      makeItem({ ratingKey: 's1-key', addedAt: new Date('2024-01-01') }),
    ] as never);

    let [row] = await db.select().from(libraryItems).where(eq(libraryItems.serverId, s1.id));
    const mediaId = row!.mediaId!;
    let [mediaRow] = await db.select().from(media).where(eq(media.id, mediaId));
    expect(mediaRow!.latestAddedAt?.toISOString()).toBe(new Date('2024-01-01').toISOString());

    // Newer copy on s2, resolved to the same media row via shared imdbId
    await librarySyncService.upsertItems(s2.id, 'lib', [
      makeItem({ ratingKey: 's2-key', addedAt: new Date('2024-06-01') }),
    ] as never);

    [mediaRow] = await db.select().from(media).where(eq(media.id, mediaId));
    expect(mediaRow!.latestAddedAt?.toISOString()).toBe(new Date('2024-06-01').toISOString());

    // Remove the newest copy - falls back to the next-newest active copy
    await librarySyncService.markItemsRemoved(s2.id, 'lib', ['s2-key']);

    [mediaRow] = await db.select().from(media).where(eq(media.id, mediaId));
    expect(mediaRow!.latestAddedAt?.toISOString()).toBe(new Date('2024-01-01').toISOString());

    // Remove the last active copy - resets to NULL
    await librarySyncService.markItemsRemoved(s1.id, 'lib', ['s1-key']);

    [mediaRow] = await db.select().from(media).where(eq(media.id, mediaId));
    expect(mediaRow!.latestAddedAt).toBeNull();
  });
});
