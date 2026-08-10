import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { uncapDecompressionForTx, type ChunkTimeRange } from '../db/timescale.js';

export interface BackfillWindow {
  /** Inclusive lower bound on started_at */
  start?: Date;
  /** Exclusive upper bound on started_at */
  end?: Date;
}

/**
 * Stamp canonical media identity onto historical sessions in one bounded batch.
 *
 * Two passes, each windowed the same way (ORDER BY started_at DESC LIMIT):
 * - Fresh stamp: joins sessions to library_items on (server_id, rating_key) and
 *   copies the resolved media id, show id, and provider ids. Sessions whose rating
 *   key has no library item with a resolvable media id are excluded so they never
 *   re-select.
 * - Show-link repair: sessions that already have media_id but were stamped before
 *   their media row's show_media_id existed (e.g. the show synced later). Re-running
 *   this is safe - a repaired session no longer matches either pass's WHERE clause.
 *
 * The optional started_at window is what keeps this survivable on a compressed
 * hypertable: one transaction per chunk bounds tuple decompression to a single
 * chunk's segments. The per-transaction cap is lifted inside that bound - a
 * busy month-chunk decompresses more tuples than the 100k default even for a
 * 10k-row batch, and tripping the cap turns the walk into a fail-retry loop.
 * The window is the memory guard, not the cap; an unwindowed batch with the
 * cap disabled globally is what once ballooned until the OOM killer took
 * postgres down.
 */
export async function backfillSessionIdentityBatch(
  limit: number,
  window?: BackfillWindow
): Promise<{ updated: number; oldest: Date | null }> {
  const startFilter = window?.start
    ? sql`AND s.started_at >= ${window.start.toISOString()}::timestamptz`
    : sql``;
  const endFilter = window?.end
    ? sql`AND s.started_at < ${window.end.toISOString()}::timestamptz`
    : sql``;

  const { freshRows, repairRows } = await db.transaction(async (tx) => {
    await uncapDecompressionForTx(tx);
    const fresh = await tx.execute(sql`
      WITH batch AS (
        SELECT s.id, s.started_at, s.server_id, s.rating_key
        FROM sessions s
        WHERE s.media_id IS NULL AND s.rating_key IS NOT NULL
          ${startFilter}
          ${endFilter}
          AND EXISTS (
            SELECT 1 FROM library_items li2
            WHERE li2.server_id = s.server_id AND li2.rating_key = s.rating_key
              AND li2.media_id IS NOT NULL
          )
        ORDER BY s.started_at DESC
        LIMIT ${limit}
      )
      UPDATE sessions s
      SET media_id = li.media_id,
          show_media_id = CASE WHEN li.media_type = 'episode' THEN m.show_media_id END,
          imdb_id = li.imdb_id,
          tmdb_id = li.tmdb_id,
          tvdb_id = li.tvdb_id,
          parent_rating_key = li.parent_rating_key,
          grandparent_rating_key = li.grandparent_rating_key
      FROM batch b
      JOIN library_items li ON li.server_id = b.server_id AND li.rating_key = b.rating_key
      LEFT JOIN media m ON m.id = li.media_id
      WHERE s.id = b.id AND s.started_at = b.started_at AND li.media_id IS NOT NULL
      RETURNING s.started_at
    `);

    const repair = await tx.execute(sql`
      WITH batch AS (
        SELECT s.id, s.started_at, m.show_media_id AS new_show_media_id
        FROM sessions s
        JOIN media m ON m.id = s.media_id
        WHERE s.media_id IS NOT NULL AND s.show_media_id IS NULL AND m.show_media_id IS NOT NULL
          ${startFilter}
          ${endFilter}
        ORDER BY s.started_at DESC
        LIMIT ${limit}
      )
      UPDATE sessions s
      SET show_media_id = b.new_show_media_id
      FROM batch b
      WHERE s.id = b.id AND s.started_at = b.started_at
      RETURNING s.started_at
    `);

    return { freshRows: fresh.rows, repairRows: repair.rows };
  });
  // Raw db.execute results carry timestamptz columns as Postgres text, not Date.
  const combined = [
    ...(freshRows as unknown as Array<{ started_at: string }>),
    ...(repairRows as unknown as Array<{ started_at: string }>),
  ];
  const oldestStr = combined.length
    ? combined.reduce(
        (min, r) => (r.started_at < min ? r.started_at : min),
        combined[0]!.started_at
      )
    : null;
  return { updated: combined.length, oldest: oldestStr ? new Date(oldestStr) : null };
}

/**
 * Cheap existence probes for identity work remaining below a cutoff - the sync
 * tail uses this to decide whether compressed history still needs the
 * maintenance walk. Mirrors the two passes of backfillSessionIdentityBatch;
 * the second query only runs when the first finds nothing.
 */
export async function hasStampableSessionsBefore(cutoff: Date): Promise<boolean> {
  const fresh = await db.execute(sql`
    SELECT 1 FROM sessions s
    WHERE s.media_id IS NULL AND s.rating_key IS NOT NULL
      AND s.started_at < ${cutoff.toISOString()}::timestamptz
      AND EXISTS (
        SELECT 1 FROM library_items li
        WHERE li.server_id = s.server_id AND li.rating_key = s.rating_key
          AND li.media_id IS NOT NULL
      )
    LIMIT 1
  `);
  if (fresh.rows.length > 0) return true;

  const repair = await db.execute(sql`
    SELECT 1 FROM sessions s
    JOIN media m ON m.id = s.media_id
    WHERE s.show_media_id IS NULL AND m.show_media_id IS NOT NULL
      AND s.started_at < ${cutoff.toISOString()}::timestamptz
    LIMIT 1
  `);
  return repair.rows.length > 0;
}

