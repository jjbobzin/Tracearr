/**
 * dropEmptySessionsChunks integration test.
 *
 * The cleanup pass locks each candidate chunk, rechecks emptiness, and drops
 * inside one transaction so rows inserted between the count and the drop can
 * never be deleted with the chunk. Proves the transactional path drops a
 * truly empty old chunk and leaves a populated one alone.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- maintenanceEmptyChunks
 */

import { describe, it, expect } from 'vitest';
import type { Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import {
  dropEmptySessionsChunks,
  type MaintenanceJobData,
} from '../../src/jobs/maintenanceQueue.js';

function stubJob(): Job<MaintenanceJobData> {
  return {
    id: 'test-cleanup-job',
    token: 'test-token',
    extendLock: async () => {},
  } as unknown as Job<MaintenanceJobData>;
}

async function oldSessionChunkCount(): Promise<number> {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS c
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'sessions'
      AND range_end < NOW() - INTERVAL '7 days'
  `);
  return (res.rows[0] as { c: number }).c;
}

describe('dropEmptySessionsChunks', () => {
  it('drops an empty old chunk and keeps a populated one', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const account = await createTestServerUser({ serverId: server.id, userId: user.id });

    // Chunks are epoch-aligned 30-day windows, so a session N days ago lands
    // in a chunk whose range_end can be as recent as N-30 days ago. Seeds at
    // 30/60 days made the first chunk's range_end dip inside the 7-day "old"
    // filter whenever "now" fell early in its own chunk window - a calendar
    // flake. 100/140 days keeps both range_ends >=70 days old on any date,
    // and 40 days of separation guarantees two distinct chunks.
    const emptied = await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      state: 'stopped',
      startedAt: new Date(Date.now() - 100 * 86_400_000),
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      state: 'stopped',
      startedAt: new Date(Date.now() - 140 * 86_400_000),
    });
    await db.execute(sql`DELETE FROM sessions WHERE id = ${emptied.id}`);

    const before = await oldSessionChunkCount();
    expect(before).toBeGreaterThanOrEqual(2);

    const result = await dropEmptySessionsChunks(stubJob());

    expect(result.errors).toBe(0);
    expect(result.dropped).toBeGreaterThanOrEqual(1);
    expect(await oldSessionChunkCount()).toBe(before - result.dropped);

    // The populated 140-day-old chunk survives with its row intact
    const kept = await db.execute(sql`
      SELECT COUNT(*)::int AS c FROM sessions
      WHERE started_at < NOW() - INTERVAL '120 days'
    `);
    expect((kept.rows[0] as { c: number }).c).toBe(1);
  });
});
