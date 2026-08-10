/**
 * ServerUser factory for test data generation
 *
 * Creates server_users that link users to specific media servers.
 */

import { executeRawSql } from '../db/pool.js';

export interface ServerUserData {
  id?: string;
  userId: string;
  serverId: string;
  externalId?: string;
  username?: string;
  email?: string | null;
  thumbUrl?: string | null;
  isServerAdmin?: boolean;
  trustScore?: number;
  lastActivityAt?: Date | null;
  removedAt?: Date | null;
}

export interface CreatedServerUser extends Required<
  Omit<ServerUserData, 'email' | 'thumbUrl' | 'lastActivityAt' | 'removedAt'>
> {
  id: string;
  email: string | null;
  thumbUrl: string | null;
  lastActivityAt: Date | null;
  removedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

let serverUserCounter = 0;

/**
 * Generate unique server user data with defaults
 */
export function buildServerUser(overrides: ServerUserData): Required<ServerUserData> {
  const index = ++serverUserCounter;
  return {
    id: overrides.id ?? crypto.randomUUID(),
    userId: overrides.userId,
    serverId: overrides.serverId,
    externalId: overrides.externalId ?? `external-user-${index}`,
    username: overrides.username ?? `serveruser${index}`,
    email: overrides.email ?? null,
    thumbUrl: overrides.thumbUrl ?? null,
    isServerAdmin: overrides.isServerAdmin ?? false,
    trustScore: overrides.trustScore ?? 100,
    lastActivityAt: overrides.lastActivityAt ?? null,
    removedAt: overrides.removedAt ?? null,
  };
}

/**
 * Create a server user in the database
 */
export async function createTestServerUser(data: ServerUserData): Promise<CreatedServerUser> {
  const fullData = buildServerUser(data);

  const result = await executeRawSql(`
    INSERT INTO server_users (
      id, user_id, server_id, external_id, username, email,
      thumb_url, is_server_admin, trust_score, last_activity_at, removed_at
    ) VALUES (
      '${fullData.id}',
      '${fullData.userId}',
      '${fullData.serverId}',
      '${fullData.externalId}',
      '${fullData.username}',
      ${fullData.email ? `'${fullData.email}'` : 'NULL'},
      ${fullData.thumbUrl ? `'${fullData.thumbUrl}'` : 'NULL'},
      ${fullData.isServerAdmin},
      ${fullData.trustScore},
      ${fullData.lastActivityAt ? `'${fullData.lastActivityAt.toISOString()}'` : 'NULL'},
      ${fullData.removedAt ? `'${fullData.removedAt.toISOString()}'` : 'NULL'}
    )
    RETURNING *
  `);

  return mapServerUserRow(result.rows[0]);
}

/**
 * Create a server admin user
 */
export async function createTestServerAdmin(data: ServerUserData): Promise<CreatedServerUser> {
  return createTestServerUser({
    ...data,
    isServerAdmin: true,
  });
}

/**
 * Map database row to typed server user object
 */
function mapServerUserRow(row: Record<string, unknown>): CreatedServerUser {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    serverId: row.server_id as string,
    externalId: row.external_id as string,
    username: row.username as string,
    email: row.email as string | null,
    thumbUrl: row.thumb_url as string | null,
    isServerAdmin: row.is_server_admin as boolean,
    trustScore: row.trust_score as number,
    lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at as string) : null,
    removedAt: row.removed_at as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Reset server user counter
 */
export function resetServerUserCounter(): void {
  serverUserCounter = 0;
}
