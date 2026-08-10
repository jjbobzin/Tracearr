/**
 * Plex login as a Better Auth plugin
 *
 * Ports the Plex PIN login flow (previously the `check-pin` / `connect`
 * Fastify handlers in routes/auth/plex.ts) onto Better Auth. The lookup and
 * first-run logic are unchanged; the only behavioral difference is the ending:
 * instead of issuing JWT access/refresh tokens, it creates a Better Auth
 * session and sets the session cookie.
 *
 * Endpoints (mounted under /api/v1/auth via the plugin):
 * - POST /plex/initiate   -> { pinId, authUrl }
 * - POST /plex/check-pin   -> { authorized: false } | server-selection payload |
 *                             { authorized: true, user } with the session cookie
 * - POST /plex/connect     -> { authorized: true, user } with the session cookie
 *
 * Security: an auth_accounts plex row never grants login on its own. Login
 * requires plex_accounts.allowLogin (or the legacy-equivalent lookup), the
 * owner-only rule, and (via the session hook) assertUserCanLogin.
 */

import { randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { REDIS_KEYS, type PlexDiscoveredServer } from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, servers, serverUsers, plexAccounts, authAccounts } from '../db/schema.js';
import { PlexClient } from '../services/mediaServer/index.js';
import { testServerConnections } from '../services/mediaServer/plex/connectionTest.js';
import { syncServer } from '../services/sync.js';
import { getUserById, getUserByPlexAccountId } from '../services/userService.js';
import { getRedis } from './redisShared.js';
import { invalidateServersCache } from '../jobs/poller/database.js';
import { assertSignupAllowed, assertClaimCode } from './authGuards.js';

const PLEX_TEMP_TOKEN_TTL = 10 * 60; // 10 minutes for server selection

const checkPinBody = z.object({ pinId: z.string(), claimCode: z.string().optional() });
const initiateBody = z.object({ forwardUrl: z.url().optional() });
const connectBody = z.object({
  tempToken: z.string(),
  serverUri: z.url(),
  serverName: z.string().min(1).max(100),
  clientIdentifier: z.string().optional(),
  claimCode: z.string().optional(),
});

type PlexEndpointCtx = Parameters<typeof setSessionCookie>[0];

/**
 * Create a Better Auth session for the given user and set the session cookie.
 * Replaces the JWT token issuance of the legacy Plex handlers. The session
 * `create` database hook still runs assertUserCanLogin as a final gate.
 */
async function createPlexSession(ctx: PlexEndpointCtx, userId: string) {
  const session = await ctx.context.internalAdapter.createSession(userId);
  const user = await ctx.context.internalAdapter.findUserById(userId);
  if (!user) throw new APIError('UNAUTHORIZED', { message: 'User not found' });
  await setSessionCookie(ctx, { session, user });
  return { session, user };
}

interface PlexTokenMetadata {
  token: string;
  tokenKind: 'jwt' | 'legacy';
  refreshToken: string | null;
  expiresAt: Date | null;
}

/**
 * Ensure the auth_accounts plex row exists for this (user, plex.tv account).
 * The unique(provider_id, account_id) constraint means a re-login must not
 * surface a constraint violation, so this upserts.
 *
 * For strong-PIN JWT tokens, `refreshToken` and `accessTokenExpiresAt` are
 * stored so the daily refresh job can renew them. Legacy tokens have no
 * expiry, so those columns stay null and the row is just a long-lived token.
 */
async function upsertPlexAuthAccount(
  userId: string,
  plexAccountId: string,
  tokenInfo: PlexTokenMetadata
) {
  const isJwt = tokenInfo.tokenKind === 'jwt';
  const refreshToken = isJwt ? tokenInfo.refreshToken : null;
  const accessTokenExpiresAt = isJwt ? tokenInfo.expiresAt : null;

  await db
    .insert(authAccounts)
    .values({
      id: randomUUID(),
      accountId: plexAccountId,
      providerId: 'plex',
      userId,
      accessToken: tokenInfo.token,
      refreshToken,
      accessTokenExpiresAt,
    })
    .onConflictDoUpdate({
      target: [authAccounts.providerId, authAccounts.accountId],
      // Intentional downgrade on relogin: a legacy re-login nulls out
      // refreshToken/accessTokenExpiresAt, since a legacy token has neither.
      set: {
        userId,
        accessToken: tokenInfo.token,
        refreshToken,
        accessTokenExpiresAt,
        updatedAt: new Date(),
      },
    });
}

