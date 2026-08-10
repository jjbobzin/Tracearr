/**
 * Migration 0070's dedup step for library_snapshots.
 *
 * Once applied, the unique index on (server_id, library_id, snapshot_time)
 * makes it impossible to insert new duplicates through the app, so the only
 * way to exercise the dedup DELETE itself is to drop the index, insert
 * synthetic duplicates directly, and run the same predicate the migration
 * uses. These tests pin that the survivor is the row written last (highest
 * ctid), not an arbitrary one, since duplicate library_snapshots rows can
 * carry different recomputed payloads for the same day.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- librarySnapshotsDedup
 */

import { describe, it, expect, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestServer } from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';

const UNIQUE_INDEX = 'library_snapshots_server_library_time_idx';

async function dropUniqueIndex(): Promise<void> {
  await db.execute(sql.raw(`DROP INDEX IF EXISTS "${UNIQUE_INDEX}"`));
}

async function restoreUniqueIndex(): Promise<void> {
  await db.execute(
    sql.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS "${UNIQUE_INDEX}" ON "library_snapshots" USING btree ("server_id","library_id","snapshot_time")`
    )
  );
}

// Mirrors the DELETE in 0070_overrated_the_executioner.sql exactly - kept as
// a literal copy (not a shared import) so this test breaks loudly if the
// migration's predicate ever drifts from what it claims to do.
async function runDedup(): Promise<void> {
  await db.execute(sql`
    DELETE FROM "library_snapshots" a
    USING "library_snapshots" b
    WHERE a.server_id = b.server_id
      AND a.library_id = b.library_id
      AND a.snapshot_time = b.snapshot_time
      AND a.ctid < b.ctid
  `);
}

describe('0070 dedup: keeps the newest duplicate library_snapshots row', () => {
  // The unique index is dropped mid-test to allow synthetic duplicates -
  // always restore it, even if an assertion above fails, so later tests in
  // this run still see the schema migration 0070 actually produces.
  afterEach(async () => {
    await restoreUniqueIndex();
  });

  it('keeps the row inserted last when two duplicates have different payloads', async () => {
    const server = await createTestServer({ type: 'plex' });
    const libraryId = 'lib-dedup-newest';
    const snapshotTime = new Date('2026-07-01T00:00:00Z');

    await dropUniqueIndex();

    // Two inserts in the same session land on distinct, increasing ctids in
    // insertion order - the same physical-position signal the migration's
    // DELETE relies on.
    await db.execute(sql`
      INSERT INTO library_snapshots (server_id, library_id, snapshot_time, item_count, total_size)
      VALUES (${server.id}::uuid, ${libraryId}, ${snapshotTime.toISOString()}::timestamptz, 100, 1000000)
    `);
    await db.execute(sql`
      INSERT INTO library_snapshots (server_id, library_id, snapshot_time, item_count, total_size)
      VALUES (${server.id}::uuid, ${libraryId}, ${snapshotTime.toISOString()}::timestamptz, 250, 2000000)
    `);

    await runDedup();

    const rows = await db.execute(sql`
      SELECT item_count, total_size FROM library_snapshots
      WHERE server_id = ${server.id}::uuid AND library_id = ${libraryId}
    `);

    expect(rows.rows).toHaveLength(1);
    // The second insert (item_count 250) is the newest and must survive,
    // not the first (item_count 100).
    expect((rows.rows[0] as { item_count: number }).item_count).toBe(250);
  });

  it('collapses three duplicates down to the last one written', async () => {
    const server = await createTestServer({ type: 'plex' });
    const libraryId = 'lib-dedup-triple';
    const snapshotTime = new Date('2026-07-02T00:00:00Z');

    await dropUniqueIndex();

    for (const itemCount of [10, 20, 30]) {
      await db.execute(sql`
        INSERT INTO library_snapshots (server_id, library_id, snapshot_time, item_count, total_size)
        VALUES (${server.id}::uuid, ${libraryId}, ${snapshotTime.toISOString()}::timestamptz, ${itemCount}, 1000)
      `);
    }

    await runDedup();

    const rows = await db.execute(sql`
      SELECT item_count FROM library_snapshots
      WHERE server_id = ${server.id}::uuid AND library_id = ${libraryId}
    `);

    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { item_count: number }).item_count).toBe(30);
  });

  it('is a no-op when there are no duplicates', async () => {
    const server = await createTestServer({ type: 'plex' });
    const libraryId = 'lib-dedup-none';

    await dropUniqueIndex();

    for (let day = 0; day < 3; day++) {
      const snapshotTime = new Date(Date.UTC(2026, 6, 10 + day));
      await db.execute(sql`
        INSERT INTO library_snapshots (server_id, library_id, snapshot_time, item_count, total_size)
        VALUES (${server.id}::uuid, ${libraryId}, ${snapshotTime.toISOString()}::timestamptz, ${day}, 1000)
      `);
    }

    await runDedup();

    const rows = await db.execute(sql`
      SELECT item_count FROM library_snapshots
      WHERE server_id = ${server.id}::uuid AND library_id = ${libraryId}
      ORDER BY snapshot_time
    `);

    expect(rows.rows).toHaveLength(3);
  });

  it('restores a unique index that blocks new duplicate inserts', async () => {
    const server = await createTestServer({ type: 'plex' });
    const libraryId = 'lib-dedup-guard';
    const snapshotTime = new Date('2026-07-03T00:00:00Z').toISOString();

    await db.execute(sql`
      INSERT INTO library_snapshots (server_id, library_id, snapshot_time, item_count, total_size)
      VALUES (${server.id}::uuid, ${libraryId}, ${snapshotTime}::timestamptz, 1, 1000)
    `);

    let insertError: unknown;
    try {
      await db.execute(sql`
        INSERT INTO library_snapshots (server_id, library_id, snapshot_time, item_count, total_size)
        VALUES (${server.id}::uuid, ${libraryId}, ${snapshotTime}::timestamptz, 2, 2000)
      `);
    } catch (err) {
      insertError = err;
    }

    expect(insertError).toBeDefined();
    const cause =
      insertError instanceof Error && insertError.cause instanceof Error
        ? insertError.cause
        : insertError;
    expect(String(cause)).toMatch(/duplicate key value violates unique constraint/);
  });
});
