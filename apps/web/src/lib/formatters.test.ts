import { describe, expect, it } from 'vitest';
import { compactCount, formatCompactAge } from './formatters';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

describe('formatCompactAge', () => {
  it('formats an age under 24 hours in hours', () => {
    expect(formatCompactAge(hoursAgo(14))).toBe('14h');
  });

  it('formats an age under 60 days in days', () => {
    expect(formatCompactAge(daysAgo(5))).toBe('5d');
  });

  it('formats an age of 60+ days but under 52 weeks in weeks', () => {
    expect(formatCompactAge(daysAgo(105))).toBe('15w');
  });

  it('formats an age of 52+ weeks but under 12 months in months', () => {
    expect(formatCompactAge(daysAgo(365))).toBe('11mo');
  });

  it('formats an age of 12+ months in years', () => {
    expect(formatCompactAge(daysAgo(800))).toBe('2y');
  });

  it('falls back to a dash for an empty date string', () => {
    expect(formatCompactAge('')).toBe('-');
  });

  it('falls back to a dash for an unparseable date string', () => {
    expect(formatCompactAge('not-a-date')).toBe('-');
  });

  it('falls back to a dash for a null date', () => {
    expect(formatCompactAge(null)).toBe('-');
  });
});

describe('compactCount', () => {
  it('leaves values under 1000 unchanged', () => {
    expect(compactCount(999)).toBe('999');
    expect(compactCount(0)).toBe('0');
  });

  it('formats thousands with one decimal, trimmed when whole', () => {
    expect(compactCount(1204)).toBe('1.2k');
    expect(compactCount(1000)).toBe('1k');
  });

  it('formats millions', () => {
    expect(compactCount(3_400_000)).toBe('3.4M');
  });

  it('formats billions', () => {
    expect(compactCount(2_000_000_000)).toBe('2B');
  });
});
