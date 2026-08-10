import { describe, it, expect } from 'vitest';
import {
  liveStatsExtremes,
  withGaps,
  zeroFillSeconds,
  LIVE_STATS_WINDOW_MS,
} from './liveStatsAxis';

describe('liveStatsExtremes', () => {
  it('holds the right edge behind real time so the newest region stays filled', () => {
    const { min, max } = liveStatsExtremes(1_000_000);

    expect(max).toBeLessThan(1_000_000);
    expect(max - min).toBe(LIVE_STATS_WINDOW_MS);
  });

  it('keeps the window a fixed width as it slides', () => {
    const a = liveStatsExtremes(1_000_000);
    const b = liveStatsExtremes(1_001_000);

    expect(b.max - a.max).toBe(1000);
    expect(b.min - a.min).toBe(1000);
  });
});

describe('withGaps', () => {
  const at = (s: number, y: number): [number, number | null] => [s * 1000, y];

  it('leaves evenly spaced points untouched', () => {
    const points = [at(0, 1), at(5, 2), at(10, 3)];
    expect(withGaps(points, 15)).toEqual(points);
  });

  it('breaks the line only past the threshold', () => {
    const points = [at(0, 1), at(40, 2)];
    const result = withGaps(points, 15);

    expect(result).toHaveLength(3);
    expect(result[1]).toEqual([1, null]);
  });

  it('tolerates a gap exactly at the threshold', () => {
    expect(withGaps([at(0, 1), at(15, 2)], 15)).toHaveLength(2);
  });

  it('does not prepend a null before the first point', () => {
    expect(withGaps([at(99, 1)], 15)).toEqual([at(99, 1)]);
  });

  it('returns empty for empty input', () => {
    expect(withGaps([], 15)).toEqual([]);
  });
});

describe('zeroFillSeconds', () => {
  const at = (s: number, y: number): [number, number] => [s * 1000, y];

  it('fills idle seconds with zero rather than leaving gaps', () => {
    const result = zeroFillSeconds([at(10, 500), at(13, 900)], 120);

    expect(result).toEqual([at(10, 500), at(11, 0), at(12, 0), at(13, 900)]);
  });

  it('fills the whole retained span, not just the visible window', () => {
    // Clipping to the window leaves the chart's left wall bare, since the
    // wall sits further back than `newest - window`
    const result = zeroFillSeconds([at(0, 1), at(130, 2)], 136);

    expect(result[0]).toEqual(at(0, 1));
    expect(result).toHaveLength(131);
  });

  it('still caps the fill for a stale outlier', () => {
    const result = zeroFillSeconds([at(0, 1), at(500, 2)], 136);

    expect(result[0]?.[0]).toBe(364 * 1000);
  });

  it('handles descending input without silently returning nothing', () => {
    const result = zeroFillSeconds([at(13, 900), at(10, 500)], 120);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual(at(10, 500));
  });

  it('returns empty for empty input', () => {
    expect(zeroFillSeconds([], 120)).toEqual([]);
  });
});
