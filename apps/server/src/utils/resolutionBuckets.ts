/**
 * SQL fragments for resolution bucketing, generated from the shared ladder in
 * @tracearr/shared/resolution so database bucketing agrees with
 * resolutionBucket() by construction. Used by the snapshot writer's SQL twin
 * (the history backfill), the facet endpoints, and best-of-copies ranking.
 */

import { sql, type SQL } from 'drizzle-orm';
import {
  resolutionBucketSpellings,
  resolutionAboveSdSpellings,
  resolutionSpellingRanks,
  type ResolutionBucket,
} from '@tracearr/shared';

const quoteList = (values: string[]): string => values.map((v) => `'${v}'`).join(', ');

const IN_LIST: Record<Exclude<ResolutionBucket, 'sd'>, string> = {
  '4k': quoteList(resolutionBucketSpellings('4k')),
  '1080p': quoteList(resolutionBucketSpellings('1080p')),
  '720p': quoteList(resolutionBucketSpellings('720p')),
};

const ABOVE_SD_LIST = quoteList(resolutionAboveSdSpellings());

/**
 * Predicate for membership in one of the four snapshot buckets.
 *
 * @param column - Trusted column expression, e.g. 'video_resolution' or
 *   'li.video_resolution'. Interpolated raw; never pass user input.
 * @param opts.includeNullAsSd - Endpoint display rule that counts NULL into
 *   the sd bucket. Snapshot writers exclude NULL.
 */
export function resolutionBucketPredicate(
  column: string,
  bucket: ResolutionBucket,
  opts?: { includeNullAsSd?: boolean }
): SQL {
  const col = sql.raw(column);
  if (bucket === 'sd') {
    return opts?.includeNullAsSd
      ? sql`(${col} IS NULL OR ${col} NOT IN (${sql.raw(ABOVE_SD_LIST)}))`
      : sql`(${col} IS NOT NULL AND ${col} NOT IN (${sql.raw(ABOVE_SD_LIST)}))`;
  }
  return sql`${col} IN (${sql.raw(IN_LIST[bucket])})`;
}

/**
 * EXISTS predicate: the item has at least one active version in the bucket.
 * Overlapping by construction, so a 4K+1080p title satisfies both buckets and
 * bucket counts no longer sum to the item total.
 *
 * @param itemIdColumn - Trusted column expression for the library_items id,
 *   e.g. 'library_items.id' or 'li.id'. Interpolated raw; never user input.
 */
export function hasVersionInBucket(
  itemIdColumn: string,
  bucket: ResolutionBucket,
  opts?: { includeNullAsSd?: boolean }
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM library_item_versions liv
    WHERE liv.library_item_id = ${sql.raw(itemIdColumn)}
      AND liv.removed_at IS NULL
      AND ${resolutionBucketPredicate('liv.video_resolution', bucket, opts)}
  )`;
}

const RANK_CASE_ARMS = resolutionSpellingRanks()
  .map(({ spelling, rank }) => `WHEN '${spelling}' THEN ${rank}`)
  .join(' ');

/**
 * CASE expression ranking a resolution column by tier (higher = better).
 * NULL and unknown labels rank 0. Mirrors resolutionTierRank for the stored
 * spellings; use with ARRAY_AGG(... ORDER BY ... DESC) to pick the best
 * actual label instead of comparing labels lexicographically.
 */
export function resolutionRankSql(column: string): SQL {
  return sql.raw(`CASE ${column} ${RANK_CASE_ARMS} ELSE 0 END`);
}
