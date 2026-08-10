/**
 * The letter-jump contract, end to end in grid terms: rail counts become
 * cumulative offsets, a jump is one scrollToItem into the fixed-total scroll
 * space, and live letter tracking derives from the viewport's top item and
 * those same offsets - no loaded rows required for either direction.
 */

import { describe, it, expect } from 'vitest';
import type { CatalogLetterBucket } from '@tracearr/shared';
import {
  buildLetterOffsets,
  activeLetterForItem,
  pageIndicesForRange,
  CATALOG_PAGE_SIZE,
} from '@/hooks/queries/useMediaBrowse';
import { computeViewportInfo } from './VirtualPosterGrid';

function bucketsFrom(counts: Record<string, number>): CatalogLetterBucket[] {
  return ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')].map((letter) => ({
    letter,
    count: counts[letter] ?? 0,
  }));
}

describe('buildLetterOffsets', () => {
  it('accumulates starts across the # then A-Z rail order', () => {
    const offsets = buildLetterOffsets(bucketsFrom({ '#': 2, A: 3, C: 5 }));
    expect(offsets[0]).toEqual({ letter: '#', count: 2, start: 0 });
    expect(offsets[1]).toEqual({ letter: 'A', count: 3, start: 2 });
    expect(offsets[2]).toEqual({ letter: 'B', count: 0, start: 5 });
    expect(offsets[3]).toEqual({ letter: 'C', count: 5, start: 5 });
    expect(offsets[4]).toEqual({ letter: 'D', count: 0, start: 10 });
  });
});

describe('activeLetterForItem', () => {
  const offsets = buildLetterOffsets(bucketsFrom({ '#': 2, A: 3, C: 5 }));

  it('resolves the bucket containing an item index', () => {
    expect(activeLetterForItem(0, offsets)).toBe('#');
    expect(activeLetterForItem(1, offsets)).toBe('#');
    expect(activeLetterForItem(2, offsets)).toBe('A');
    expect(activeLetterForItem(4, offsets)).toBe('A');
    expect(activeLetterForItem(5, offsets)).toBe('C');
    expect(activeLetterForItem(9, offsets)).toBe('C');
  });

  it('never resolves to an empty bucket, even at its boundary offset', () => {
    // Item 5 is B's start AND C's start; B has zero rows so C owns it.
    expect(activeLetterForItem(5, offsets)).toBe('C');
  });

  it('is null past the end, before offsets load, or for a negative index', () => {
    expect(activeLetterForItem(10, offsets)).toBeNull();
    expect(activeLetterForItem(0, undefined)).toBeNull();
    expect(activeLetterForItem(-1, offsets)).toBeNull();
  });
});

describe('jump -> viewport -> active letter round trip', () => {
  it('a jump offset lands the viewport inside the jumped bucket, unloaded rows and all', () => {
    const offsets = buildLetterOffsets(bucketsFrom({ '#': 10, A: 90, F: 40, Z: 5 }));
    const fStart = offsets.find((o) => o.letter === 'F')!.start;
    expect(fStart).toBe(100);

    // The grid scrolls the row containing item 100 to the top (4 columns:
    // row 25) and reports the viewport; live tracking must answer 'F' with
    // zero loaded rows.
    const columnCount = 4;
    const topRow = Math.floor(fStart / columnCount);
    const viewport = computeViewportInfo(topRow, topRow + 3, topRow, columnCount, 145);
    expect(viewport).not.toBeNull();
    expect(activeLetterForItem(viewport!.topItem, offsets)).toBe('F');
  });

  it('scrolling up from a jump needs only earlier page indices, never a query reset', () => {
    // Viewport sits at items 520-579 after a deep jump; scrolling up shifts
    // the rendered range to 460-519. The window model just asks for the
    // pages covering that range.
    expect(pageIndicesForRange(520, 579, null)).toEqual([8, 9]);
    expect(pageIndicesForRange(460, 519, null)).toEqual([7, 8]);
    expect(CATALOG_PAGE_SIZE).toBe(60);
  });
});

describe('pageIndicesForRange', () => {
  it('covers a range spanning multiple pages', () => {
    expect(pageIndicesForRange(0, 179, null)).toEqual([0, 1, 2]);
  });

  it('clamps to the known total', () => {
    expect(pageIndicesForRange(100, 500, 130)).toEqual([1, 2]);
  });

  it('clamps a negative start', () => {
    expect(pageIndicesForRange(-5, 10, null)).toEqual([0]);
  });

  it('collapses to the first page when the range sits before the total start', () => {
    expect(pageIndicesForRange(0, 0, 0)).toEqual([0]);
  });
});
