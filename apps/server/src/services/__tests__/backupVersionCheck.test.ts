import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({
  db: {},
  runMigrations: vi.fn(),
  closeDatabase: vi.fn(),
  recreatePool: vi.fn(),
}));
vi.mock('../settings.js', () => ({
  getSetting: vi.fn(),
}));

import { backupVersionIsNewer } from '../backup.js';

describe('backupVersionIsNewer', () => {
  it('accepts an older-major prerelease backup on a newer-major prerelease install', () => {
    expect(backupVersionIsNewer('v1.5.0-beta.7', 'v2.0.0-beta.1')).toBe(false);
  });

  it('accepts a stable backup on the same-base stable install', () => {
    expect(backupVersionIsNewer('v1.5.0', 'v1.5.0')).toBe(false);
  });

  it('accepts an older stable backup on a newer stable install', () => {
    expect(backupVersionIsNewer('v1.4.2', 'v1.5.0')).toBe(false);
  });

  it('rejects a newer-major backup on an older install', () => {
    expect(backupVersionIsNewer('v2.0.0-beta.1', 'v1.5.0')).toBe(true);
  });

  it('rejects a stable backup on a prerelease install of the same base', () => {
    expect(backupVersionIsNewer('v2.0.0', 'v2.0.0-beta.1')).toBe(true);
  });

  it('rejects a newer prerelease backup on an older prerelease install', () => {
    expect(backupVersionIsNewer('v2.0.0-beta.2', 'v2.0.0-beta.1')).toBe(true);
  });
});
