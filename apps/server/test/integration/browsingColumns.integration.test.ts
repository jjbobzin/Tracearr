/**
 * Browsing columns integration test.
 *
 * media.latest_added_at and library_items.thumb_path/dominant_color back the
 * Phase 3 browsing UI (recently-added ordering, poster thumbnails, color
 * accents). Confirms the columns exist and are queryable.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- browsingColumns
 */

import { describe, it, expect } from 'vitest';
import { createTestServer, createTestLibraryItem } from '@tracearr/test-utils/factories';
import { executeRawSql } from '@tracearr/test-utils/db';
import { db } from '../../src/db/client.js';
import { media } from '../../src/db/schema.js';

describe('browsing columns', () => {
  it('media has a queryable latest_added_at column', async () => {
    await db.insert(media).values({
      mediaType: 'movie',
      matchKey: 'movie:title:browsing-columns-test:2020',
      title: 'Browsing Columns Test',
      normalizedTitle: 'browsing columns test',
      year: 2020,
    });
    const result = await executeRawSql('SELECT latest_added_at FROM media');
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('library_items has queryable thumb_path and dominant_color columns', async () => {
    const server = await createTestServer({ type: 'plex' });
    await createTestLibraryItem({ serverId: server.id });
    const result = await executeRawSql('SELECT thumb_path, dominant_color FROM library_items');
    expect(result.rows.length).toBeGreaterThan(0);
  });
});