export const plexPlugin = () =>
  ({
    id: 'plex',
    endpoints: {
      plexInitiate: createAuthEndpoint(
        '/plex/initiate',
        { method: 'POST', body: initiateBody },
        async (ctx) => {
          const { pinId, authUrl } = await PlexClient.initiateOAuth(ctx.body.forwardUrl);
          return ctx.json({ pinId, authUrl });
        }
      ),
      plexCheckPin: createAuthEndpoint(
        '/plex/check-pin',
        { method: 'POST', body: checkPinBody },
        async (ctx) => {
          const { pinId, claimCode } = ctx.body;
          try {
            const authResult = await PlexClient.checkOAuthPin(pinId);

            if (!authResult) {
              return ctx.json({ authorized: false, message: 'PIN not yet authorized' });
            }

            // Priority 1: plex_accounts table (login-capable accounts only)
            const plexAccount = await db
              .select({
                id: plexAccounts.id,
                userId: plexAccounts.userId,
                allowLogin: plexAccounts.allowLogin,
              })
              .from(plexAccounts)
              .where(
                and(
                  eq(plexAccounts.plexAccountId, authResult.id),
                  eq(plexAccounts.allowLogin, true)
                )
              )
              .limit(1);

            if (plexAccount.length > 0) {
              const account = plexAccount[0]!;
              const user = await getUserById(account.userId);

              if (user) {
                // Owner-only login gate: the session.create database hook
                // (assertUserCanLogin) only enforces LOGIN_ROLES (owner/admin/viewer),
                // not owner-only. This check and its counterpart below (the Priority
                // 2/3 lookup) are the sole gate keeping a non-owner Plex account from
                // logging in.
                if (user.role !== 'owner') {
                  throw new APIError('FORBIDDEN', {
                    message: 'Only the owner can log in to this Tracearr instance.',
                  });
                }

                // authResult.token may be a strong-PIN JWT (see PlexTokenMetadata).
                // Only clients.plex.tv has been confirmed to accept a JWT here; PMS
                // itself may reject a JWT in X-Plex-Token. Re-validate against a
                // real PMS before the JWT branch can ever fire - today
                // initiateOAuth never sends a JWK, so tokenKind is always 'legacy'
                // and this mirror only ever carries a legacy token.
                await db
                  .update(plexAccounts)
                  .set({
                    plexUsername: authResult.username,
                    plexEmail: authResult.email,
                    plexThumbnail: authResult.thumb,
                    plexToken: authResult.token,
                  })
                  .where(eq(plexAccounts.id, account.id));

                const refreshed = await db
                  .update(servers)
                  .set({ token: authResult.token, updatedAt: new Date() })
                  .where(eq(servers.plexAccountId, account.id))
                  .returning({ id: servers.id, name: servers.name });
                if (refreshed.length > 0) invalidateServersCache();

                if (refreshed.length > 0) {
                  ctx.context.logger.info('Refreshed Plex token for linked servers', {
                    plexAccountId: account.id,
                    servers: refreshed.map((s) => s.name),
                  });
                }

                await db
                  .update(users)
                  .set({
                    username: authResult.username,
                    email: authResult.email,
                    thumbnail: authResult.thumb,
                    updatedAt: new Date(),
                  })
                  .where(eq(users.id, user.id));

                await upsertPlexAuthAccount(user.id, authResult.id, authResult);

                ctx.context.logger.info('Plex user login via plex_accounts', {
                  userId: user.id,
                  plexAccountId: account.id,
                });

                const { user: sessionUser } = await createPlexSession(ctx, user.id);
                return ctx.json({
                  authorized: true,
                  user: { id: sessionUser.id, username: authResult.username, role: 'owner' },
                });
              }
            }

            // Priority 2: users.plexAccountId (legacy - migrate to plex_accounts)
            let existingUser = await getUserByPlexAccountId(authResult.id);

            // Priority 3: server_users.externalId (server-synced users)
            if (!existingUser) {
              const fallbackServerUsers = await db
                .select({ userId: serverUsers.userId })
                .from(serverUsers)
                .where(eq(serverUsers.externalId, authResult.id))
                .limit(1);
              if (fallbackServerUsers[0]) {
                existingUser = await getUserById(fallbackServerUsers[0].userId);
              }
            }

            if (existingUser) {
              const user = existingUser;

              // Only the owner can log in
              if (user.role !== 'owner') {
                throw new APIError('FORBIDDEN', {
                  message: 'Only the owner can log in to this Tracearr instance.',
                });
              }

              const existingPlexAccount = await db
                .select({ id: plexAccounts.id })
                .from(plexAccounts)
                .where(eq(plexAccounts.plexAccountId, authResult.id))
                .limit(1);

              if (existingPlexAccount.length === 0) {
                await db.insert(plexAccounts).values({
                  userId: user.id,
                  plexAccountId: authResult.id,
                  plexUsername: authResult.username,
                  plexEmail: authResult.email,
                  plexThumbnail: authResult.thumb,
                  plexToken: authResult.token,
                  allowLogin: true,
                });
                ctx.context.logger.info('Auto-migrated user to plex_accounts', {
                  userId: user.id,
                  plexAccountId: authResult.id,
                });
              }

              await db
                .update(users)
                .set({
                  username: authResult.username,
                  email: authResult.email,
                  thumbnail: authResult.thumb,
                  plexAccountId: authResult.id,
                  updatedAt: new Date(),
                })
                .where(eq(users.id, user.id));

              await upsertPlexAuthAccount(user.id, authResult.id, authResult);

              ctx.context.logger.info('Returning Plex user login (legacy lookup, migrated)', {
                userId: user.id,
              });

              const { user: sessionUser } = await createPlexSession(ctx, user.id);
              return ctx.json({
                authorized: true,
                user: { id: sessionUser.id, username: authResult.username, role: 'owner' },
              });
            }

            // No user - first-run setup. Fail closed if an owner already exists.
            await assertSignupAllowed();

            const plexServers = await PlexClient.getServers(authResult.token);

            const tempToken = randomUUID().replace(/-/g, '');
            await getRedis().setex(
              REDIS_KEYS.PLEX_TEMP_TOKEN(tempToken),
              PLEX_TEMP_TOKEN_TTL,
              JSON.stringify({
                plexAccountId: authResult.id,
                plexUsername: authResult.username,
                plexEmail: authResult.email,
                plexThumb: authResult.thumb,
                plexToken: authResult.token,
                plexTokenKind: authResult.tokenKind,
                plexRefreshToken: authResult.refreshToken,
                plexTokenExpiresAt: authResult.expiresAt
                  ? authResult.expiresAt.toISOString()
                  : null,
              })
            );

            if (plexServers.length > 0) {
              const testedServers: PlexDiscoveredServer[] = await Promise.all(
                plexServers.map(async (s) => {
                  const testedConnections = await testServerConnections(
                    s.connections,
                    authResult.token
                  );
                  const recommended = testedConnections.find((c) => c.reachable);

                  return {
                    name: s.name,
                    platform: s.platform,
                    version: s.productVersion,
                    clientIdentifier: s.clientIdentifier,
                    publicAddressMatches: s.publicAddressMatches,
                    httpsRequired: s.httpsRequired,
                    connections: testedConnections,
                    recommendedUri: recommended?.uri ?? null,
                  };
                })
              );

              return ctx.json({
                authorized: true,
                needsServerSelection: true,
                servers: testedServers,
                tempToken,
              });
            }

            // No servers - create the first user without a server connection.
            assertClaimCode(claimCode);

            const [newUser] = await db
              .insert(users)
              .values({
                username: authResult.username,
                email: authResult.email,
                thumbnail: authResult.thumb,
                plexAccountId: authResult.id,
                role: 'owner',
              })
              .returning();

            if (!newUser) {
              throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create user' });
            }

            await db.insert(plexAccounts).values({
              userId: newUser.id,
              plexAccountId: authResult.id,
              plexUsername: authResult.username,
              plexEmail: authResult.email,
              plexThumbnail: authResult.thumb,
              plexToken: authResult.token,
              allowLogin: true,
            });

            await upsertPlexAuthAccount(newUser.id, authResult.id, authResult);

            await getRedis().del(REDIS_KEYS.PLEX_TEMP_TOKEN(tempToken));

            ctx.context.logger.info('New Plex user created (no servers)', {
              userId: newUser.id,
              role: 'owner',
            });

            const { user: sessionUser } = await createPlexSession(ctx, newUser.id);
            return ctx.json({
              authorized: true,
              user: { id: sessionUser.id, username: newUser.username, role: 'owner' },
            });
          } catch (error) {
            if (error instanceof APIError) throw error;
            ctx.context.logger.error('Plex check-pin failed', { err: error });
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Failed to check Plex authorization',
            });
          }
        }
      ),
      plexConnect: createAuthEndpoint(
        '/plex/connect',
        { method: 'POST', body: connectBody },
        async (ctx) => {
          const { tempToken, serverUri, serverName, clientIdentifier, claimCode } = ctx.body;

          // Temp token is consumed only on success so a failed attempt can retry.
          const stored = await getRedis().get(REDIS_KEYS.PLEX_TEMP_TOKEN(tempToken));
          if (!stored) {
            throw new APIError('UNAUTHORIZED', {
              message: 'Invalid or expired temp token. Please restart login.',
            });
          }

          const {
            plexAccountId,
            plexUsername,
            plexEmail,
            plexThumb,
            plexToken,
            plexTokenKind,
            plexRefreshToken,
            plexTokenExpiresAt,
          } = JSON.parse(stored) as {
            plexAccountId: string;
            plexUsername: string;
            plexEmail: string;
            plexThumb: string;
            plexToken: string;
            plexTokenKind?: 'jwt' | 'legacy';
            plexRefreshToken?: string | null;
            plexTokenExpiresAt?: string | null;
          };

          try {
            // Re-check owner existence at connect time (temp token may be stale).
            await assertSignupAllowed();

            // Claim code guard before the outbound admin probe.
            assertClaimCode(claimCode);

            const adminCheck = await PlexClient.verifyServerAdmin(plexToken, serverUri);
            if (!adminCheck.success) {
              if (adminCheck.code === PlexClient.AdminVerifyError.CONNECTION_FAILED) {
                throw new APIError('SERVICE_UNAVAILABLE', { message: adminCheck.message });
              }
              throw new APIError('FORBIDDEN', { message: adminCheck.message });
            }

            const pmsClient = new PlexClient({ url: serverUri, token: plexToken });
            const localAccounts = await pmsClient.getUsers();
            const ownerLocalAccount = localAccounts.find((a) => a.isAdmin) ?? localAccounts[0];
            const ownerLocalId = ownerLocalAccount?.id ?? '1';

            let server = await db
              .select()
              .from(servers)
              .where(and(eq(servers.url, serverUri), eq(servers.type, 'plex')))
              .limit(1);

            if (server.length === 0) {
              const inserted = await db
                .insert(servers)
                .values({
                  name: serverName,
                  type: 'plex',
                  url: serverUri,
                  token: plexToken,
                  machineIdentifier: clientIdentifier,
                })
                .returning();
              server = inserted;
            } else {
              const existingServer = server[0]!;
              await db
                .update(servers)
                .set({
                  token: plexToken,
                  updatedAt: new Date(),
                  ...(clientIdentifier && !existingServer.machineIdentifier
                    ? { machineIdentifier: clientIdentifier }
                    : {}),
                })
                .where(eq(servers.id, existingServer.id));
            }
            invalidateServersCache();

            const serverId = server[0]!.id;

            const [newUser] = await db
              .insert(users)
              .values({
                username: plexUsername,
                email: plexEmail,
                thumbnail: plexThumb,
                plexAccountId,
                role: 'owner',
              })
              .returning();

            if (!newUser) {
              throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create user' });
            }

            const [newPlexAccount] = await db
              .insert(plexAccounts)
              .values({
                userId: newUser.id,
                plexAccountId,
                plexUsername,
                plexEmail,
                plexThumbnail: plexThumb,
                plexToken,
                allowLogin: true,
              })
              .returning();

            if (!newPlexAccount) {
              ctx.context.logger.error('Failed to create plex_account entry', {
                plexAccountId,
                userId: newUser.id,
              });
              throw new APIError('INTERNAL_SERVER_ERROR', {
                message: 'Failed to link Plex account',
              });
            }

            await upsertPlexAuthAccount(newUser.id, plexAccountId, {
              token: plexToken,
              tokenKind: plexTokenKind ?? 'legacy',
              refreshToken: plexRefreshToken ?? null,
              expiresAt: plexTokenExpiresAt ? new Date(plexTokenExpiresAt) : null,
            });

            await db
              .update(servers)
              .set({ plexAccountId: newPlexAccount.id })
              .where(eq(servers.id, serverId));
            invalidateServersCache();

            await db.insert(serverUsers).values({
              userId: newUser.id,
              serverId,
              externalId: ownerLocalId,
              plexAccountId,
              username: plexUsername,
              email: plexEmail,
              thumbUrl: plexThumb,
              isServerAdmin: true,
            });

            // Consume the temp token now that records are committed.
            await getRedis().del(REDIS_KEYS.PLEX_TEMP_TOKEN(tempToken));

            ctx.context.logger.info('New Plex user with server created', {
              userId: newUser.id,
              serverId,
              role: 'owner',
            });

            syncServer(serverId, { syncUsers: true, syncLibraries: true })
              .then((result) => {
                ctx.context.logger.info('Auto-sync completed for Plex server', {
                  serverId,
                  usersAdded: result.usersAdded,
                  librariesSynced: result.librariesSynced,
                });
              })
              .catch((error) => {
                ctx.context.logger.error('Auto-sync failed for Plex server', {
                  err: error,
                  serverId,
                });
              });

            const { user: sessionUser } = await createPlexSession(ctx, newUser.id);
            return ctx.json({
              authorized: true,
              user: { id: sessionUser.id, username: newUser.username, role: 'owner' },
            });
          } catch (error) {
            if (error instanceof APIError) throw error;
            ctx.context.logger.error('Plex connect failed', { err: error });
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Failed to connect to Plex server',
            });
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;
