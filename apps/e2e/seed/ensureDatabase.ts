import pg from 'pg';
import { REQUIRED_DB_NAME, maintenanceDatabaseUrl } from './env';

/** Idempotent: creates tracearr_e2e on the test container if it doesn't
 * already exist yet (mirrors `docker exec ... psql -c 'CREATE DATABASE ...'`,
 * done here too so a fresh CI checkout doesn't need a manual step). */
export async function ensureDatabaseExists(): Promise<void> {
  const client = new pg.Client({ connectionString: maintenanceDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      REQUIRED_DB_NAME,
    ]);
    if (rows.length === 0) {
      // Database names can't be parameterized; REQUIRED_DB_NAME is a fixed
      // literal constant, never user input.
      await client.query(`CREATE DATABASE "${REQUIRED_DB_NAME}"`);
    }
  } finally {
    await client.end();
  }
}
