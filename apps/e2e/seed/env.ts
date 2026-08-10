/**
 * E2E database/redis targets. Defaults point at the isolated 5433 test
 * container (docker/docker-compose.test.yml), never the live dev stack on
 * 5432/6379 - overridable for CI via E2E_DATABASE_URL / E2E_REDIS_URL.
 */

export const REQUIRED_DB_NAME = 'tracearr_e2e';

export function e2eDatabaseUrl(): string {
  return (
    process.env.E2E_DATABASE_URL ?? `postgresql://test:test@localhost:5433/${REQUIRED_DB_NAME}`
  );
}

export function e2eRedisUrl(): string {
  return process.env.E2E_REDIS_URL ?? 'redis://localhost:6380';
}

export function e2eRedisPrefix(): string {
  return process.env.E2E_REDIS_PREFIX ?? 'trr_e2e_';
}

/**
 * Same host/credentials as the target URL, pointed at the "postgres" system
 * database - the only one guaranteed to exist regardless of the container's
 * POSTGRES_DB (tracearr_test locally, tracearr_e2e in CI).
 */
export function maintenanceDatabaseUrl(): string {
  return e2eDatabaseUrl().replace(/\/[^/]+$/, '/postgres');
}

export function databaseNameFromUrl(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1).split('?')[0] ?? '';
}
