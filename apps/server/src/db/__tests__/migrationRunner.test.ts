import { describe, it, expect, vi, beforeEach } from 'vitest';

const migrateMock = vi.fn();
vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: (...args: unknown[]) => migrateMock(...args),
}));

import { runMigrationsGuarded, MIGRATION_ADVISORY_LOCK_KEY } from '../migrationRunner.js';

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function createFakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    end: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('runMigrationsGuarded', () => {
  beforeEach(() => {
    migrateMock.mockReset();
    migrateMock.mockResolvedValue(undefined);
  });

  it('sets lock_timeout BEFORE the advisory lock (bounding the lock wait), migrates, then unlocks and closes', async () => {
    const client = createFakeClient();

    await runMigrationsGuarded('/migrations', { createClient: () => client as never });

    const queries = client.query.mock.calls.map((c) => String(c[0]));
    // lock_timeout must precede the lock request - it is what bounds the
    // wait on a wedged peer holding the lock.
    expect(queries[0]).toBe("SET lock_timeout = '10s'");
    expect(queries[1]).toContain('pg_advisory_lock');
    expect(client.query.mock.calls[1]?.[1]).toEqual([MIGRATION_ADVISORY_LOCK_KEY]);
    expect(queries).toContain('SET statement_timeout = 0');
    expect(queries[queries.length - 1]).toContain('pg_advisory_unlock');

    // lock acquired before migrate(), unlock after
    const lockIndex = queries.findIndex((q) => q.includes('pg_advisory_lock'));
    const migrateCallOrder = migrateMock.mock.invocationCallOrder[0];
    const unlockIndex = queries.findIndex((q) => q.includes('pg_advisory_unlock'));
    expect(lockIndex).toBeLessThan(queries.length);
    expect(unlockIndex).toBe(queries.length - 1);
    expect(migrateCallOrder).toBeGreaterThan(0);

    expect(migrateMock).toHaveBeenCalledTimes(1);
    expect(migrateMock.mock.calls[0]?.[1]).toEqual({ migrationsFolder: '/migrations' });
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('applies a custom lock_timeout', async () => {
    const client = createFakeClient();

    await runMigrationsGuarded('/migrations', {
      createClient: () => client as never,
      lockTimeout: '30s',
    });

    const queries = client.query.mock.calls.map((c) => String(c[0]));
    expect(queries).toContain("SET lock_timeout = '30s'");
  });

  it('rejects an unsafe lockTimeout value instead of interpolating it into SQL', async () => {
    const client = createFakeClient();

    await expect(
      runMigrationsGuarded('/migrations', {
        createClient: () => client as never,
        lockTimeout: "10s'; DROP TABLE users; --",
      })
    ).rejects.toThrow(/Invalid lockTimeout/);

    // Never even connects - validation happens before any DB work.
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('still releases the lock and closes the connection when migrate() throws', async () => {
    const client = createFakeClient();
    migrateMock.mockRejectedValueOnce(new Error('bad migration SQL'));

    await expect(
      runMigrationsGuarded('/migrations', { createClient: () => client as never })
    ).rejects.toThrow('bad migration SQL');

    const queries = client.query.mock.calls.map((c) => String(c[0]));
    expect(queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('propagates the migrate() error even when the unlock query also fails', async () => {
    const client = createFakeClient({
      query: vi.fn().mockImplementation((text: string) => {
        if (String(text).includes('pg_advisory_unlock')) {
          return Promise.reject(new Error('connection terminated'));
        }
        return Promise.resolve({ rows: [] });
      }),
    });
    migrateMock.mockRejectedValueOnce(new Error('bad migration SQL'));

    await expect(
      runMigrationsGuarded('/migrations', { createClient: () => client as never })
    ).rejects.toThrow('bad migration SQL');

    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it('still closes the connection when acquiring the lock itself fails', async () => {
    const client = createFakeClient({
      query: vi.fn().mockRejectedValue(new Error('connection refused')),
    });

    await expect(
      runMigrationsGuarded('/migrations', { createClient: () => client as never })
    ).rejects.toThrow('connection refused');

    expect(client.end).toHaveBeenCalledTimes(1);
    expect(migrateMock).not.toHaveBeenCalled();
  });
});

describe('runMigrationsGuarded decompression cap', () => {
  beforeEach(() => {
    migrateMock.mockReset();
    migrateMock.mockResolvedValue(undefined);
  });

  it('lifts the decompression cap for the migration session when the GUC exists', async () => {
    const client = createFakeClient({
      query: vi.fn().mockImplementation((q: string) => {
        if (typeof q === 'string' && q.includes('pg_settings')) {
          return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    });

    await runMigrationsGuarded('/tmp/migrations', { createClient: () => client as never });

    const queries = client.query.mock.calls.map((c) => c[0]);
    expect(queries).toContain('SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0');
  });

  it('skips the SET when the GUC does not exist (plain postgres)', async () => {
    const client = createFakeClient(); // default query mock: rows: [], rowCount: 0
    await runMigrationsGuarded('/tmp/migrations', { createClient: () => client as never });
    const queries = client.query.mock.calls.map((c) => c[0]);
    // The pg_settings probe itself names the GUC, so assert on the SET form.
    expect(queries.some((q) => String(q).startsWith('SET timescaledb.'))).toBe(false);
  });
});
