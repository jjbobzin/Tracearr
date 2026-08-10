import { sql, type SQL } from 'drizzle-orm';
import type { WatchedState } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { buildMultiServerFragment } from '../../utils/serverFiltering.js';

export interface WatchedProbeArgs {
  /** Canonical movie media ids, page-batched (caller keeps <=100). */
  movieIds: string[];
  /** Canonical show media ids. */
  showIds: string[];
  /** Resolved server scope; undefined means owner/all. */
  serverIds: string[] | undefined;
  /** Identity user id to scope by; null means aggregate across all users. */
  lensUserId: string | null;
  /** showId -> known episode count, supplied by the caller. */
  episodeCounts: Map<string, number>;
}

interface MovieWatchedRow {
  canonical_id: string;
  watched: boolean;
  has_plays: boolean;
}

interface ShowWatchedRow {
  canonical_id: string;
  eps_watched: number;
  has_plays: boolean;
}

/**
 * Single-hop alias map: for each canonical id, includes itself plus any media
 * row whose merged_into_id points to it (merged_into_id is already path-compressed
 * to a single hop, so no recursion is needed here).
 *
 * Builds the id list via ARRAY[...] rather than interpolating `ids` directly as
 * `${ids}::uuid[]`: drizzle's sql template expands a plain JS array into a
 * comma-separated param list (a row constructor), which `::uuid[]` cannot cast.
 */
export function buildAliasMapCte(ids: string[]): SQL {
  const idList = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  return sql`WITH alias_map AS (
    SELECT id AS canonical_id, id AS any_id FROM unnest(ARRAY[${idList}]::uuid[]) AS t(id)
    UNION ALL
    SELECT m.merged_into_id, m.id FROM media m WHERE m.merged_into_id = ANY(ARRAY[${idList}]::uuid[])
  )`;
}

/** Movie matrix: watched wins, otherwise any recorded plays make it partial. */
export function mapMovieWatchedRows(
  movieIds: string[],
  rows: MovieWatchedRow[]
): Map<string, WatchedState> {
  const byId = new Map(rows.map((row) => [row.canonical_id, row]));
  const result = new Map<string, WatchedState>();
  for (const id of movieIds) {
    const row = byId.get(id);
    if (!row) {
      result.set(id, 'unwatched');
    } else if (row.watched) {
      result.set(id, 'watched');
    } else if (row.has_plays) {
      result.set(id, 'partial');
    } else {
      result.set(id, 'unwatched');
    }
  }
  return result;
}

/**
 * Show matrix: an unknown or zero episode count can never resolve to watched/partial,
 * since there's nothing to compare eps_watched against.
 */
export function mapShowWatchedRows(
  showIds: string[],
  rows: ShowWatchedRow[],
  episodeCounts: Map<string, number>
): Map<string, WatchedState> {
  const byId = new Map(rows.map((row) => [row.canonical_id, row]));
  const result = new Map<string, WatchedState>();
  for (const id of showIds) {
    const known = episodeCounts.get(id);
    if (!known) {
      result.set(id, 'unwatched');
      continue;
    }
    const row = byId.get(id);
    const epsWatched = row?.eps_watched ?? 0;
    const hasPlays = row?.has_plays ?? false;
    if (epsWatched >= known) {
      result.set(id, 'watched');
    } else if (epsWatched > 0 || hasPlays) {
      result.set(id, 'partial');
    } else {
      result.set(id, 'unwatched');
    }
  }
  return result;
}

