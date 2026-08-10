/**
 * Identity backfill against a genuinely compressed sessions chunk, with the
 * decompression cap lowered beneath what the batch needs. A busy chunk
 * decompresses more tuples than the default cap even for a modest batch;
 * without the batch lifting the cap via SET LOCAL, the walk fail-retries
 * forever. The chunk window is the memory guard, not the cap.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- identityBackfillCompressed
 */

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { db, recreatePool } from '../../src/db/client.js';
import { media } from '../../src/db/schema.js';
import { backfillSessionIdentityBatch } from '../../src/jobs/sessionIdentityBackfill.js';

const SESSIONS = 50;
const CHUNK_AGE_DAYS = 120;

describe('identity backfill on a compressed chunk', () => {
  it(
    'stamps through a compressed chunk with the decompression cap far below the batch',
    { timeout: 120_000 },
    async () => {
      const server = await createTestServer({ type: 'plex' });
      const user = await createTestUser();
      const account = await createTestServerUser({ serverId: server.id, userId: user.id });

      const [mediaRow] = await db
        .insert(media)
        .values({
          mediaType: 'movie',
          matchKey: `movie:compressed:${server.id}`,
          title: 'Compressed Backfill Movie',
          normalizedTitle: 'compressed backfill movie',
          year: 2020,
        })
        .returning({ id: media.id });
      await createTestLibraryItem({
        serverId: server.id,
        ratingKey: 'rk-compressed',
        mediaId: mediaRow!.id,
        fileSize: 1000,
      });

      const startedAt = new Date(Date.now() - CHUNK_AGE_DAYS * 86_400_000);
      for (let i = 0; i < SESSIONS; i++) {
        await createTestSession({
          serverId: server.id,
          serverUserId: account.id,
          state: 'stopped',
          ratingKey: 'rk-compressed',
          startedAt: new Date(startedAt.getTime() + i * 60_000),
        });
      }
      await db.execute(sql`
      UPDATE sessions SET media_id = NULL
      WHERE server_id = ${server.id}::uuid AND rating_key = 'rk-compressed'
    `);

      const compressed = await db.execute(sql`
      SELECT compress_chunk(c, true) FROM show_chunks(
        'sessions',
        older_than => NOW() - INTERVAL '${sql.raw(String(CHUNK_AGE_DAYS - 30))} days'
      ) AS c
    `);
      expect(compressed.rows.length).toBeGreaterThanOrEqual(1);

      // New connections inherit the database-level cap; without the batch's
      // SET LOCAL this makes the UPDATE trip the decompression limit
      const dbName = (
        (await db.execute(sql`SELECT current_database() AS db`)).rows[0] as { db: string }
      ).db;
      await db.execute(
        sql.raw(
          `ALTER DATABASE "${dbName}" SET timescaledb.max_tuples_decompressed_per_dml_transaction = 10`
        )
      );
      await recreatePool();
      try {
        const result = await backfillSessionIdentityBatch(1000, {
          end: new Date(Date.now() - (CHUNK_AGE_DAYS - 60) * 86_400_000),
        });
        expect(result.updated).toBe(SESSIONS);

        const stamped = await db.execute(sql`
        SELECT COUNT(*)::int AS c FROM sessions
        WHERE server_id = ${server.id}::uuid AND rating_key = 'rk-compressed'
          AND media_id = ${mediaRow!.id}::uuid
      `);
        expect((stamped.rows[0] as { c: number }).c).toBe(SESSIONS);
      } finally {
        await db.execute(
          sql.raw(
            `ALTER DATABASE "${dbName}" RESET timescaledb.max_tuples_decompressed_per_dml_transaction`
          )
        );
        await recreatePool();
      }
    }
  );
});
