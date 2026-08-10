/**
 * Vitest globalSetup for integration tests.
 *
 * Runs once per suite run in the main vitest process, before any test file's
 * setupFiles execute. Builds (or reuses) a migrated template database, then
 * copies it into one database per worker so test files can run in parallel
 * without fighting over shared tables. DB 0 and the base `tracearr_test`
 * database stay reserved for legacy/serial use and other concurrent sessions.
 */

import { randomBytes, createHash } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    runToken: string;
  }
}

process.env.TEST_DATABASE_URL ||= 'postgresql://test:test@localhost:5433/tracearr_test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.REDIS_URL ||= 'redis://localhost:6380';

const WORKER_COUNT = 7;
const TEMPLATE_DB = 'tracearr_test_template';
const RUN_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ORPHAN_TOKEN_PATTERN = /^tracearr_test_r([a-z0-9]+)_w\d+$/;

function generateRunToken(): string {
  const bytes = randomBytes(6);
  return Array.from(bytes, (byte) => RUN_TOKEN_ALPHABET[byte % RUN_TOKEN_ALPHABET.length]).join('');
}

function workerDbName(runToken: string, workerId: number): string {
  return `tracearr_test_r${runToken}_w${workerId}`;
}

function dbUrl(baseUrl: string, dbName: string): string {
  return baseUrl.replace(/\/[^/]+$/, `/${dbName}`);
}

async function dropDatabase(client: pg.Client, dbName: string): Promise<void> {
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } catch (error) {
    console.error(
      `[Test Setup] Failed to drop database ${dbName}:`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * TimescaleDB background workers connect to every database with the extension
 * installed - including the template - at times we don't control, and a
 * just-closed pool's backend can still be draining server-side. Either one
 * makes CREATE DATABASE ... TEMPLATE fail with 55006 (object_in_use).
 */
async function terminateTemplateSessions(client: pg.Client): Promise<void> {
  await client.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEMPLATE_DB]
  );
}

async function createFromTemplate(client: pg.Client, name: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DB}"`);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== '55006' || attempt >= 5) throw error;
      await terminateTemplateSessions(client);
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

/**
 * Sweeps databases left behind by runs that crashed before their teardown ran.
 * A live run still holds its advisory lock, so pg_try_advisory_lock only
 * succeeds (and only then do we drop) for tokens with no active owner.
 */
async function sweepOrphanDatabases(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname LIKE 'tracearr_test_r%'"
  );

  const tokens = new Set<string>();
  for (const row of rows) {
    const token = ORPHAN_TOKEN_PATTERN.exec(row.datname)?.[1];
    if (token) tokens.add(token);
  }

  for (const token of tokens) {
    const { rows: lockRows } = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [`tracearr_run_${token}`]
    );
    if (!lockRows[0]?.acquired) continue;

    const orphanDbs = rows
      .map((row) => row.datname)
      .filter((name) => ORPHAN_TOKEN_PATTERN.exec(name)?.[1] === token);
    for (const dbName of orphanDbs) {
      await dropDatabase(client, dbName);
    }

    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`tracearr_run_${token}`]);
  }
}

function computeTemplateHash(migrationsFolder: string, schemaVersion: number): string {
  const files = readdirSync(migrationsFolder).sort();
  const parts = files.map((file) => {
    const { mtimeMs } = statSync(resolve(migrationsFolder, file));
    return `${file}:${mtimeMs}`;
  });
  return createHash('sha1')
    .update(`${parts.join('|')}:${schemaVersion}`)
    .digest('hex');
}

async function readTemplateHash(client: pg.Client): Promise<string | null> {
  const { rows } = await client.query<{ description: string | null }>(
    `SELECT description FROM pg_shdescription
     JOIN pg_database d ON objoid = d.oid
     WHERE d.datname = $1`,
    [TEMPLATE_DB]
  );
  return rows[0]?.description ?? null;
}

async function rebuildTemplate(
  client: pg.Client,
  migrationsFolder: string,
  baseUrl: string,
  hash: string
): Promise<void> {
  const { runMigrations, closeDatabase, recreatePool } = await import('../db/client.js');
  const { initTimescaleDB } = await import('../db/timescale.js');

  await terminateTemplateSessions(client);
  await client.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}"`);
  await client.query(`CREATE DATABASE "${TEMPLATE_DB}"`);

  const prevDatabaseUrl = process.env.DATABASE_URL;
  const prevTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_URL = dbUrl(baseUrl, TEMPLATE_DB);
  process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;

  try {
    // The pool binds DATABASE_URL at module import, so swapping the env alone
    // would leave migrations running against the previously bound database.
    await recreatePool();

    try {
      await runMigrations(migrationsFolder);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('already exists'))) {
        throw error;
      }
    }

    try {
      await initTimescaleDB();
    } catch (error) {
      if (process.env.DEBUG) {
        console.warn('[Test Setup] TimescaleDB init warning:', error);
      }
    }
  } finally {
    // Postgres refuses CREATE DATABASE ... TEMPLATE while any session,
    // including idle pool connections, is still connected to the source db.
    await closeDatabase();
    process.env.DATABASE_URL = prevDatabaseUrl;
    process.env.TEST_DATABASE_URL = prevTestDatabaseUrl;
  }

  // COMMENT ON DATABASE only accepts a string literal, not a bind parameter;
  // hash is a sha1 hex digest ([0-9a-f]{40}), so inlining it is safe.
  await client.query(`COMMENT ON DATABASE "${TEMPLATE_DB}" IS '${hash}'`);
}

async function ensureTemplate(
  client: pg.Client,
  migrationsFolder: string,
  baseUrl: string
): Promise<void> {
  const { AGGREGATE_SCHEMA_VERSION } = await import('../db/timescale.js');
  const hash = computeTemplateHash(migrationsFolder, AGGREGATE_SCHEMA_VERSION);

  if ((await readTemplateHash(client)) === hash) return;

  await client.query('SELECT pg_advisory_lock(hashtext($1))', ['tracearr_template_build']);
  try {
    // A concurrent run may have rebuilt the template while we waited for the lock.
    if ((await readTemplateHash(client)) === hash) return;
    await rebuildTemplate(client, migrationsFolder, baseUrl, hash);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['tracearr_template_build']);
  }
}

export default async function globalSetup(project: TestProject) {
  const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../db/migrations');
  const baseUrl = process.env.TEST_DATABASE_URL!;
  const runToken = generateRunToken();

  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();

  await client.query('SELECT pg_advisory_lock(hashtext($1))', [`tracearr_run_${runToken}`]);
  await sweepOrphanDatabases(client);
  await ensureTemplate(client, migrationsFolder, baseUrl);

  // Same trick template0 uses: a no-connections database stays copyable as a
  // template while nothing (Timescale bgws included) can attach to it. Runs
  // every time so templates built before this line gained it converge too.
  await client.query(`ALTER DATABASE "${TEMPLATE_DB}" WITH ALLOW_CONNECTIONS false`);

  for (let workerId = 1; workerId <= WORKER_COUNT; workerId++) {
    const name = workerDbName(runToken, workerId);
    await createFromTemplate(client, name);
  }

  // Inherited by forked pool workers; provide() is a belt-and-suspenders backup.
  process.env.TRACEARR_TEST_RUN_TOKEN = runToken;
  project.provide('runToken', runToken);

  return async () => {
    for (let workerId = 1; workerId <= WORKER_COUNT; workerId++) {
      await dropDatabase(client, workerDbName(runToken, workerId));
    }
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`tracearr_run_${runToken}`]);
    await client.end();
  };
}
