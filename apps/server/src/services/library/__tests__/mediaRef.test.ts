import { describe, it, expect } from 'vitest';
import { parseMediaRef } from '../mediaRef.js';

describe('parseMediaRef', () => {
  it('accepts a UUID', () => {
    const result = parseMediaRef('0198a4a2-1234-5678-90ab-cdef12345678');
    expect(result).toEqual({
      kind: 'uuid',
      id: '0198a4a2-1234-5678-90ab-cdef12345678',
    });
  });

  it('accepts UUID case-insensitively and normalizes to lowercase', () => {
    const result = parseMediaRef('0198A4A2-1234-5678-90AB-CDEF12345678');
    expect(result).toEqual({
      kind: 'uuid',
      id: '0198a4a2-1234-5678-90ab-cdef12345678',
    });
  });

  it('accepts movie:tmdb provider ref', () => {
    const result = parseMediaRef('movie:tmdb:584');
    expect(result).toEqual({
      kind: 'provider',
      mediaType: 'movie',
      provider: 'tmdb',
      id: '584',
    });
  });

  it('accepts episode:tvdb provider ref', () => {
    const result = parseMediaRef('episode:tvdb:9009579');
    expect(result).toEqual({
      kind: 'provider',
      mediaType: 'episode',
      provider: 'tvdb',
      id: '9009579',
    });
  });

  it('accepts show:imdb provider ref', () => {
    const result = parseMediaRef('show:imdb:tt0384766');
    expect(result).toEqual({
      kind: 'provider',
      mediaType: 'show',
      provider: 'imdb',
      id: 'tt0384766',
    });
  });

  it('rejects season provider refs', () => {
    expect(parseMediaRef('season:tvdb:1')).toBeNull();
  });

  it('rejects provider refs without media type', () => {
    expect(parseMediaRef('tmdb:584')).toBeNull();
  });

  it('rejects unknown provider', () => {
    expect(parseMediaRef('movie:anidb:1')).toBeNull();
  });

  it('rejects empty id', () => {
    expect(parseMediaRef('movie:tmdb:')).toBeNull();
  });

  it('rejects random strings', () => {
    expect(parseMediaRef('random string')).toBeNull();
    expect(parseMediaRef('not-a-ref')).toBeNull();
    expect(parseMediaRef('')).toBeNull();
  });

  it('rejects invalid UUID format', () => {
    expect(parseMediaRef('not-a-uuid')).toBeNull();
    expect(parseMediaRef('0198a4a2-1234-5678-90ab')).toBeNull();
  });
});
