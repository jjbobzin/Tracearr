/**
 * Session Query Constants
 */

import { sql } from 'drizzle-orm';

// Count unique plays — COALESCE(reference_id, id) collapses pause/resume chains into one play
export const PLAY_COUNT = sql<number>`count(distinct coalesce(reference_id, id))::int`;

// Chain-aware plays excluding sub-2-minute sessions; api-facing counterpart of PLAY_COUNT.
// Gates on duration, not short_session: the flag is unset on some imported history
export const CHAIN_PLAY_COUNT = sql<number>`count(distinct coalesce(reference_id, id)) filter (where coalesce(duration_ms, 0) >= 120000)::int`;
