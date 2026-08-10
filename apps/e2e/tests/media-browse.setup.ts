import { test as setup } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl } from '../seed/env';
import { assertSafeDatabase } from '../seed/guard';
import { ADMIN_SERVER_USER_ID, FIXTURE, SERVER_1_ID, fixtureId } from '../seed/fixtures';

/**
 * Phase 2 of the media-browse seed: runs after auth.setup.ts's real signup
 * has created the owner account (its id isn't known until then), so this is
 * the only place that can link a "watched by the signed-in admin" session -
 * everything else lives in seed/seedCore.ts and runs in Playwright's
 * globalSetup, before any browser touches the database.
 */
setup('link the signed-in owner to a watched title', async () => {
  const client = new pg.Client({ connectionString: e2eDatabaseUrl() });
  await client.connect();
  try {
    await assertSafeDatabase(client);

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'owner' ORDER BY created_at ASC LIMIT 1`
    );
    const ownerId = rows[0]?.id;
    if (!ownerId) {
      throw new Error('No owner account found - auth.setup.ts must run before this project');
    }

    await client.query(
      `INSERT INTO server_users (id, user_id, server_id, external_id, username)
       VALUES ($1, $2, $3, 'e2e-admin-ext', 'E2EOwner')
       ON CONFLICT (id) DO NOTHING`,
      [ADMIN_SERVER_USER_ID, ownerId, SERVER_1_ID]
    );

    // sessions is a TimescaleDB hypertable with no unique constraint on id
    // (see seed/seedCore.ts) - NOT EXISTS instead of ON CONFLICT.
    await client.query(
      `INSERT INTO sessions
         (id, server_id, server_user_id, session_key, state, media_type, media_title,
          media_id, started_at, last_seen_at, stopped_at, duration_ms, total_duration_ms,
          reference_id, watched, ip_address, rating_key)
       SELECT $1, $2, $3, 'e2e-session-watched-by-admin', 'stopped', 'movie', $4,
              $5, '2024-01-15T12:00:00Z'::timestamptz, '2024-01-15T12:00:00Z'::timestamptz,
              '2024-01-15T12:00:00Z'::timestamptz, 7200000, 7200000, NULL, true, '127.0.0.1',
              'watched-by-admin'
       WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = $1)`,
      [
        fixtureId('media-browse:session:watched-by-admin'),
        SERVER_1_ID,
        ADMIN_SERVER_USER_ID,
        FIXTURE.watchedByAdminTitle.title,
        FIXTURE.watchedByAdminTitle.id,
      ]
    );

    // WITH NO DATA at creation, so nothing surfaces from either phase's
    // session inserts until this runs at least once.
    await client.query(
      `CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
    );
  } finally {
    await client.end();
  }
});
