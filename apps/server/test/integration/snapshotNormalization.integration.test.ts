/**
 * Snapshot normalization integration test.
 *
 * After the multi-version changeover, surviving pre-stamp raw snapshots
 * still carry pre-changeover semantics while everything older than raw
 * retention is already version-aware reconstruction. The normalization job
 * drops the pre-stamp chunks, regenerates them through the version-aware
 * backfill, and stamps snapshotsNormalizedAt exactly once - which is what
 * lets the storage growth fit use full history instead of waiting out the
 * 7-day post-stamp window.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- snapshotNormalization
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import { createTestServer, createTestLibraryItem } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { getSetting, setSetting } from '../../src/services/settings.js';
import {
  processNormalizeLibrarySnapshotsJob,
  type MaintenanceJobData,
} from '../../src/jobs/maintenanceQueue.js';

const DAY_MS = 86_400_000;

function stubJob(): Job<MaintenanceJobData> {
  return {
    id: `test-normalize-${randomUUID()}`,
    token: 'test-token',
    extendLock: async () => {},
    updateProgress: async () => {},
    data: { type: 'normalize_library_snapshots', userId: 'system' },
  } as unknown as Job<MaintenanceJobData>;
}

describe('processNormalizeLibrarySnapshotsJob', () => {
  it('regenerates pre-stamp history in current semantics and stamps the marker once', async () => {
    const server = await createTestServer();
    const libraryId = 'lib-normalize';
    const itemDay = new Date(Date.now() - 10 * DAY_MS);
    // Current item state: one movie, 100 bytes, added 10 days ago. The
    // factory mirrors the size into a version row, so the reconstruction
    // sees version-aware data.
    await createTestLibraryItem({
      serverId: server.id,
      libraryId,
      fileSize: 100,
      videoResolution: '4k',
      createdAt: itemDay,
    });

    // A surviving pre-changeover live snapshot for that day: 40 bytes, the
    // old single-file semantics this job exists to replace
    await db.execute(sql`
      INSERT INTO library_snapshots (server_id, library_id, snapshot_time, item_count, total_size)
      VALUES (${server.id}::uuid, ${libraryId}, ${new Date(itemDay.getTime() + 12 * 3_600_000).toISOString()}::timestamptz, 1, 40)
    `);

    const stamp = new Date(Date.now() - 2 * DAY_MS).toISOString();
    await setSetting('mediaVersionsBackfilledAt', stamp);
    await setSetting('snapshotsNormalizedAt', null);

    const result = await processNormalizeLibrarySnapshotsJob(stubJob());
    expect(result.success).toBe(true);
    expect(result.type).toBe('normalize_library_snapshots');

    // The old-semantics 40-byte row is gone; the regenerated day carries the
    // version-aware 100 bytes
    const dayRows = await db.execute(sql`
      SELECT total_size::int AS total_size, item_count::int AS item_count
      FROM library_snapshots
      WHERE server_id = ${server.id}::uuid
        AND library_id = ${libraryId}
        AND snapshot_time::date = ${itemDay.toISOString().slice(0, 10)}::date
    `);
    expect(dayRows.rows).toHaveLength(1);
    expect(dayRows.rows[0]).toMatchObject({ total_size: 100, item_count: 1 });

    // Marker set exactly once, and a re-run is a no-op
    const marker = await getSetting('snapshotsNormalizedAt');
    expect(marker).not.toBeNull();
    const again = await processNormalizeLibrarySnapshotsJob(stubJob());
    expect(again.success).toBe(true);
    expect(again.message).toContain('already normalized');
    expect(await getSetting('snapshotsNormalizedAt')).toBe(marker);
  });

  it('does nothing before the version backfill has stamped', async () => {
    await setSetting('mediaVersionsBackfilledAt', null);
    await setSetting('snapshotsNormalizedAt', null);

    const result = await processNormalizeLibrarySnapshotsJob(stubJob());

    expect(result.success).toBe(true);
    expect(result.message).toContain('nothing to normalize');
    expect(await getSetting('snapshotsNormalizedAt')).toBeNull();
  });
});
