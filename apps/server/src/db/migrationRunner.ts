/**
 * Guarded migration runner for server boot.
 *
 * Runs drizzle migrations on a dedicated (non-pooled) connection, wrapped in
 * a blocking Postgres advisory lock and a short lock_timeout. This keeps two
 * things from happening on a multi-instance deploy: a second booting
 * instance racing DDL against the first (the advisory lock makes it wait
 * instead), and a migrator wedging boot forever behind a live writer's lock
 * (lock_timeout makes it fail fast so the caller's retry loop gets a turn).
 */

import type pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createRawPgClient } from './client.js';
import * as schema from './schema.js';
import { uncapDecompressionForSession } from './timescale.js';

/**
 * Advisory lock key for the migration runner. Distinct from
 * BACKFILL_ADVISORY_LOCK_KEY (875_100_001, see timescale.ts) - both are just
 * shared integers each side agrees on; changing either doesn't migrate or
 * reset anything, it just stops matching a lock already held under the old
 * key.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 875_100_002;

/** Only allow Postgres interval literals here - interpolated into SET, which doesn't take bind params. */
const INTERVAL_LITERAL_RE = /^[0-9]+(ms|s|min|h)?$/;

export interface RunMigrationsGuardedOptions {
  /** Session-level lock_timeout applied before migrations run. Default: '10s'. */
  lockTimeout?: string;
  /** Injectable for tests - avoids a real DB connection. */
  createClient?: () => pg.Client;
}

/**
 * Run pending migrations inside a dedicated session guarded by a blocking
 * advisory lock and a short lock_timeout. Throws on failure (bad SQL,
 * insufficient privilege, or a lock_timeout expiry when blocked behind a
 * live writer) - callers are expected to catch and retry rather than crash
 * the process.
 */
export async function runMigrationsGuarded(
  migrationsFolder: string,
  options: RunMigrationsGuardedOptions = {}
): Promise<void> {
  const { lockTimeout = '10s', createClient } = options;
  if (!INTERVAL_LITERAL_RE.test(lockTimeout)) {
    throw new Error(`Invalid lockTimeout value: ${lockTimeout}`);
  }

  const client = createClient ? createClient() : createRawPgClient('migrations');

  await client.connect();
  try {
    // lock_timeout is set BEFORE the advisory-lock request, and it stays in
    // effect for every statement after that too - both the wait for the
    // advisory lock itself and every DDL statement in the migration batch
    // drizzle then wraps in one transaction. A peer that is wedged (hung
    // migration, frozen container) while holding the advisory lock makes this
    // call error after lockTimeout instead of hanging boot forever, and the
    // same timeout aborts the whole batch - rolling back everything applied
    // so far - if any individual migration blocks more than lockTimeout
    // behind a live writer's row lock on a hot table. That's an intentional
    // fail-fast trade-off (the alternative is a queued ALTER stalling live
    // traffic for however long the writer holds its lock), and the caller's
    // retry loop is expected to pick the batch back up from the start.
    // Postgres also releases the advisory lock automatically if the holder's
    // connection closes, so a crashed instance can never wedge it.
    await client.query(`SET lock_timeout = '${lockTimeout}'`);
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      // Migrations are DDL, not long analytical scans, so unbounded is correct
      // here - but set it explicitly so a session default set elsewhere can
      // never silently cap a legitimately long migration.
      await client.query('SET statement_timeout = 0');

      // Historical migrations bulk-update compressed sessions chunks. The
      // runtime default caps decompression per DML transaction (the global
      // unlimited setting this replaced OOM-crashed postgres under routine
      // load), so only this dedicated migration session runs uncapped.
      await uncapDecompressionForSession(client);

      const migrationDb = drizzle(client, { schema });
      await migrate(migrationDb, { migrationsFolder });
    } finally {
      // A dead connection here (e.g. the migration failure itself dropped it) must not
      // mask the real error from migrate() with an unlock failure instead.
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY])
        .catch(() => {
          /* ignore cleanup errors */
        });
    }
  } finally {
    await client.end().catch(() => {
      /* ignore cleanup errors */
    });
  }
}
