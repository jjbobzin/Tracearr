/**
 * selectGrowthFit: the growth regression must never fit across the
 * multi-version changeover stamp. Post-stamp data wins once it spans the
 * minimum; until then the pre-stamp side stands in for the slope while
 * postDaysSpanned keeps driving the predictions countdown.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/client.js', () => ({ db: { execute: vi.fn() } }));
vi.mock('../../../services/settings.js', () => ({ getSetting: vi.fn() }));

import { selectGrowthFit } from '../storage.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2026, 6, 1);

function rows(count: number, startOffsetDays = 0): Array<{ day: string }> {
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(BASE + (startOffsetDays + i) * DAY_MS).toISOString().slice(0, 10),
  }));
}

const stampAt = (offsetDays: number) => BASE + offsetDays * DAY_MS;

describe('selectGrowthFit', () => {
  it('fits the full window when no stamp is set', () => {
    const input = rows(30);
    const fit = selectGrowthFit(input, null, 7);
    expect(fit.fitRows).toEqual(input);
    expect(fit.basis).toBe('current');
    expect(fit.postDaysSpanned).toBe(30);
  });

  it('fits the full window when every row is post-stamp', () => {
    const input = rows(30, 10);
    const fit = selectGrowthFit(input, stampAt(5), 7);
    expect(fit.fitRows).toEqual(input);
    expect(fit.basis).toBe('current');
    expect(fit.postDaysSpanned).toBe(30);
  });

  it('clamps to the post-stamp side once it spans the minimum', () => {
    const input = rows(30);
    const fit = selectGrowthFit(input, stampAt(20), 7);
    expect(fit.basis).toBe('current');
    expect(fit.fitRows).toHaveLength(10);
    expect(fit.fitRows[0]!.day).toBe('2026-07-21');
    expect(fit.postDaysSpanned).toBe(10);
  });

  it('falls back to the pre-stamp side while the post side is short', () => {
    const input = rows(30);
    const fit = selectGrowthFit(input, stampAt(27), 7);
    expect(fit.basis).toBe('preChangeover');
    expect(fit.fitRows).toHaveLength(27);
    expect(fit.fitRows[fit.fitRows.length - 1]!.day).toBe('2026-07-27');
    // The countdown still reports the post side
    expect(fit.postDaysSpanned).toBe(3);
  });

  it('stays on the short post side when both sides are short', () => {
    const input = rows(8);
    const fit = selectGrowthFit(input, stampAt(4), 7);
    expect(fit.basis).toBe('current');
    expect(fit.fitRows).toHaveLength(4);
    expect(fit.postDaysSpanned).toBe(4);
  });

  it('handles an empty window', () => {
    const fit = selectGrowthFit([], stampAt(5), 7);
    expect(fit.fitRows).toEqual([]);
    expect(fit.basis).toBe('current');
    expect(fit.postDaysSpanned).toBe(0);
  });
});
