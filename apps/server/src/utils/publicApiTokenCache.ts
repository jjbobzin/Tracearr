/**
 * In-process cache of known public API token hashes.
 *
 * Backs the rate-limit keyGenerator's per-token bucket decision. Refreshing
 * from the users table on every request would put a DB round trip on the
 * global hot path, so instead the whole set of configured tokens is snapshotted
 * and re-queried at most once per TTL.
 */

import { isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashSha256 } from './hash.js';

const CACHE_TTL_MS = 30_000;

let cachedHashes: Set<string> | null = null;
let expiresAt = 0;

async function refresh(): Promise<Set<string>> {
  const rows = await db
    .select({ apiToken: users.apiToken })
    .from(users)
    .where(isNotNull(users.apiToken));
  const tokens = rows.map((row) => row.apiToken).filter((token): token is string => token !== null);
  const hashes = new Set(tokens.map(hashSha256));
  cachedHashes = hashes;
  expiresAt = Date.now() + CACHE_TTL_MS;
  return hashes;
}

/**
 * Whether a bearer token matches a currently configured public API key.
 * On a refresh failure, falls back to the last successful snapshot; if no
 * snapshot has ever loaded, fails closed (every token reads as unknown).
 */
export async function isKnownPublicApiToken(token: string): Promise<boolean> {
  let hashes = cachedHashes;
  if (!hashes || Date.now() >= expiresAt) {
    try {
      hashes = await refresh();
    } catch {
      if (!cachedHashes) return false;
      hashes = cachedHashes;
    }
  }
  return hashes.has(hashSha256(token));
}

/** Test-only: clears the in-process snapshot so tests don't leak state across runs. */
export function resetPublicApiTokenCache(): void {
  cachedHashes = null;
  expiresAt = 0;
}