async function fetchMovieWatchedRows(
  movieIds: string[],
  serverIds: string[] | undefined,
  lensUserId: string | null
): Promise<MovieWatchedRow[]> {
  const aliasCte = buildAliasMapCte(movieIds);
  // Bare interpolation: buildMultiServerFragment already returns '' (owner/all)
  // or a leading 'AND ...' fragment; wrapping it in parens breaks the query.
  const serverFragment = buildMultiServerFragment(serverIds, 'p.server_id');
  // A direct JOIN from alias_map to the cagg (a materialized_only=false view)
  // makes the planner seq-scan the whole cagg instead of probing
  // idx_user_media_plays_media_user per alias row. CROSS JOIN LATERAL with
  // OFFSET 0 blocks the planner from flattening the subquery back into that
  // same join, which is what actually forces the index scan (bare JOIN and
  // LATERAL without OFFSET 0 both flatten to the same seq-scanning plan).
  const result = await db.execute(sql`
    ${aliasCte}
    SELECT a.canonical_id,
           BOOL_OR(p.any_watched) AS watched,
           COALESCE(SUM(p.plays), 0) > 0 AS has_plays
    FROM alias_map a
    CROSS JOIN LATERAL (
      SELECT p2.any_watched, p2.plays, p2.server_user_id, p2.server_id
      FROM user_media_plays_daily p2
      WHERE p2.media_id = a.any_id
      OFFSET 0
    ) p
    JOIN server_users su ON su.id = p.server_user_id
    WHERE (${lensUserId}::uuid IS NULL OR su.user_id = ${lensUserId}) ${serverFragment}
    GROUP BY a.canonical_id
  `);
  return result.rows as unknown as MovieWatchedRow[];
}

async function fetchShowWatchedRows(
  showIds: string[],
  serverIds: string[] | undefined,
  lensUserId: string | null
): Promise<ShowWatchedRow[]> {
  const aliasCte = buildAliasMapCte(showIds);
  const serverFragment = buildMultiServerFragment(serverIds, 'p.server_id');
  const serverFragmentLi = buildMultiServerFragment(serverIds, 'li.server_id');
  // Same LATERAL/OFFSET 0 shape as the movie probe, keyed on show_media_id.
  // eps_watched stays a single COUNT(DISTINCT) over every alias row's plays
  // rather than a per-any_id count summed afterward, since a per-any_id sum
  // would double count if an episode's media_id ever showed up under both
  // the winner and loser show ids (episode rows aren't aliased themselves).
  const result = await db.execute(sql`
    ${aliasCte}
    SELECT a.canonical_id,
           COUNT(DISTINCT p.media_id) FILTER (
             WHERE p.any_watched
               AND EXISTS (
                 SELECT 1 FROM library_items li
                 WHERE li.media_id = p.media_id AND li.removed_at IS NULL ${serverFragmentLi}
               )
           )::int AS eps_watched,
           COALESCE(SUM(p.plays), 0) > 0 AS has_plays
    FROM alias_map a
    CROSS JOIN LATERAL (
      SELECT p2.media_id, p2.any_watched, p2.plays, p2.server_user_id, p2.server_id
      FROM user_media_plays_daily p2
      WHERE p2.show_media_id = a.any_id
      OFFSET 0
    ) p
    JOIN server_users su ON su.id = p.server_user_id
    WHERE (${lensUserId}::uuid IS NULL OR su.user_id = ${lensUserId}) ${serverFragment}
    GROUP BY a.canonical_id
  `);
  return result.rows as unknown as ShowWatchedRow[];
}

/**
 * Resolves per-media watched state for a page of movies and shows, alias-aware
 * (merged duplicates share state) and scoped to a server set and/or a single
 * identity's lens. lensUserId === null aggregates across every identity: the
 * `su.user_id = lensUserId` filter short-circuits via the leading OR IS NULL,
 * which is equivalent to a semi-join across all users for this BOOL_OR/COUNT shape.
 */
export async function resolveWatchedStates(
  args: WatchedProbeArgs
): Promise<Map<string, WatchedState>> {
  const { movieIds, showIds, serverIds, lensUserId, episodeCounts } = args;
  const result = new Map<string, WatchedState>();

  if (movieIds.length > 0) {
    const rows = await fetchMovieWatchedRows(movieIds, serverIds, lensUserId);
    for (const [id, state] of mapMovieWatchedRows(movieIds, rows)) {
      result.set(id, state);
    }
  }

  if (showIds.length > 0) {
    const rows = await fetchShowWatchedRows(showIds, serverIds, lensUserId);
    for (const [id, state] of mapShowWatchedRows(showIds, rows, episodeCounts)) {
      result.set(id, state);
    }
  }

  return result;
}
