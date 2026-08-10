/**
 * Leader lease - elects one instance to run the session producers
 *
 * Every instance serves HTTP, Socket.io, and the pub/sub subscriber, and
 * BullMQ workers are multi-instance safe on their own. The poller loop and
 * the SSE connections are not: N instances would open N connections per
 * media server and poll N times. One Redis lease gates them - the holder
 * runs the producers, everyone else stands by and takes over when the lease
 * expires (leader crashed) or is released (graceful shutdown).
 *
 * Single-instance deployments acquire on the first tick and never notice
 * this exists.
 */

import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { getRedisPrefix } from '@tracearr/shared';

const LEASE_TTL_MS = 30_000;
const LEASE_RENEW_MS = 10_000;
// Demote after this many consecutive failed ticks while leading. Two misses
// is 20s against a 30s TTL: we stand down before another instance can have
// acquired an expired lease, so producers never run twice.
const MAX_RENEW_FAILURES = 2;

// Renew and release must only touch the lease while this instance still
// holds it, so both compare the stored holder id before acting.
const RENEW_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('pexpire', KEYS[1], ARGV[2])
  end
  return 0
`;
const RELEASE_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

export interface LeaderLeaseCallbacks {
  onAcquired: () => void | Promise<void>;
  onLost: () => void | Promise<void>;
}

const instanceId = randomUUID();
let client: Redis | null = null;
let timer: NodeJS.Timeout | null = null;
let leader = false;
let callbacks: LeaderLeaseCallbacks | null = null;
let renewFailures = 0;
let tickInFlight = false;
// Bumped on every start/stop so a tick resumed after an await can tell the
// lease it belongs to was torn down and must not mutate the new one's state.
let generation = 0;

export function isLeader(): boolean {
  return leader;
}

function leaseKey(): string {
  return `${getRedisPrefix()}tracearr:leader-lease`;
}

async function demote(reason: string): Promise<void> {
  leader = false;
  renewFailures = 0;
  console.warn(`[LeaderLease] ${reason}, stopping producers`);
  if (callbacks) {
    await callbacks.onLost();
  }
}

async function tick(): Promise<void> {
  if (!client || !callbacks || tickInFlight) return;
  tickInFlight = true;
  const tickGeneration = generation;

  try {
    if (leader) {
      const renewed = (await client.eval(RENEW_SCRIPT, 1, leaseKey(), instanceId, LEASE_TTL_MS)) as
        number | null;
      if (tickGeneration !== generation) return;
      if (renewed) {
        renewFailures = 0;
      } else {
        await demote('Lost the lease');
      }
      return;
    }

    const acquired = await client.set(leaseKey(), instanceId, 'PX', LEASE_TTL_MS, 'NX');
    if (tickGeneration !== generation) return;
    if (acquired === 'OK') {
      leader = true;
      renewFailures = 0;
      console.log(`[LeaderLease] Acquired the lease (instance ${instanceId})`);
      await callbacks.onAcquired();
    }
  } catch (error) {
    console.error('[LeaderLease] Tick failed:', error);
    if (tickGeneration !== generation) return;
    if (leader) {
      renewFailures += 1;
      if (renewFailures >= MAX_RENEW_FAILURES) {
        await demote(`Redis unreachable for ${renewFailures} renewals`);
      }
    }
  } finally {
    tickInFlight = false;
  }
}

export async function startLeaderLease(
  redisUrl: string,
  leaseCallbacks: LeaderLeaseCallbacks
): Promise<void> {
  if (client) {
    console.log('[LeaderLease] Already started');
    return;
  }

  generation += 1;
  callbacks = leaseCallbacks;
  client = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
  client.on('error', (err) => {
    console.error('[LeaderLease] Redis error:', err.message);
  });

  await tick();
  if (!leader) {
    console.log('[LeaderLease] Standing by (lease held elsewhere or Redis unavailable)');
  }
  timer = setInterval(() => void tick(), LEASE_RENEW_MS);
}

export async function stopLeaderLease(): Promise<void> {
  // Tear down local state synchronously before any await so a concurrent
  // startLeaderLease starts fresh and a resumed tick aborts on generation.
  generation += 1;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const releasingClient = client;
  const wasLeader = leader;
  client = null;
  callbacks = null;
  leader = false;
  renewFailures = 0;

  if (releasingClient && wasLeader) {
    try {
      await releasingClient.eval(RELEASE_SCRIPT, 1, leaseKey(), instanceId);
    } catch {
      // The lease expires on its own within LEASE_TTL_MS
    }
  }
  releasingClient?.disconnect();
}
