/**
 * Plex Token Refresh Queue - BullMQ-based daily refresh of strong-PIN JWT tokens
 *
 * Plex's 2025 "strong" PIN variant issues a JWT access token that expires
 * (currently understood to be 7 days) but can be refreshed server-side. This
 * job finds auth_accounts plex rows whose accessTokenExpiresAt falls inside
 * a 48-hour refresh window and refreshes them, mirroring the result into
 * plex_accounts.plexToken and any linked servers.token - the same writes
 * check-pin already performs on login (see plexPlugin.ts).
 *
 * Legacy tokens have no accessTokenExpiresAt, so they never match the
 * refresh query and this job is a no-op for them. A failed refresh for one
 * account is logged and leaves that account's stored token untouched; it
 * never blocks other accounts and never locks a user out (login attempts
 * fall back to whatever token is on file).
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { getRedisPrefix, TIME_MS } from '@tracearr/shared';
import { and, eq, lte, isNotNull } from 'drizzle-orm';
import { isMaintenance } from '../serverState.js';
import { db } from '../db/client.js';
import { authAccounts, plexAccounts, servers } from '../db/schema.js';
import { invalidateServersCache } from './poller/database.js';
import { PlexClient } from '../services/mediaServer/index.js';

const QUEUE_NAME = 'plex-token-refresh';

// Refresh tokens expiring within this window so the ~7-day lifetime never lapses between daily runs
const REFRESH_WINDOW_MS = 48 * TIME_MS.HOUR;
const REFRESH_INTERVAL_MS = TIME_MS.DAY;

interface PlexTokenRefreshJobData {
  type: 'refresh';
}

let connectionOptions: ConnectionOptions | null = null;
let refreshQueue: Queue<PlexTokenRefreshJobData> | null = null;
let refreshWorker: Worker<PlexTokenRefreshJobData> | null = null;

/**
 * Initialize the plex token refresh queue with Redis connection
 */
export function initPlexTokenRefreshQueue(redisUrl: string): void {
  if (refreshQueue) {
    console.log('[PlexTokenRefresh] Queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  const bullPrefix = `${getRedisPrefix()}bull`;

  refreshQueue = new Queue<PlexTokenRefreshJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 30000, // 30s, 60s, 120s
      },
      removeOnComplete: {
        count: 20,
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 50,
        age: 30 * 24 * 60 * 60, // 30 days
      },
    },
  });
  refreshQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('[PlexTokenRefresh] Queue error:', err);
  });

  console.log('[PlexTokenRefresh] Queue initialized');
}

/**
 * Start the plex token refresh worker
 */
export function startPlexTokenRefreshWorker(): void {
  if (!connectionOptions) {
    throw new Error(
      'Plex token refresh queue not initialized. Call initPlexTokenRefreshQueue first.'
    );
  }

  if (refreshWorker) {
    console.log('[PlexTokenRefresh] Worker already running');
    return;
  }

  const bullPrefix = `${getRedisPrefix()}bull`;

  refreshWorker = new Worker<PlexTokenRefreshJobData>(
    QUEUE_NAME,
    async (job: Job<PlexTokenRefreshJobData>) => {
      const startTime = Date.now();
      try {
        const result = await processPlexTokenRefresh();
        console.log(
          `[PlexTokenRefresh] Job ${job.id} completed in ${Date.now() - startTime}ms ` +
            `(checked=${result.checked}, refreshed=${result.refreshed}, failed=${result.failed})`
        );
      } catch (error) {
        console.error(
          `[PlexTokenRefresh] Job ${job.id} failed after ${Date.now() - startTime}ms:`,
          error
        );
        throw error;
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1,
    }
  );

  refreshWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('[PlexTokenRefresh] Worker error:', error);
  });

  console.log('[PlexTokenRefresh] Worker started');
}

/**
 * Schedule the daily plex token refresh job
 */
