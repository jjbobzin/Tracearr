import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: { select: vi.fn() } }));

import { db } from '../../db/client.js';
import { hashSha256 } from '../hash.js';
import { isKnownPublicApiToken, resetPublicApiTokenCache } from '../publicApiTokenCache.js';

function mockUsersQuery(result: Array<{ apiToken: string | null }>) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

function mockUsersQueryError(error: Error) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockRejectedValue(error),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

describe('isKnownPublicApiToken', () => {
  beforeEach(() => {
    resetPublicApiTokenCache();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches a token present in the users table', async () => {
    mockUsersQuery([{ apiToken: 'trr_pub_real' }]);
    await expect(isKnownPublicApiToken('trr_pub_real')).resolves.toBe(true);
  });

  it('rejects a token that is not configured on any user', async () => {
    mockUsersQuery([{ apiToken: 'trr_pub_real' }]);
    await expect(isKnownPublicApiToken('trr_pub_fake')).resolves.toBe(false);
  });

  it('serves subsequent lookups from the snapshot without re-querying', async () => {
    const chain = mockUsersQuery([{ apiToken: 'trr_pub_real' }]);
    await isKnownPublicApiToken('trr_pub_real');
    await isKnownPublicApiToken('trr_pub_real');
    await isKnownPublicApiToken('trr_pub_other');
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('refreshes the snapshot once the TTL elapses', async () => {
    vi.useFakeTimers();
    mockUsersQuery([{ apiToken: 'trr_pub_real' }]);
    await isKnownPublicApiToken('trr_pub_real');

    vi.advanceTimersByTime(30_001);
    const chain = mockUsersQuery([{ apiToken: 'trr_pub_new' }]);
    await expect(isKnownPublicApiToken('trr_pub_new')).resolves.toBe(true);
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the DB errors on the first-ever load', async () => {
    mockUsersQueryError(new Error('db down'));
    await expect(isKnownPublicApiToken('trr_pub_real')).resolves.toBe(false);
  });

  it('falls back to the last good snapshot when a refresh errors', async () => {
    vi.useFakeTimers();
    mockUsersQuery([{ apiToken: 'trr_pub_real' }]);
    await isKnownPublicApiToken('trr_pub_real');

    vi.advanceTimersByTime(30_001);
    mockUsersQueryError(new Error('db down'));
    await expect(isKnownPublicApiToken('trr_pub_real')).resolves.toBe(true);
  });

  it('never caches a raw token, only its hash', async () => {
    const token = 'trr_pub_real';
    mockUsersQuery([{ apiToken: token }]);
    await isKnownPublicApiToken(token);
    // Regression guard: the cache key space is hashes, not plaintext -
    // a lookup for the hash itself must never match.
    await expect(isKnownPublicApiToken(hashSha256(token))).resolves.toBe(false);
  });
});
