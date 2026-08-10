import type { Client } from 'pg';
import { REQUIRED_DB_NAME } from './env';

/**
 * Hard, fail-closed safety check: refuses to run any seed/reset statement
 * unless the connection is actually talking to tracearr_e2e. Protecting the
 * live dev database outranks convenience - this must throw, never warn.
 */
export async function assertSafeDatabase(client: Client): Promise<void> {
  const { rows } = await client.query<{ name: string }>('SELECT current_database() AS name');
  const name = rows[0]?.name;
  if (name !== REQUIRED_DB_NAME) {
    throw new Error(
      `Refusing to seed/reset database "${name}" - the e2e seed only ever runs against ` +
        `"${REQUIRED_DB_NAME}". Set E2E_DATABASE_URL to point at the isolated test database.`
    );
  }
}