export async function schedulePlexTokenRefresh(): Promise<void> {
  if (!refreshQueue) {
    console.error('[PlexTokenRefresh] Queue not initialized');
    return;
  }

  // Remove any existing job schedulers (repeatable jobs)
  const schedulers = await refreshQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    if (scheduler.id) {
      await refreshQueue.removeJobScheduler(scheduler.id);
    }
  }

  await refreshQueue.add(
    'scheduled-refresh',
    { type: 'refresh' },
    {
      repeat: {
        every: REFRESH_INTERVAL_MS,
      },
      jobId: 'plex-token-refresh-repeatable',
    }
  );

  console.log('[PlexTokenRefresh] Scheduled daily token refresh checks');
}

export interface PlexTokenRefreshResult {
  checked: number;
  refreshed: number;
  failed: number;
}

/**
 * Refresh any plex auth_accounts JWT-variant tokens expiring within the
 * refresh window. Safe to call with zero plex accounts or zero JWT-variant
 * tokens - the query simply returns no rows.
 */
export async function processPlexTokenRefresh(): Promise<PlexTokenRefreshResult> {
  const cutoff = new Date(Date.now() + REFRESH_WINDOW_MS);

  const candidates = await db
    .select({
      id: authAccounts.id,
      accountId: authAccounts.accountId,
      refreshToken: authAccounts.refreshToken,
    })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.providerId, 'plex'),
        isNotNull(authAccounts.accessTokenExpiresAt),
        lte(authAccounts.accessTokenExpiresAt, cutoff)
      )
    );

  let refreshed = 0;
  let failed = 0;

  for (const candidate of candidates) {
    if (!candidate.refreshToken) {
      console.warn(
        `[PlexTokenRefresh] auth_accounts row ${candidate.id} has an expiry but no refresh token, skipping`
      );
      failed++;
      continue;
    }

    try {
      const refreshedToken = await PlexClient.refreshStrongToken(candidate.refreshToken);
      if (!refreshedToken) {
        console.warn(
          `[PlexTokenRefresh] Refresh failed for auth_accounts row ${candidate.id}, leaving stored token as-is`
        );
        failed++;
        continue;
      }

      await db
        .update(authAccounts)
        .set({
          accessToken: refreshedToken.accessToken,
          refreshToken: refreshedToken.refreshToken,
          accessTokenExpiresAt: refreshedToken.expiresAt,
          updatedAt: new Date(),
        })
        .where(eq(authAccounts.id, candidate.id));

      // refreshedToken.accessToken is a strong-PIN JWT. Only clients.plex.tv
      // has been confirmed to accept a JWT here; PMS itself may reject a JWT
      // in X-Plex-Token. Re-validate against a real PMS before the JWT branch
      // can ever fire - today initiateOAuth never sends a JWK, so no row
      // reaches this job with a JWT-variant token yet.
      const [plexAccount] = await db
        .update(plexAccounts)
        .set({ plexToken: refreshedToken.accessToken })
        .where(eq(plexAccounts.plexAccountId, candidate.accountId))
        .returning({ id: plexAccounts.id });

      if (plexAccount) {
        await db
          .update(servers)
          .set({ token: refreshedToken.accessToken, updatedAt: new Date() })
          .where(eq(servers.plexAccountId, plexAccount.id));
        // A stale cached token means failed polls until the TTL expires,
        // which is enough consecutive failures to fire a server_down push
        invalidateServersCache();
      }

      refreshed++;
    } catch (error) {
      console.error(
        `[PlexTokenRefresh] Error refreshing auth_accounts row ${candidate.id}:`,
        error
      );
      failed++;
    }
  }

  return { checked: candidates.length, refreshed, failed };
}

/**
 * Gracefully shutdown the plex token refresh queue and worker
 */
export async function shutdownPlexTokenRefreshQueue(): Promise<void> {
  console.log('[PlexTokenRefresh] Shutting down queue...');

  if (refreshWorker) {
    await refreshWorker.close();
    refreshWorker = null;
  }

  if (refreshQueue) {
    await refreshQueue.close();
    refreshQueue = null;
  }

  console.log('[PlexTokenRefresh] Queue shutdown complete');
}
