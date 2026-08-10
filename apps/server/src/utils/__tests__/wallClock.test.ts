import { describe, expect, it } from 'vitest';
import { wallTimeToUtc } from '../wallClock.js';

describe('wallTimeToUtc', () => {
  it('converts UTC wall time identically', () => {
    expect(wallTimeToUtc('2026-01-15 12:30:45', 'UTC').toISOString()).toBe(
      '2026-01-15T12:30:45.000Z'
    );
  });

  it('converts a New York winter wall time (UTC-5)', () => {
    expect(wallTimeToUtc('2026-01-15 20:00:00', 'America/New_York').toISOString()).toBe(
      '2026-01-16T01:00:00.000Z'
    );
  });

  it('converts a New York summer wall time (UTC-4, DST)', () => {
    expect(wallTimeToUtc('2026-07-15 20:00:00', 'America/New_York').toISOString()).toBe(
      '2026-07-16T00:00:00.000Z'
    );
  });

  it('handles a positive-offset zone', () => {
    expect(wallTimeToUtc('2026-06-01 09:00:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-06-01T07:00:00.000Z'
    );
  });

  it('resolves a nonexistent spring-forward time without throwing', () => {
    // 2026-03-08 02:30 does not exist in New York; accept either adjacent interpretation
    const result = wallTimeToUtc('2026-03-08 02:30:00', 'America/New_York');
    expect(Number.isNaN(result.getTime())).toBe(false);
    const iso = result.toISOString();
    expect(['2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z']).toContain(iso);
  });

  it('accepts a T separator', () => {
    expect(wallTimeToUtc('2026-01-15T12:30:45', 'UTC').toISOString()).toBe(
      '2026-01-15T12:30:45.000Z'
    );
  });

  it('returns an invalid date for garbage', () => {
    expect(Number.isNaN(wallTimeToUtc('not a date', 'UTC').getTime())).toBe(true);
  });
});
