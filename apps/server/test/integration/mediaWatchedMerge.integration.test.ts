/**
 * Merge-aware watched-state integration coverage.
 *
 * resolveWatchedStates aliases a canonical media id to its merged losers via
 * a single-hop alias map, since historical session/cagg rows keep whichever
 * id was canonical at record time. This pins that behavior end to end
 * (through the real probe queries, not just the pure mapper) so a future
 * probe-query rewrite cannot silently drop the merged-loser plays:
 * - a merged show's episode count spans both the winner's and loser's
 *   episodes, even when they were watched on different servers.
 * - a merged movie's plays make the canonical id watched even though the
 *   watched session was recorded against the loser's id.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- mediaWatchedMerge
 */

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import {
  resolveMediaForItem,
  mergeMediaRows,
} from '../../src/services/library/mediaResolutionService.js';
import { resolveWatchedStates } from '../../src/services/library/mediaWatchedService.js';

async function refreshPlaysAggregate(): Promise<void> {
  await db.execute(
    sql`CALL refresh_continuous_aggregate('user_media_plays_daily'::regclass, NULL, NULL)`
  );
}

describe('resolveWatchedStates across a media merge', () => {
  it('counts distinct watched episodes across a merged show and its loser, watched on different servers', async () => {
    const serverA = await createTestServer({ type: 'plex' });
    const serverB = await createTestServer({ type: 'jellyfin' });
    const userA = await createTestUser({ role: 'member' });
    const userB = await createTestUser({ role: 'member' });
    const accountA = await createTestServerUser({ userId: userA.id, serverId: serverA.id });
    const accountB = await createTestServerUser({ userId: userB.id, serverId: serverB.id });

    const showWinnerId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 500001,
      title: 'Merge Show Winner',
      year: 2020,
      serverId: serverA.id,
      ratingKey: 'show-winner',
    });
    const showLoserId = await resolveMediaForItem({
      mediaType: 'show',
      tvdbId: 500002,
      title: 'Merge Show Loser',
      year: 2020,
      serverId: serverB.id,
      ratingKey: 'show-loser',
    });

    const episodeWinnerId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 500011,
      title: 'Winner Episode',
      year: 2020,
      serverId: serverA.id,
      ratingKey: 'ep-winner',
      showMediaId: showWinnerId,
    });
    const episodeLoserId = await resolveMediaForItem({
      mediaType: 'episode',
      tvdbId: 500012,
      title: 'Loser Episode',
      year: 2020,
      serverId: serverB.id,
      ratingKey: 'ep-loser',
      showMediaId: showLoserId,
    });

    // eps_watched only counts plays for episodes that still have a live
    // library_items row (see fetchShowWatchedRows' EXISTS clause), matching
    // fetchEpisodeCounts' denominator, so both episodes need one here.
    await createTestLibraryItem({
      serverId: serverA.id,
      ratingKey: 'ep-winner',
      mediaType: 'episode',
      mediaId: episodeWinnerId,
    });
    await createTestLibraryItem({
      serverId: serverB.id,
      ratingKey: 'ep-loser',
      mediaType: 'episode',
      mediaId: episodeLoserId,
    });

    await createTestSession({
      serverId: serverA.id,
      serverUserId: accountA.id,
      mediaType: 'episode',
      mediaId: episodeWinnerId,
      showMediaId: showWinnerId,
      ratingKey: 'ep-winner',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });
    await createTestSession({
      serverId: serverB.id,
      serverUserId: accountB.id,
      mediaType: 'episode',
      mediaId: episodeLoserId,
      showMediaId: showLoserId,
      ratingKey: 'ep-loser',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });

    // Merges the loser show into the winner. Historical sessions above keep
    // recording show_media_id = showLoserId, so this is the exact scenario
    // the alias map exists to cover.
    await mergeMediaRows(showWinnerId, showLoserId);

    await refreshPlaysAggregate();

    const result = await resolveWatchedStates({
      movieIds: [],
      showIds: [showWinnerId],
      serverIds: undefined,
      lensUserId: null,
      episodeCounts: new Map([[showWinnerId, 2]]),
    });

    expect(result.get(showWinnerId)).toBe('watched');
  });

  it('marks a merged movie watched when the watched play was recorded against the loser id', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser({ role: 'member' });
    const account = await createTestServerUser({ userId: user.id, serverId: server.id });

    const movieWinnerId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 600001,
      title: 'Merge Movie Winner',
      year: 2021,
      serverId: server.id,
      ratingKey: 'movie-winner',
    });
    const movieLoserId = await resolveMediaForItem({
      mediaType: 'movie',
      tmdbId: 600002,
      title: 'Merge Movie Loser',
      year: 2021,
      serverId: server.id,
      ratingKey: 'movie-loser',
    });

    await createTestSession({
      serverId: server.id,
      serverUserId: account.id,
      mediaType: 'movie',
      mediaId: movieLoserId,
      ratingKey: 'movie-loser',
      durationMs: 1_800_000,
      totalDurationMs: 1_800_000,
      referenceId: null,
      watched: true,
    });

    await mergeMediaRows(movieWinnerId, movieLoserId);

    await refreshPlaysAggregate();

    const result = await resolveWatchedStates({
      movieIds: [movieWinnerId],
      showIds: [],
      serverIds: undefined,
      lensUserId: null,
      episodeCounts: new Map(),
    });

    expect(result.get(movieWinnerId)).toBe('watched');
  });
});
