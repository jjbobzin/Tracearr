import type { Client } from 'pg';
import { assertSafeDatabase } from './guard';
import {
  FIXTURE,
  OTHER_VIEWER_SERVER_USER_ID,
  OTHER_VIEWER_USER_ID,
  SERVER_1_ID,
  SERVER_2_ID,
  fillerMovies,
  fillerShows,
  fixtureId,
  matchKeyLocal,
  normalizeTitleLocal,
  sortTitleLocal,
  type FillerMovie,
  type FillerShow,
} from './fixtures';

const PAST = '2024-01-15T12:00:00Z';

interface LibraryCopy {
  serverId: string;
  ratingKey: string;
  resolution?: string | null;
  removedAt?: string | null;
  libraryId?: string;
  dynamicRange?: string | null;
  fileSizeGb?: number;
}

async function insertServer(client: Client, id: string, name: string, type: string, color: string) {
  await client.query(
    `INSERT INTO servers (id, name, type, url, token, color)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    // Port 1 is never listening - the background poller fails fast instead
    // of hanging on a real connection attempt against fixture data.
    [id, name, type, 'http://127.0.0.1:1', 'e2e-fixture-token', color]
  );
}

async function insertLibrary(
  client: Client,
  serverId: string,
  libraryId: string,
  name: string,
  mediaType: 'movie' | 'show'
) {
  const id = fixtureId(`media-browse:library:${serverId}:${libraryId}`);
  await client.query(
    `INSERT INTO libraries (id, server_id, library_id, name, media_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (server_id, library_id) DO UPDATE SET name = excluded.name, media_type = excluded.media_type`,
    [id, serverId, libraryId, name, mediaType]
  );
}

async function insertUser(client: Client, id: string, username: string, role: 'member' | 'owner') {
  await client.query(
    `INSERT INTO users (id, username, role) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [id, username, role]
  );
}

async function insertServerUser(
  client: Client,
  id: string,
  userId: string,
  serverId: string,
  externalId: string,
  username: string
) {
  await client.query(
    `INSERT INTO server_users (id, user_id, server_id, external_id, username)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [id, userId, serverId, externalId, username]
  );
}

async function insertMedia(
  client: Client,
  id: string,
  mediaType: 'movie' | 'show',
  title: string,
  year: number | null
) {
  const normalizedTitle = normalizeTitleLocal(title);
  const matchKey = matchKeyLocal(mediaType, title, year);
  // DO UPDATE for the same reason as insertLibraryItem below: sort_title
  // arrived after early seed runs, and a persistent database must converge.
  await client.query(
    `INSERT INTO media (id, media_type, match_key, title, normalized_title, year, sort_title)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       media_type = excluded.media_type,
       match_key = excluded.match_key,
       title = excluded.title,
       normalized_title = excluded.normalized_title,
       year = excluded.year,
       sort_title = excluded.sort_title`,
    [id, mediaType, matchKey, title, normalizedTitle, year, sortTitleLocal(title)]
  );
}

async function insertLibraryItem(
  client: Client,
  id: string,
  copy: LibraryCopy,
  mediaId: string,
  mediaType: 'movie' | 'show',
  title: string,
  year: number | null
) {
  const fileSizeBytes =
    copy.fileSizeGb !== undefined ? Math.round(copy.fileSizeGb * 1024 ** 3) : null;
  // DO UPDATE, not DO NOTHING: the fixture shape has grown new columns over
  // time (library_id, video_dynamic_range, file_size), and these ids are
  // deterministic - a persistent e2e database from an older seed run must
  // still converge to the current fixture values on rerun.
  await client.query(
    `INSERT INTO library_items
       (id, server_id, library_id, rating_key, title, media_type, year,
        video_resolution, media_id, created_at, removed_at, video_dynamic_range, file_size)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO UPDATE SET
       server_id = excluded.server_id,
       library_id = excluded.library_id,
       rating_key = excluded.rating_key,
       title = excluded.title,
       media_type = excluded.media_type,
       year = excluded.year,
       video_resolution = excluded.video_resolution,
       media_id = excluded.media_id,
       created_at = excluded.created_at,
       removed_at = excluded.removed_at,
       video_dynamic_range = excluded.video_dynamic_range,
       file_size = excluded.file_size`,
    [
      id,
      copy.serverId,
      copy.libraryId ?? 'e2e-library',
      copy.ratingKey,
      title,
      mediaType,
      year,
      copy.resolution ?? null,
      mediaId,
      PAST,
      copy.removedAt ?? null,
      copy.dynamicRange ?? null,
      fileSizeBytes,
    ]
  );

  if (mediaType !== 'show') {
    // A persistent e2e database picks up 'legacy:1' sentinels from the
    // versions migration for previously-seeded items; replace them with the
    // deterministic seed version so version-grain queries see one file per
    // copy, converging on rerun like the item upsert above.
    await client.query(
      `DELETE FROM library_item_versions WHERE library_item_id = $1 AND server_version_key = 'legacy:1'`,
      [id]
    );
    const versionId = fixtureId(`media-browse:version:${id}`);
    await client.query(
      `INSERT INTO library_item_versions
         (id, library_item_id, server_version_key, video_resolution, video_dynamic_range,
          file_size, removed_at)
       VALUES ($1, $2, 'v1', $3, $4, $5, $6)
       ON CONFLICT (library_item_id, server_version_key) DO UPDATE SET
         video_resolution = excluded.video_resolution,
         video_dynamic_range = excluded.video_dynamic_range,
         file_size = excluded.file_size,
         removed_at = excluded.removed_at`,
      [
        versionId,
        id,
        copy.resolution ?? null,
        copy.dynamicRange ?? null,
        fileSizeBytes,
        copy.removedAt ?? null,
      ]
    );
  }
}

async function insertMovie(
  client: Client,
  id: string,
  title: string,
  year: number | null,
  copies: LibraryCopy[]
) {
  await insertMedia(client, id, 'movie', title, year);
  for (const copy of copies) {
    const itemId = fixtureId(`media-browse:item:${id}:${copy.serverId}:${copy.ratingKey}`);
    await insertLibraryItem(client, itemId, copy, id, 'movie', title, year);
  }
}

async function insertShow(client: Client, id: string, title: string, year: number | null) {
  await insertMedia(client, id, 'show', title, year);
  const itemId = fixtureId(`media-browse:item:${id}:${SERVER_1_ID}:show`);
  await insertLibraryItem(
    client,
    itemId,
    { serverId: SERVER_1_ID, ratingKey: `${id}-show`, libraryId: 'e2e-library-shows' },
    id,
    'show',
    title,
    year
  );
}

async function insertSession(
  client: Client,
  id: string,
  serverId: string,
  serverUserId: string,
  mediaId: string,
  mediaTitle: string,
  watched: boolean
) {
  // sessions is a TimescaleDB hypertable - its primary key was dropped in
  // favor of time-partitioned indexes, so there is no unique constraint an
  // ON CONFLICT target could name. NOT EXISTS is the idempotent-insert shape
  // that works regardless.
  await client.query(
    `INSERT INTO sessions
       (id, server_id, server_user_id, session_key, state, media_type, media_title,
        media_id, started_at, last_seen_at, stopped_at, duration_ms, total_duration_ms,
        reference_id, watched, ip_address, rating_key)
     SELECT $1, $2, $3, $4, 'stopped', 'movie', $5, $6, $7::timestamptz, $7::timestamptz,
            $7::timestamptz, 7200000, 7200000, NULL, $8, '127.0.0.1', 'e2e-session'
     WHERE NOT EXISTS (SELECT 1 FROM sessions WHERE id = $1)`,
    [id, serverId, serverUserId, `e2e-session-${id}`, mediaTitle, mediaId, PAST, watched]
  );
}

async function seedFillerMovies(client: Client, movies: FillerMovie[]) {
  for (const movie of movies) {
    await insertMovie(client, movie.id, movie.title, movie.year, [
      {
        serverId: SERVER_1_ID,
        ratingKey: `filler-${movie.id}`,
        resolution: movie.resolution,
        libraryId: 'e2e-library-movies',
        fileSizeGb: movie.fileSizeGb,
      },
    ]);
  }
}

async function seedFillerShows(client: Client, shows: FillerShow[]) {
  for (const show of shows) {
    await insertShow(client, show.id, show.title, show.year);
  }
}

/**
 * Bulk fixture data safe to (re)run any number of times: two media servers,
 * one non-identity viewer, the named scenario titles from the task brief,
 * and ~80 filler titles to force real pagination. Everything the "watched by
 * the signed-in admin" scenario needs beyond the admin's own identity - that
 * link happens in media-browse.setup.ts, after the real owner account exists.
 */
/**
 * One snapshot per server+library, dated at the shared item created_at:
 * deriveLibraryStatus flags needsBackfill whenever a server's earliest item
 * predates its earliest snapshot (or it has none), and the Media overview
 * hides stats and shelves behind that flag. Aggregated from library_items so
 * fixture growth can't drift the counts.
 */
async function seedLibrarySnapshots(client: Client) {
  await client.query(
    `INSERT INTO library_snapshots
       (server_id, library_id, snapshot_time, item_count, total_size, movie_count, show_count)
     SELECT server_id, library_id, $1,
            count(*), coalesce(sum(file_size), 0),
            count(*) FILTER (WHERE media_type = 'movie'),
            count(*) FILTER (WHERE media_type = 'show')
     FROM library_items
     WHERE removed_at IS NULL AND server_id IN ($2, $3)
     GROUP BY server_id, library_id
     ON CONFLICT (server_id, library_id, snapshot_time) DO UPDATE SET
       item_count = excluded.item_count,
       total_size = excluded.total_size,
       movie_count = excluded.movie_count,
       show_count = excluded.show_count`,
    [PAST, SERVER_1_ID, SERVER_2_ID]
  );
}

export async function seedCore(client: Client): Promise<void> {
  await assertSafeDatabase(client);

  await client.query('BEGIN');
  try {
    await insertServer(client, SERVER_1_ID, 'E2E Plex', 'plex', '#e5a00d');
    await insertServer(client, SERVER_2_ID, 'E2E Jellyfin', 'jellyfin', '#00a4dc');

    // Only the filler titles below carry these library ids - the named
    // fixture titles stay on the unmapped 'e2e-library' id so the media
    // detail page's "Unknown library" fallback keeps covering that case.
    await insertLibrary(client, SERVER_1_ID, 'e2e-library-movies', 'Feature Films', 'movie');
    await insertLibrary(client, SERVER_1_ID, 'e2e-library-shows', 'TV Library', 'show');

    await insertUser(client, OTHER_VIEWER_USER_ID, 'e2e-other-viewer', 'member');
    await insertServerUser(
      client,
      OTHER_VIEWER_SERVER_USER_ID,
      OTHER_VIEWER_USER_ID,
      SERVER_1_ID,
      'e2e-other-viewer-ext',
      'OtherViewer'
    );

    const f = FIXTURE;
    // The only two HDR-tagged titles in the seed - a deterministic pair for
    // the HDR-only filter test. Every other item is NULL/'sdr'.
    await insertMovie(client, f.articleTitle.id, f.articleTitle.title, f.articleTitle.year, [
      { serverId: SERVER_1_ID, ratingKey: 'the-matrix', dynamicRange: 'dolby vision' },
    ]);
    await insertMovie(client, f.digitTitle.id, f.digitTitle.title, f.digitTitle.year, [
      { serverId: SERVER_1_ID, ratingKey: '12-monkeys', dynamicRange: 'hdr10' },
    ]);
    await insertMovie(client, f.twoCopyTitle.id, f.twoCopyTitle.title, f.twoCopyTitle.year, [
      { serverId: SERVER_1_ID, ratingKey: 'duplicate-signal-4k', resolution: '4k' },
      { serverId: SERVER_1_ID, ratingKey: 'duplicate-signal-1080p', resolution: '1080p' },
    ]);
    await insertMovie(
      client,
      f.crossServerTitle.id,
      f.crossServerTitle.title,
      f.crossServerTitle.year,
      [
        { serverId: SERVER_1_ID, ratingKey: 'shared-frontier-s1' },
        { serverId: SERVER_2_ID, ratingKey: 'shared-frontier-s2' },
      ]
    );
    await insertMovie(
      client,
      f.removedEverywhereTitle.id,
      f.removedEverywhereTitle.title,
      f.removedEverywhereTitle.year,
      [
        { serverId: SERVER_1_ID, ratingKey: 'ghost-protocol-s1', removedAt: PAST },
        { serverId: SERVER_2_ID, ratingKey: 'ghost-protocol-s2', removedAt: PAST },
      ]
    );
    await insertMovie(
      client,
      f.watchedByOtherTitle.id,
      f.watchedByOtherTitle.title,
      f.watchedByOtherTitle.year,
      [{ serverId: SERVER_1_ID, ratingKey: 'watched-by-someone' }]
    );
    await insertMovie(
      client,
      f.watchedByAdminTitle.id,
      f.watchedByAdminTitle.title,
      f.watchedByAdminTitle.year,
      [{ serverId: SERVER_1_ID, ratingKey: 'watched-by-admin' }]
    );
    await insertMovie(
      client,
      f.pageTwoMarkerTitle.id,
      f.pageTwoMarkerTitle.title,
      f.pageTwoMarkerTitle.year,
      [{ serverId: SERVER_1_ID, ratingKey: 'zulu-sentinel-marker' }]
    );

    await insertSession(
      client,
      fixtureId('media-browse:session:watched-by-other'),
      SERVER_1_ID,
      OTHER_VIEWER_SERVER_USER_ID,
      f.watchedByOtherTitle.id,
      f.watchedByOtherTitle.title,
      true
    );

    await seedFillerMovies(client, fillerMovies());
    await seedFillerShows(client, fillerShows());
    await seedLibrarySnapshots(client);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
