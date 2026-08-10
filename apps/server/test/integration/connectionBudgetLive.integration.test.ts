/**
 * Connection budget against the real database: reads the actual
 * max_connections, resizes the live pool, and proves queries still flow
 * through the resized pool. The registry arithmetic is unit-tested; what a
 * mock cannot prove is the SHOW round-trip and pg-pool honoring a runtime
 * options.max change.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- connectionBudgetLive
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, getPoolMax, setPoolMax } from '../../src/db/client.js';
import {
  computePoolShare,
  startConnectionBudget,
  stopConnectionBudget,
} from '../../src/services/connectionBudget.js';

/** Minimal zset stand-in: the registry only needs these four commands */
function stubRegistry(instanceCount: number) {
  return {
    zadd: async () => 1,
    zremrangebyscore: async () => 0,
    zcard: async () => instanceCount,
    pexpire: async () => 1,
    zrem: async () => 1,
  };
}

describe('connection budget against real postgres', () => {
  // The harness pins DATABASE_POOL_MAX=5 per worker, which the budget rightly
  // treats as explicit config - clear it to exercise the auto path
  let originalPoolMax: number;
  beforeEach(() => {
    originalPoolMax = getPoolMax();
    vi.stubEnv('DATABASE_POOL_MAX', '');
  });

  afterEach(async () => {
    await stopConnectionBudget();
    vi.unstubAllEnvs();
    setPoolMax(originalPoolMax);
  });

  it('sizes the pool from the real max_connections and keeps queries flowing', async () => {
    const shown = await db.execute(sql`SHOW max_connections`);
    const maxConnections = parseInt(
      (shown.rows[0] as { max_connections: string }).max_connections,
      10
    );
    expect(maxConnections).toBeGreaterThan(0);

    await startConnectionBudget(stubRegistry(2) as never);

    expect(getPoolMax()).toBe(computePoolShare(maxConnections, 2));

    // The resized pool still serves queries (pg-pool reads options.max live)
    const ping = await db.execute(sql`SELECT 1 AS ok`);
    expect((ping.rows[0] as { ok: number }).ok).toBe(1);

    await stopConnectionBudget();

    // Enough instances that the fair share drops below the 50 cap
    await startConnectionBudget(stubRegistry(6) as never);
    const sixWayShare = computePoolShare(maxConnections, 6);
    expect(sixWayShare).toBeLessThan(50);
    expect(getPoolMax()).toBe(sixWayShare);
  });
});
