import { describe, it, expect } from 'vitest';
import { computeVersionsFingerprint, pickBestVersion, sumVersionSizes } from '../versionUtils.js';
import type { MediaItemVersion } from '../../types.js';

const version = (overrides: Partial<MediaItemVersion>): MediaItemVersion => ({
  serverVersionKey: 'v1',
  partCount: 1,
  ...overrides,
});

describe('computeVersionsFingerprint', () => {
  it('is order-insensitive', () => {
    const a = version({ serverVersionKey: 'a', fileSize: 100, videoResolution: '4k' });
    const b = version({ serverVersionKey: 'b', fileSize: 200, videoResolution: '1080p' });

    expect(computeVersionsFingerprint([a, b])).toBe(computeVersionsFingerprint([b, a]));
  });

  it('changes when a version is added, removed, or resized', () => {
    const a = version({ serverVersionKey: 'a', fileSize: 100 });
    const b = version({ serverVersionKey: 'b', fileSize: 200 });

    const both = computeVersionsFingerprint([a, b]);
    expect(computeVersionsFingerprint([a])).not.toBe(both);
    expect(
      computeVersionsFingerprint([a, version({ serverVersionKey: 'b', fileSize: 201 })])
    ).not.toBe(both);
  });

  it('hashes the empty set to a stable value', () => {
    expect(computeVersionsFingerprint([])).toBe(computeVersionsFingerprint([]));
  });

  it('changes when any version-only field changes (path, audio, container, bitrate)', () => {
    const base = version({ serverVersionKey: 'a', fileSize: 100, filePath: '/x.mkv' });
    const fp = (v: Parameters<typeof computeVersionsFingerprint>[0][number]) =>
      computeVersionsFingerprint([v]);

    // These fields have no flat library_items mirror; the fingerprint is the
    // only signal that can trigger their rows' rewrite
    expect(fp({ ...base, filePath: '/renamed.mkv' })).not.toBe(fp(base));
    expect(fp({ ...base, audioCodec: 'TRUEHD' })).not.toBe(fp(base));
    expect(fp({ ...base, audioChannels: 8 })).not.toBe(fp(base));
    expect(fp({ ...base, container: 'mp4' })).not.toBe(fp(base));
    expect(fp({ ...base, bitrate: 20000 })).not.toBe(fp(base));
    expect(fp({ ...base, videoDynamicRange: 'hdr10' })).not.toBe(fp(base));
    expect(fp({ ...base, partCount: 2 })).not.toBe(fp(base));
  });
});

describe('pickBestVersion', () => {
  it('prefers the higher resolution tier', () => {
    const best = pickBestVersion([
      version({ serverVersionKey: 'a', videoResolution: '1080p' }),
      version({ serverVersionKey: 'b', videoResolution: '4k' }),
    ]);

    expect(best?.serverVersionKey).toBe('b');
  });

  it('breaks resolution ties by bitrate, then version key', () => {
    const byBitrate = pickBestVersion([
      version({ serverVersionKey: 'a', videoResolution: '4k', bitrate: 15467 }),
      version({ serverVersionKey: 'b', videoResolution: '4k', bitrate: 15512 }),
    ]);
    expect(byBitrate?.serverVersionKey).toBe('b');

    const byKey = pickBestVersion([
      version({ serverVersionKey: 'b', videoResolution: '4k', bitrate: 15000 }),
      version({ serverVersionKey: 'a', videoResolution: '4k', bitrate: 15000 }),
    ]);
    expect(byKey?.serverVersionKey).toBe('a');
  });

  it('ranks 1440p above 1080p', () => {
    const best = pickBestVersion([
      version({ serverVersionKey: 'a', videoResolution: '1080p' }),
      version({ serverVersionKey: 'b', videoResolution: '1440p' }),
    ]);

    expect(best?.serverVersionKey).toBe('b');
  });

  it('returns undefined for an empty list', () => {
    expect(pickBestVersion([])).toBeUndefined();
  });
});

describe('sumVersionSizes', () => {
  it('sums across versions and ignores missing sizes', () => {
    expect(
      sumVersionSizes([
        version({ serverVersionKey: 'a', fileSize: 100 }),
        version({ serverVersionKey: 'b' }),
        version({ serverVersionKey: 'c', fileSize: 50 }),
      ])
    ).toBe(150);
  });

  it('returns undefined when no version carries a size', () => {
    expect(sumVersionSizes([version({ serverVersionKey: 'a' })])).toBeUndefined();
    expect(sumVersionSizes([])).toBeUndefined();
  });
});