export interface BackfillWalkResult {
  total: number;
  earliest: Date | null;
  /** Human-readable time ranges that errored and were skipped */
  failedRanges: string[];
}

/** Wraps a runBatch failure so the chunk loop can tell it from an abort signal
 *  (e.g. a lost job lock thrown by onBatch, which must fail the whole walk). */
class BackfillRangeError extends Error {
  constructor(override readonly cause: unknown) {
    super(`range batch failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Deepest bisection of a failing chunk: 30 days / 2^5 is roughly a day. */
const MAX_BISECT_DEPTH = 5;

/** A fault that hits this many distinct ranges isn't a per-chunk decompression
 *  problem - abort instead of grinding through every remaining chunk. The
 *  in-flight totals are deliberately discarded: with a systemic fault the
 *  post-walk aggregate refresh would fail too. Must exceed 2^MAX_BISECT_DEPTH
 *  (32) so one pathologically dense chunk's worth of day-level leaves can
 *  never trip this alone; a genuinely dead database still aborts after
 *  roughly two chunks of leaves. */
const WALK_FAILURE_ABORT_THRESHOLD = 40;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Drain the whole backlog: the uncompressed region first (everything newer
 * than the newest compressed chunk), then each compressed chunk as its own
 * bounded window, newest first, then one unwindowed sweep for rows in chunks
 * that sit below the horizon without being compressed (e.g. manually
 * decompressed ones - already stamped rows don't match the batch queries, so
 * the sweep only ever touches those stragglers).
 *
 * A window whose batch errors is halved and retried down to day-level leaves
 * before the range is recorded and skipped, so a chunk dense enough to trip
 * the decompression cap on a whole-chunk window degrades to slower rather than
 * permanently failed - one bad range can't block the rest of history either
 * way. The sweep is skipped after any failure since it would just re-hit the
 * same rows. Once WALK_FAILURE_ABORT_THRESHOLD ranges have failed the walk
 * rejects instead of continuing; that many failures means the database, not
 * the chunks.
 */
export async function runSessionIdentityBackfillWalk(deps: {
  batchSize: number;
  getCompressedRanges: () => Promise<ChunkTimeRange[]>;
  runBatch?: typeof backfillSessionIdentityBatch;
  /** Called after every batch with the running total (progress + lock extension) */
  onBatch?: (total: number) => Promise<void>;
}): Promise<BackfillWalkResult> {
  const { batchSize, getCompressedRanges, runBatch = backfillSessionIdentityBatch, onBatch } = deps;
  let total = 0;
  let earliest: Date | null = null;
  const failedRanges: string[] = [];

  const drain = async (window?: BackfillWindow) => {
    for (;;) {
      let batch: { updated: number; oldest: Date | null };
      try {
        batch = await runBatch(batchSize, window);
      } catch (err) {
        throw new BackfillRangeError(err);
      }
      total += batch.updated;
      if (batch.oldest && (!earliest || batch.oldest < earliest)) earliest = batch.oldest;
      // Deliberately outside the try: onBatch extends the job lock, and a lost
      // lock must abort the whole walk, never be recorded as a failed range.
      await onBatch?.(total);
      if (batch.updated < batchSize) break;
    }
  };

  const drainRange = async (window: Required<BackfillWindow>, depth: number): Promise<void> => {
    try {
      await drain(window);
    } catch (err) {
      if (!(err instanceof BackfillRangeError)) throw err;
      const span = window.end.getTime() - window.start.getTime();
      if (depth >= MAX_BISECT_DEPTH || span <= DAY_MS) {
        const label = `${window.start.toISOString()} → ${window.end.toISOString()}`;
        failedRanges.push(label);
        console.error(`[SessionIdentityBackfill] Range ${label} failed, continuing:`, err.cause);
        if (failedRanges.length >= WALK_FAILURE_ABORT_THRESHOLD) {
          // Plain Error, not BackfillRangeError: every catch above rethrows
          // anything that isn't a range failure, so this leaves the walk.
          throw new Error(
            `Aborting walk: ${failedRanges.length} failed ranges - this looks like a systemic fault (connectivity, permissions), not per-chunk decompression`
          );
        }
        return;
      }
      const mid = new Date(window.start.getTime() + Math.floor(span / 2));
      await drainRange({ start: window.start, end: mid }, depth + 1);
      await drainRange({ start: mid, end: window.end }, depth + 1);
    }
  };

  const compressed = await getCompressedRanges();
  const horizon = compressed[0]?.end;
  // Uncaught on purpose: this region is uncompressed, so a failure here is a
  // plain SQL or connectivity fault rather than a decompression-cap trip.
  await drain(horizon ? { start: horizon } : undefined);

  for (const range of compressed) {
    await drainRange({ start: range.start, end: range.end }, 0);
  }

  if (compressed.length > 0 && failedRanges.length === 0) {
    try {
      await drain(undefined);
    } catch (err) {
      if (!(err instanceof BackfillRangeError)) throw err;
      // A chunk can be compressed mid-walk (a compression job already running
      // survives remove_compression_policy), so the sweep can trip the same cap.
      // Record it instead of discarding the totals the walk already committed.
      failedRanges.push('unwindowed sweep');
      console.error('[SessionIdentityBackfill] Range unwindowed sweep failed:', err.cause);
    }
  }

  return { total, earliest, failedRanges };
}
