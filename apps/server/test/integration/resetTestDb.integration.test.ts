/**
 * resetTestDb must clear every table in the recursive FK closure of its root
 * list, including tables it never names directly (cleared via CASCADE) and
 * tables that can hold rows while every root table is empty (nullable FKs,
 * e.g. rule_action_results). A reset on an already-empty database must be a
 * no-op that leaves everything empty.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- resetTestDb
 */

import { describe, it, expect } from 'vitest';
import { createTestUser } from '@tracearr/test-utils/factories';
import { resetTestDb, executeRawSql } from '@tracearr/test-utils/db';

const ROOT_TABLES = [
  'violations',
  'notification_preferences',
  'notification_channel_routing',
  'mobile_sessions',
  'mobile_tokens',
  'sessions',
  'library_items',
  'media',
  'rules',
  'server_users',
  'servers',
  'users',
  'settings',
];

async function fkClosure(): Promise<string[]> {
  const rootList = ROOT_TABLES.map((t) => `'${t}'`).join(', ');
  const result = await executeRawSql(`
    WITH RECURSIVE fk_closure(oid) AS (
      SELECT c.oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN (${rootList})
      UNION
      SELECT con.conrelid
      FROM pg_constraint con
      JOIN fk_closure f ON con.confrelid = f.oid
      WHERE con.contype = 'f'
    )
    SELECT c.relname
    FROM fk_closure f
    JOIN pg_class c ON c.oid = f.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY c.relname
  `);
  return result.rows.map((row) => row.relname as string);
}

async function dirtyTables(tables: string[]): Promise<string[]> {
  const checks = tables
    .map((t) => `SELECT '${t}'::text AS tbl WHERE EXISTS (SELECT 1 FROM "${t}")`)
    .join(' UNION ALL ');
  const result = await executeRawSql(checks);
  return result.rows.map((row) => row.tbl as string);
}

describe('resetTestDb', () => {
  it('derives a closure that covers tables the root list never names', async () => {
    const closure = await fkClosure();

    expect(closure).toEqual(expect.arrayContaining(ROOT_TABLES));
    expect(closure).toContain('rule_action_results');
    expect(closure).toContain('library_snapshots');
    expect(closure).toContain('termination_logs');
    expect(closure).toContain('auth_accounts');
  });

  it('clears seeded root tables and cascade-only tables', async () => {
    const user = await createTestUser();
    await executeRawSql(`
      INSERT INTO plex_accounts (user_id, plex_account_id, plex_token)
      VALUES ('${user.id}', 'plex-reset-test', 'token-reset-test')
    `);

    expect(await dirtyTables(['users', 'plex_accounts'])).toEqual(['users', 'plex_accounts']);

    await resetTestDb();

    expect(await dirtyTables(await fkClosure())).toEqual([]);
  });

  it('clears closure-only tables even when every root table is empty', async () => {
    await executeRawSql(`
      INSERT INTO rule_action_results (action_type, success)
      VALUES ('terminate', true)
    `);

    expect(await dirtyTables(ROOT_TABLES)).toEqual([]);
    expect(await dirtyTables(['rule_action_results'])).toEqual(['rule_action_results']);

    await resetTestDb();

    expect(await dirtyTables(['rule_action_results'])).toEqual([]);
  });

  it('is a no-op on an empty database and leaves everything empty', async () => {
    const closure = await fkClosure();
    await resetTestDb();
    expect(await dirtyTables(closure)).toEqual([]);

    await resetTestDb();
    expect(await dirtyTables(closure)).toEqual([]);
  });
});
