import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { databaseNameFromUrl, REQUIRED_DB_NAME } from './env';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Applies the server's own drizzle migrations against the e2e database via
 * its own `db:migrate` script - never hand-rolled SQL, so the schema this
 * seed writes into is exactly what the app itself would produce.
 */
export function runMigrations(databaseUrl: string): void {
  if (databaseNameFromUrl(databaseUrl) !== REQUIRED_DB_NAME) {
    throw new Error(`Refusing to migrate a database that isn't "${REQUIRED_DB_NAME}"`);
  }
  const result = spawnSync('pnpm', ['--filter', '@tracearr/server', 'db:migrate'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Migration against ${REQUIRED_DB_NAME} failed (exit ${result.status})`);
  }
}
