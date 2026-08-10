import { describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';

describe('worker database isolation', () => {
  it('runs against a run-scoped worker database', async () => {
    const { rows } = await db.execute(sql`SELECT current_database() AS name`);
    expect(String(rows[0]!.name)).toMatch(/^tracearr_test_r[a-z0-9]+_w\d+$/);
  });
  it('uses a nonzero redis db index', () => {
    expect(process.env.REDIS_URL).toMatch(/\/([1-9]|[12]\d|3[01])$/);
  });
});
