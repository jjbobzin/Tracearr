import { describe, it, expect } from 'vitest';
import {
  classifyByDimensions,
  normalizeResolutionLabel,
  normalizeResolution,
  resolutionTierRank,
  resolutionBucket,
  resolutionBucketSpellings,
  resolutionAboveSdSpellings,
  resolutionSpellingRanks,
  RESOLUTION_TIERS,
} from '../resolution.js';

describe('classifyByDimensions', () => {
  // Golden table - see docs for the underlying research (jellyfin-web /
  // Radarr / Sonarr "closest resolution" bands).
  it.each([
    [1916, 1036, '1080p'], // Issue #798: near-cutoff widescreen source
    [1920, 804, '1080p'],
    [1440, 1080, '1080p'], // 4:3 aspect ratio
    [1920, 1080, '1080p'],
    [1800, 1, '1080p'], // exact width threshold
    [1490, 1, '720p'],
    [1280, 536, '720p'], // widescreen scope at 720p
    [1280, 720, '720p'],
    [3840, 2160, '4K'],
    [3840, 1600, '4K'],
    [3800, 1, '4K'], // exact width threshold
    [2560, 1440, '1440p'],
    [720, 480, '480p'],
  ])('classifies %ix%i as %s', (width, height, expected) => {
    expect(classifyByDimensions(width, height)).toBe(expected);
  });

  it('uses height alone when width is missing', () => {
    expect(classifyByDimensions(null, 1080)).toBe('1080p');
  });

  it('uses width alone when height is missing', () => {
    expect(classifyByDimensions(1920, null)).toBe('1080p');
  });

  it('returns SD below every band', () => {
    expect(classifyByDimensions(320, 240)).toBe('SD');
  });

  it('returns 8K for the extended top band', () => {
    expect(classifyByDimensions(7680, 4320)).toBe('8K');
    expect(classifyByDimensions(6400, 1)).toBe('8K');
  });

  it('returns null when no dimensions are provided', () => {
    expect(classifyByDimensions(null, null)).toBeNull();
    expect(classifyByDimensions(undefined, undefined)).toBeNull();
  });
});

describe('normalizeResolutionLabel', () => {
  it('maps known Plex/Tautulli labels to the app vocabulary', () => {
    expect(normalizeResolutionLabel('sd')).toBe('SD');
    expect(normalizeResolutionLabel('480')).toBe('480p');
    expect(normalizeResolutionLabel('576')).toBe('576p');
    expect(normalizeResolutionLabel('720')).toBe('720p');
    expect(normalizeResolutionLabel('1080')).toBe('1080p');
    expect(normalizeResolutionLabel('4k')).toBe('4K');
    expect(normalizeResolutionLabel('8k')).toBe('8K');
    expect(normalizeResolutionLabel('2k')).toBe('1440p');
  });

  it('is case insensitive', () => {
    expect(normalizeResolutionLabel('4K')).toBe('4K');
    expect(normalizeResolutionLabel('SD')).toBe('SD');
    expect(normalizeResolutionLabel('1080P')).toBe('1080p');
  });

  it('adds a p suffix to unmapped numeric labels', () => {
    expect(normalizeResolutionLabel('540')).toBe('540p');
  });

  it('passes through unrecognized non-numeric labels unchanged', () => {
    expect(normalizeResolutionLabel('custom')).toBe('custom');
  });

  it('returns null for missing/empty labels', () => {
    expect(normalizeResolutionLabel(undefined)).toBeNull();
    expect(normalizeResolutionLabel(null)).toBeNull();
    expect(normalizeResolutionLabel('')).toBeNull();
  });
});

describe('normalizeResolution (label-first precedence)', () => {
  it('uses the label when present, even with dimensions available', () => {
    // Issue #798: Plex already says 1080p - trust it instead of recomputing
    expect(normalizeResolution({ label: '1080', width: 1916, height: 1036 })).toBe('1080p');
  });

  it('never lets dimensions downgrade a present label', () => {
    // A label that would round DOWN compared to dimensions should still win
    expect(normalizeResolution({ label: '720', width: 1916, height: 1036 })).toBe('720p');
  });

  it('falls back to dimensions when no label is present', () => {
    expect(normalizeResolution({ width: 1916, height: 1036 })).toBe('1080p');
  });

  it('falls back to dimensions when the label is empty', () => {
    expect(normalizeResolution({ label: '', width: 1280, height: 720 })).toBe('720p');
  });

  it('returns null when nothing is provided', () => {
    expect(normalizeResolution({})).toBeNull();
  });
});

describe('resolutionTierRank', () => {
  it('ranks known tiers in ascending quality order', () => {
    expect(resolutionTierRank('SD')).toBe(RESOLUTION_TIERS.SD);
    expect(resolutionTierRank('480p')).toBe(RESOLUTION_TIERS['480p']);
    expect(resolutionTierRank('1080')).toBe(RESOLUTION_TIERS['1080p']);
    expect(resolutionTierRank('4k')).toBe(RESOLUTION_TIERS['4K']);
    expect(resolutionTierRank('8k')).toBe(RESOLUTION_TIERS['8K']);
    expect(resolutionTierRank('4k')).toBeGreaterThan(resolutionTierRank('1080p')!);
  });

  it('returns null for unknown labels', () => {
    expect(resolutionTierRank('576')).toBeNull();
    expect(resolutionTierRank(undefined)).toBeNull();
  });
});

describe('resolutionBucket', () => {
  it('folds tiers above 1080p into the 4k bucket', () => {
    expect(resolutionBucket('4k')).toBe('4k');
    expect(resolutionBucket('1440p')).toBe('4k');
    expect(resolutionBucket('8k')).toBe('4k');
    expect(resolutionBucket('2160')).toBe('4k');
  });

  it('maps exact tiers to their own buckets', () => {
    expect(resolutionBucket('1080p')).toBe('1080p');
    expect(resolutionBucket('720p')).toBe('720p');
    expect(resolutionBucket('480p')).toBe('sd');
    expect(resolutionBucket('sd')).toBe('sd');
  });

  it('counts unknown non-null labels as sd and keeps null as null', () => {
    expect(resolutionBucket('576')).toBe('sd');
    expect(resolutionBucket('weird')).toBe('sd');
    expect(resolutionBucket(null)).toBeNull();
    expect(resolutionBucket(undefined)).toBeNull();
  });
});

describe('resolution bucket spellings', () => {
  it('partitions spellings without overlap', () => {
    const s4k = resolutionBucketSpellings('4k');
    const s1080 = resolutionBucketSpellings('1080p');
    const s720 = resolutionBucketSpellings('720p');

    expect(s4k).toContain('1440p');
    expect(s4k).toContain('8k');
    expect(s1080).toContain('1080');
    expect(s720).toContain('hd');
    expect(new Set([...s4k, ...s1080, ...s720]).size).toBe(s4k.length + s1080.length + s720.length);
    expect(new Set(resolutionAboveSdSpellings())).toEqual(new Set([...s4k, ...s1080, ...s720]));
  });

  it('agrees with resolutionBucket for every known spelling', () => {
    for (const { spelling, rank } of resolutionSpellingRanks()) {
      expect(rank).toBe(resolutionTierRank(spelling) ?? 0);
      const bucket = resolutionBucket(spelling);
      if (bucket === 'sd') {
        expect(resolutionAboveSdSpellings()).not.toContain(spelling);
      } else {
        expect(resolutionBucketSpellings(bucket!)).toContain(spelling);
      }
    }
  });
});
