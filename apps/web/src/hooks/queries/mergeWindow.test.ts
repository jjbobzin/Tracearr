import { describe, it, expect } from 'vitest';
import { mergeWindow } from './useServers';

const NOW = 1_000_000;
const point = (at: number) => ({ at, value: at });

function ref() {
  return { current: new Map<number, ReturnType<typeof point>>() };
}

describe('mergeWindow', () => {
  it('returns points oldest first', () => {
    const result = mergeWindow(ref(), [point(NOW), point(NOW - 10)], NOW, 120, 27);

    expect(result.map((p) => p.at)).toEqual([NOW - 10, NOW]);
  });

  it('accumulates across calls and dedupes by timestamp', () => {
    const window = ref();
    mergeWindow(window, [point(NOW - 10), point(NOW - 5)], NOW, 120, 27);
    const result = mergeWindow(window, [point(NOW - 5), point(NOW)], NOW, 120, 27);

    expect(result.map((p) => p.at)).toEqual([NOW - 10, NOW - 5, NOW]);
  });

  it('drops points older than the retained span', () => {
    const result = mergeWindow(ref(), [point(NOW - 400), point(NOW - 10)], NOW, 120, 32);

    expect(result.map((p) => p.at)).toEqual([NOW - 10]);
  });

  it('retains past the visible window, since the chart holds its edge back', () => {
    // A point just outside 120s is still on screen once the right edge is
    // delayed - dropping at exactly the window clears the left wall early
    const result = mergeWindow(ref(), [point(NOW - 125), point(NOW)], NOW, 120, 32);

    expect(result).toHaveLength(2);
  });

  it('caps at maxPoints, keeping the newest', () => {
    const points = Array.from({ length: 40 }, (_, i) => point(NOW - i));
    const result = mergeWindow(ref(), points, NOW, 120, 32);

    expect(result).toHaveLength(32);
    expect(result[result.length - 1]?.at).toBe(NOW);
  });

  it('does not let a future point evict the real window', () => {
    const window = ref();
    mergeWindow(window, [point(NOW - 10), point(NOW - 5)], NOW, 120, 32);

    // Ageing against the clock rather than the newest point means a server an
    // hour ahead can't become the anchor and clear everything real
    const result = mergeWindow(window, [point(NOW + 3600)], NOW, 120, 32);

    expect(result.map((p) => p.at)).toEqual([NOW - 10, NOW - 5, NOW + 3600]);
  });

  it('returns empty for an empty merge', () => {
    expect(mergeWindow(ref(), [], NOW, 120, 27)).toEqual([]);
  });
});
