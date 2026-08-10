/**
 * One-time data repair migration (0071_link_episodes_to_shows), for the
 * librarySync bug where episode->show resolution only ever consulted the
 * in-batch show map, leaving media.show_media_id (and the sessions copy)
 * permanently null for every episode synced before the fix.
 *
 * The suite's test database is already migrated, so this re-executes the
 * migration file's SQL against manually-seeded broken data (mirrors
 * loginUsernameCollision.integration.test.ts) rather than relying on the
 * DDL-time run against an empty table.
 *
 * Run with: pnpm test:integration -- linkEpisodesToShows
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { readFileSync } from 'fs';
import { db } from '../client.js';
import { media, sessions } from '../schema.js';
import { resetTestDb } from '@tracearr/test-utils/db';
import {
  createTestServer,
  createTestLibraryItem,
  createTestUser,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { resolveMediaForItem } from '../../services/library/mediaResolutionService.js';

function repairMigrationSql(): string {
  return readFileSync(
    `${import.meta.dirname}/../migrations/0071_link_episodes_to_shows.sql`,
    'utf8'
  );
}

async function runRepairMigration(): Promise<void> {
  // Mirrors how drizzle applies a --breakpoints file: split on the
  // statement-breakpoint marker and run each statement in turn.
  const statements = repairMigrationSql()
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

describe('0071_link_episodes_to_shows repair migration', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it('backfills media.show_media_id and the sessions copy for episodes left null by the sync bug', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ userId: user.id, serverId: server.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 555001,
      title: 'Hacks',
      year: 2021,
      serverId: server.id,
      ratingKey: 'show-hacks',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'show-hacks',
      mediaType: 'show',
      mediaId: showId,
    });

    // Episode media row resolved without showMediaId - reproduces the
    // pre-fix bug's persisted state.
    const epId = await resolveMediaForItem({
      mediaType: 'episode',
      title: 'Bulletproof',
      year: null,
      serverId: server.id,
      ratingKey: 'ep-hacks-1',
      seasonNumber: 3,
      episodeNumber: 1,
      grandparentRatingKey: 'show-hacks',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep-hacks-1',
      mediaType: 'episode',
      mediaId: epId,
      grandparentRatingKey: 'show-hacks',
    });
    const session = await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: epId,
      mediaType: 'episode',
      ratingKey: 'ep-hacks-1',
      grandparentRatingKey: 'show-hacks',
      showMediaId: null,
      durationMs: 1_800_000,
    });

    // RED: pre-migration state is exactly the reported bug.
    const [epBefore] = await db.select().from(media).where(eq(media.id, epId));
    expect(epBefore!.showMediaId).toBeNull();
    const [sessionBefore] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(sessionBefore!.showMediaId).toBeNull();

    await runRepairMigration();

    const [epAfter] = await db.select().from(media).where(eq(media.id, epId));
    expect(epAfter!.showMediaId).toBe(showId);
    const [sessionAfter] = await db.select().from(sessions).where(eq(sessions.id, session.id));
    expect(sessionAfter!.showMediaId).toBe(showId);
  });

  it('is safe to run twice: second run is a no-op that leaves the repaired rows untouched', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ userId: user.id, serverId: server.id });

    const showId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 555002,
      title: 'Severance',
      year: 2022,
      serverId: server.id,
      ratingKey: 'show-sev',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'show-sev',
      mediaType: 'show',
      mediaId: showId,
    });
    const epId = await resolveMediaForItem({
      mediaType: 'episode',
      title: 'Good News About Hell',
      year: null,
      serverId: server.id,
      ratingKey: 'ep-sev-1',
      seasonNumber: 1,
      episodeNumber: 1,
      grandparentRatingKey: 'show-sev',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep-sev-1',
      mediaType: 'episode',
      mediaId: epId,
      grandparentRatingKey: 'show-sev',
    });
    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaId: epId,
      mediaType: 'episode',
      ratingKey: 'ep-sev-1',
      grandparentRatingKey: 'show-sev',
      showMediaId: null,
      durationMs: 1_800_000,
    });

    await runRepairMigration();
    await runRepairMigration();

    const [epAfter] = await db.select().from(media).where(eq(media.id, epId));
    expect(epAfter!.showMediaId).toBe(showId);
    const rows = await db.select().from(media).where(eq(media.id, epId));
    expect(rows).toHaveLength(1);
  });

  it('does not touch an episode whose show has not synced yet', async () => {
    const server = await createTestServer({ type: 'plex' });
    const epId = await resolveMediaForItem({
      mediaType: 'episode',
      title: 'Orphan',
      year: null,
      serverId: server.id,
      ratingKey: 'ep-orphan-1',
      seasonNumber: 1,
      episodeNumber: 1,
      grandparentRatingKey: 'show-never-synced',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: 'ep-orphan-1',
      mediaType: 'episode',
      mediaId: epId,
      grandparentRatingKey: 'show-never-synced',
    });

    await runRepairMigration();

    const [epAfter] = await db.select().from(media).where(eq(media.id, epId));
    expect(epAfter!.showMediaId).toBeNull();
  });
});
