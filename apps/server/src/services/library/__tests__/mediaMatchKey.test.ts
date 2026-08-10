import { describe, it, expect } from 'vitest';
import { normalizeTitle, buildMediaMatchKey, buildSortTitle } from '../mediaMatchKey.js';

const base = { serverId: 'srv-1', ratingKey: '42' };

describe('normalizeTitle', () => {
  it('keeps letters and numbers of any script, casefolded', () => {
    expect(normalizeTitle('2 Fast 2 Furious!')).toBe('2fast2furious');
    expect(normalizeTitle('Жила-была одна баба')).toBe('жилабылаоднабаба');
    expect(normalizeTitle('千と千尋の神隠し')).toBe('千と千尋の神隠し');
  });
  it('returns empty string for punctuation-only titles', () => {
    expect(normalizeTitle('***')).toBe('');
  });
});

describe('buildSortTitle', () => {
  it('strips a leading "the" before removing punctuation and casefolding', () => {
    expect(buildSortTitle('The Matrix')).toBe('matrix');
  });
  it('strips a leading "a"', () => {
    expect(buildSortTitle('A Quiet Place')).toBe('quietplace');
  });
  it('strips a leading "an"', () => {
    expect(buildSortTitle('An American Tail')).toBe('americantail');
  });
  it('leaves a title starting with "the" alone when there is no trailing whitespace to strip', () => {
    expect(buildSortTitle('Thelma')).toBe('thelma');
  });
  it('keeps accented letters', () => {
    expect(buildSortTitle('Amélie')).toBe('amélie');
  });
  it('leaves a purely numeric title alone', () => {
    expect(buildSortTitle('1984')).toBe('1984');
  });
  it('returns an empty string for an empty title', () => {
    expect(buildSortTitle('')).toBe('');
  });
  it('removes punctuation between words', () => {
    expect(buildSortTitle('Spider-Man: No Way Home')).toBe('spidermannowayhome');
  });
});

describe('buildMediaMatchKey', () => {
  it('namespaces provider keys by type with imdb > tmdb > tvdb precedence', () => {
    expect(
      buildMediaMatchKey({ ...base, mediaType: 'movie', imdbId: 'tt0322259', tmdbId: 584 })
    ).toBe('movie:imdb:tt0322259');
    expect(buildMediaMatchKey({ ...base, mediaType: 'show', tmdbId: 1891 })).toBe('show:tmdb:1891');
    expect(buildMediaMatchKey({ ...base, mediaType: 'movie', tvdbId: 155947 })).toBe(
      'movie:tvdb:155947'
    );
  });
  it('falls back to type:title:normalized:year, with 0 for null year', () => {
    expect(buildMediaMatchKey({ ...base, mediaType: 'movie', title: 'Crash', year: 2004 })).toBe(
      'movie:title:crash:2004'
    );
    expect(buildMediaMatchKey({ ...base, mediaType: 'movie', title: 'Crash', year: null })).toBe(
      'movie:title:crash:0'
    );
  });
  it('uses a non-matching local key when the normalized title is empty', () => {
    expect(buildMediaMatchKey({ ...base, mediaType: 'movie', title: '***' })).toBe(
      'local:srv-1:42'
    );
  });
  it('keys episodes by tvdb episode id first', () => {
    expect(buildMediaMatchKey({ ...base, mediaType: 'episode', tvdbId: 9009579 })).toBe(
      'episode:tvdb:9009579'
    );
  });
  it('keys ID-less episodes by show uuid composite, excluding season 0', () => {
    expect(
      buildMediaMatchKey({
        ...base,
        mediaType: 'episode',
        showMediaId: 'a-b-c',
        seasonNumber: 1,
        episodeNumber: 5,
      })
    ).toBe('episode:a-b-c:s1e5');
    expect(
      buildMediaMatchKey({
        ...base,
        mediaType: 'episode',
        showMediaId: 'a-b-c',
        seasonNumber: 0,
        episodeNumber: 3,
      })
    ).toBe('local:srv-1:42');
  });
  it('keys seasons by show uuid and index', () => {
    expect(
      buildMediaMatchKey({
        ...base,
        mediaType: 'season',
        showMediaId: 'a-b-c',
        seasonNumber: 2,
      })
    ).toBe('season:a-b-c:s2');
  });
  it('keys season 0 (Specials) structurally, unlike episode 0', () => {
    expect(
      buildMediaMatchKey({
        ...base,
        mediaType: 'season',
        showMediaId: 'a-b-c',
        seasonNumber: 0,
      })
    ).toBe('season:a-b-c:s0');
  });

  describe('music (track/album/artist)', () => {
    it('keys by musicBrainzId first, ahead of any title context', () => {
      expect(
        buildMediaMatchKey({
          ...base,
          mediaType: 'track',
          musicBrainzId: 'f3e5c1a0-track',
          title: 'Intro',
          grandparentTitle: 'Boards of Canada',
          parentTitle: 'Music Has the Right to Children',
        })
      ).toBe('track:mbid:f3e5c1a0-track');
      expect(buildMediaMatchKey({ ...base, mediaType: 'album', musicBrainzId: 'album-mbid' })).toBe(
        'album:mbid:album-mbid'
      );
      expect(
        buildMediaMatchKey({ ...base, mediaType: 'artist', musicBrainzId: 'artist-mbid' })
      ).toBe('artist:mbid:artist-mbid');
    });

    it('scopes a mbid-less track by normalized artist+album so same-titled tracks in different albums do not collapse', () => {
      const introInAlbumOne = buildMediaMatchKey({
        ...base,
        mediaType: 'track',
        title: 'Intro',
        grandparentTitle: 'Boards of Canada',
        parentTitle: 'Music Has the Right to Children',
      });
      const introInAlbumTwo = buildMediaMatchKey({
        ...base,
        mediaType: 'track',
        title: 'Intro',
        grandparentTitle: 'The xx',
        parentTitle: 'xx',
      });
      expect(introInAlbumOne).toBe('track:title:boardsofcanada:musichastherighttochildren:intro');
      expect(introInAlbumTwo).toBe('track:title:thexx:xx:intro');
      expect(introInAlbumOne).not.toBe(introInAlbumTwo);
    });

    it('falls back to localKey for a track with no mbid and no artist/album context at all', () => {
      expect(buildMediaMatchKey({ ...base, mediaType: 'track', title: 'Intro' })).toBe(
        'local:srv-1:42'
      );
    });

    it('scopes a mbid-less album by its own parent artist (carried in parentTitle)', () => {
      expect(
        buildMediaMatchKey({
          ...base,
          mediaType: 'album',
          title: 'Music Has the Right to Children',
          parentTitle: 'Boards of Canada',
        })
      ).toBe('album:title:boardsofcanada:musichastherighttochildren');
      expect(buildMediaMatchKey({ ...base, mediaType: 'album', title: 'xx' })).toBe(
        'local:srv-1:42'
      );
    });

    it('falls back to localKey for an artist with no mbid, since artists have no parent context', () => {
      expect(buildMediaMatchKey({ ...base, mediaType: 'artist', title: 'Boards of Canada' })).toBe(
        'local:srv-1:42'
      );
    });
  });
});
