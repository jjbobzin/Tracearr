/**
 * Settings cache tests
 *
 * getSetting() is read once per server per poll tick (getGeoIPSettings), so
 * results are cached in-process. Verifies write-through updates from
 * setSetting/setSettings and the TTL fallback for multi-instance staleness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockDbSelect = vi.fn();
const mockDbInsertValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn();

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: () => ({ values: mockDbInsertValues }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: () => ({ values: mockDbInsertValues }),
      };
      await fn(tx);
    },
  },
}));

vi.mock('../../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

import { getGeoIPSettings, getSetting, resetSettingsCache, setSetting } from '../settings.js';

function mockSettingRow(value: unknown) {
  mockRows(value === undefined ? [] : [{ value }]);
}

function mockRows<T>(rows: T[]) {
  const whereResult = Promise.resolve(rows) as Promise<T[]> & { limit: () => Promise<T[]> };
  whereResult.limit = () => Promise.resolve(rows);
  mockDbSelect.mockReturnValue({
    from: () => ({
      where: () => whereResult,
    }),
  });
}

describe('settings cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSettingsCache();
    mockDbInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
    mockOnConflictDoUpdate.mockResolvedValue(undefined);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the cache for repeated single-setting reads within the TTL', async () => {
    mockSettingRow(true);

    await getSetting('usePlexGeoip');
    await getSetting('usePlexGeoip');
    await getGeoIPSettings();

    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });

  it('reflects a setSetting write immediately in-process, within one write', async () => {
    mockSettingRow(false);
    const before = await getGeoIPSettings();
    expect(before.usePlexGeoip).toBe(false);

    await setSetting('usePlexGeoip', true);

    const after = await getGeoIPSettings();
    expect(after.usePlexGeoip).toBe(true);
    // The write-through cache update means no extra SELECT was needed.
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL expires even without an explicit write', async () => {
    mockSettingRow(false);
    await getSetting('usePlexGeoip');
    expect(mockDbSelect).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_001);

    mockSettingRow(true);
    const value = await getSetting('usePlexGeoip');
    expect(value).toBe(true);
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });

  it('returns local GeoIP settings as part of getGeoIPSettings', async () => {
    mockRows([
      { name: 'usePlexGeoip', value: true },
      { name: 'localLocationName', value: 'Home' },
      { name: 'localCity', value: 'Denver' },
      { name: 'localRegion', value: 'Colorado' },
      { name: 'localCountry', value: 'United States' },
      { name: 'localCountryCode', value: 'US' },
      { name: 'localLatitude', value: 39.7392 },
      { name: 'localLongitude', value: -104.9903 },
    ]);

    await expect(getGeoIPSettings()).resolves.toEqual({
      usePlexGeoip: true,
      localLocationName: 'Home',
      localCity: 'Denver',
      localRegion: 'Colorado',
      localCountry: 'United States',
      localCountryCode: 'US',
      localLatitude: 39.7392,
      localLongitude: -104.9903,
    });
  });
});
