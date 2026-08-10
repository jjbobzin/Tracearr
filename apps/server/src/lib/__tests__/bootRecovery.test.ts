import { describe, it, expect } from 'vitest';
import { pickRecoveryIntervalMs } from '../bootRecovery.js';

describe('pickRecoveryIntervalMs', () => {
  it('uses the connectivity interval for a plain connectivity failure', () => {
    expect(pickRecoveryIntervalMs('connectivity', 10_000, 60_000)).toBe(10_000);
  });

  it('uses the (slower) migration interval for a migration/init failure', () => {
    expect(pickRecoveryIntervalMs('migration', 10_000, 60_000)).toBe(60_000);
  });
});
