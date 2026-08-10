/**
 * In-process cache of the public API per-token rate limit ceiling.
 *
 * Plugin registration must never touch the DB: a DB-down boot needs to reach
 * maintenance mode, not crash-loop waiting on a setting read. The limit is
 * resolved lazily (the rate-limit plugin's `max` accepts a function, called
 * per request, not at registration) and refreshed at most once per TTL. A DB
 * error keeps the last known-good value, or DEFAULT_LIMIT on a first-ever
 * failure - fail-open at a bounded ceiling, never unlimited.
 */

import { getSetting } from '../../services/settings.js';

const DEFAULT_LIMIT = 240;
const CACHE_TTL_MS = 30_000;

let cachedLimit = DEFAULT_LIMIT;
let expiresAt = 0;

export async function getPublicApiRateLimit(): Promise<number> {
  if (Date.now() < expiresAt) return cachedLimit;
  try {
    cachedLimit = await getSetting('publicApiRateLimitPerMinute');
  } catch {
    // Keep the last known-good value (or the default, on a first-load failure).
  }
  expiresAt = Date.now() + CACHE_TTL_MS;
  return cachedLimit;
}

/** Test-only: resets the in-process snapshot so tests don't leak state across runs. */
export function resetPublicApiRateLimitCache(): void {
  cachedLimit = DEFAULT_LIMIT;
  expiresAt = 0;
}
