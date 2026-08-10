/**
 * Library Route Utilities
 *
 * Shared helpers for library statistics routes including server filtering
 * and cache key generation.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { REDIS_KEYS } from '@tracearr/shared';

/**
 * Bytes for one canonical title. Identical file_size across copies of the same
 * underlying media means one physical file mirrored across servers, so it counts
 * once; a different size is a distinct rendition. For a show this rolls up every
 * episode (media linked by show_media_id), deduping each episode's mirrors, so
 * show size reflects its episodes rather than the empty container row. For a
 * movie only its own copies match, so this equals the plain mirror-dedupe.
 * serverFragment stays inside so dedupe + rollup respect the requested servers.
 *
 * The self-branch (im.id = mediaIdExpr) excludes show rows on purpose: a show's
 * own library_items row today always has a NULL file_size, so this is a no-op
 * in practice, but nothing stops a future import from writing a size onto that
 * container row. Without the guard that would be summed on top of the episode
 * rollup and double-count the show. Movies are unaffected since a movie row's
 * media_type is never 'show'.
 */
export function mediaSizeSubquery(mediaIdExpr: SQL, serverFragment: SQL): SQL {
  // Version grain: the rendition dedupe compares per-file sizes, so a
  // multi-version title's copies dedupe file-by-file across servers and
  // libraries (#478) instead of comparing whole-title sums.
  return sql`(SELECT COALESCE(SUM(sz), 0) FROM (
    SELECT DISTINCT li2.media_id, v.file_size AS sz
    FROM library_items li2
    JOIN library_item_versions v
      ON v.library_item_id = li2.id AND v.removed_at IS NULL AND v.file_size IS NOT NULL
    JOIN media im ON im.id = li2.media_id
    WHERE (
        (im.id = ${mediaIdExpr} AND im.media_type <> 'show')
        OR im.show_media_id = ${mediaIdExpr}
      )
      AND li2.removed_at IS NULL ${serverFragment}
  ) d)`;
}

/**
 * Mirror-deduped total bytes for a scope: the same physical file indexed by
 * several libraries or servers counts once (#478). Identity is the canonical
 * media id (item id fallback) + per-version file size; two distinct files
 * that share both title and exact byte size still collapse, the same accepted
 * heuristic mediaSizeSubquery has always used.
 * Filters must reference library_items as li.
 */
export function dedupedStorageBytesSql(serverFilter: SQL, libraryFilter: SQL): SQL {
  return sql`(
    SELECT COALESCE(SUM(d.sz), 0) FROM (
      SELECT DISTINCT COALESCE(li.media_id::text, li.id::text) AS ident, v.file_size AS sz
      FROM library_items li
      JOIN library_item_versions v
        ON v.library_item_id = li.id AND v.removed_at IS NULL AND v.file_size IS NOT NULL
      WHERE li.removed_at IS NULL
        ${serverFilter}
        ${libraryFilter}
    ) d
  )`;
}

/**
 * Generate cache key with all varying parameters to prevent cache collisions.
 *
 * @param prefix - Cache key prefix (e.g., REDIS_KEYS.LIBRARY_STATS)
 * @param serverId - Optional server filter
 * @param period - Optional period filter (for growth endpoint)
 * @param timezone - Optional timezone
 * @param variant - Optional extra segment for any other cacheable input
 *   (e.g. a display preference like preferred poster server)
 * @returns Cache key string
 */
export function buildLibraryCacheKey(
  prefix: string,
  serverId?: string,
  period?: string,
  timezone?: string,
  variant?: string
): string {
  const parts = [prefix];
  if (serverId) parts.push(serverId);
  if (period) parts.push(period);
  if (timezone) parts.push(timezone);
  if (variant) parts.push(variant);
  return parts.join(':');
}

const SINGLE_FLIGHT_LOCK_TTL_SECONDS = 60;
const SINGLE_FLIGHT_POLL_MS = 500;
const SINGLE_FLIGHT_WAIT_MS = 15_000;

/**
 * Single-flight guard around a cold cache-miss compute: the first caller past
 * the cache TTL takes a short SET-NX lock and runs `compute` (which must fill
 * `cacheKey` itself); every other concurrent caller for the same key polls the
 * cache instead of re-running the same expensive query set. Originated as
 * shelves.ts's computeShelvesSingleFlight; also drives catalog.ts's
 * getWatchedCandidates single-flight.
 *
 * Fail-open by design: a Redis error acquiring or polling the lock, or a 15s
 * wait with no cached result yet, falls through to computing directly - a
 * duplicate compute is cheaper than a failed request.
 */
export async function withComputeSingleFlight<T>(
  redis: Redis,
  cacheKey: string,
  compute: () => Promise<T>,
  parseCached: (raw: string) => T
): Promise<T> {
  let acquiredLock = true;
  try {
    const lockKey = REDIS_KEYS.LIBRARY_SINGLE_FLIGHT_LOCK(cacheKey);
    acquiredLock =
      (await redis.set(lockKey, '1', 'EX', SINGLE_FLIGHT_LOCK_TTL_SECONDS, 'NX')) === 'OK';
  } catch {
    acquiredLock = true;
  }

  if (acquiredLock) {
    return compute();
  }

  const deadline = Date.now() + SINGLE_FLIGHT_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SINGLE_FLIGHT_POLL_MS));
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return parseCached(cached);
      }
    } catch {
      break; // Redis unavailable - fall through to compute.
    }
  }

  return compute();
}
