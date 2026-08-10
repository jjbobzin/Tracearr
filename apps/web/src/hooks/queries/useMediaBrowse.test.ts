import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import type { CatalogResponse, ShelvesResponse } from '@tracearr/shared';
import {
  stableSerialize,
  detailFromStub,
  findCachedMediaStub,
  useCatalogWindow,
  useCatalogLetters,
  useShelves,
  useGenres,
  useMediaDetail,
  useMediaStats,
  useSeasonHeat,
  useMediaHistory,
  buildLetterOffsets,
  activeLetterForItem,
  activeLetterForRow,
  type MediaDetailStub,
} from './useMediaBrowse';

function wrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestedServerIds(fetchSpy: ReturnType<typeof vi.spyOn>, callIndex = 0): string[] {
  const url = new URL(fetchSpy.mock.calls[callIndex]?.[0] as string, 'http://localhost');
  return url.searchParams.getAll('serverIds');
}

describe('stableSerialize', () => {
  it('serializes objects with the same entries in a different key order identically', () => {
    const a = { type: 'movie', genre: 'Action', yearFrom: 2000 };
    const b = { yearFrom: 2000, genre: 'Action', type: 'movie' };

    expect(stableSerialize(a)).toBe(stableSerialize(b));
  });

  it('sorts keys at every nesting level', () => {
    const a = { outer: { b: 1, a: 2 }, z: 1 };
    const b = { z: 1, outer: { a: 2, b: 1 } };

    expect(stableSerialize(a)).toBe(stableSerialize(b));
    expect(stableSerialize(a)).toBe('{"outer":{"a":2,"b":1},"z":1}');
  });

  it('produces different output for genuinely different values', () => {
    expect(stableSerialize({ a: 1 })).not.toBe(stableSerialize({ a: 2 }));
  });
});

describe('letter rail offsets', () => {
  // '#'(2) then A(5) then M(8) then Z(5): M starts at item 7, its row (4
  // columns) spans items 4-7 - column-misaligned, so that row's first three
  // cells are still A's tail.
  const offsets = buildLetterOffsets([
    { letter: '#', count: 2 },
    { letter: 'A', count: 5 },
    { letter: 'M', count: 8 },
    { letter: 'Z', count: 5 },
  ]);

  it('accumulates cumulative item counts per letter, in rail order', () => {
    expect(offsets).toEqual([
      { letter: '#', count: 2, start: 0 },
      { letter: 'A', count: 5, start: 2 },
      { letter: 'M', count: 8, start: 7 },
      { letter: 'Z', count: 5, start: 15 },
    ]);
  });

  it('activeLetterForItem attributes a row-leading item to whichever bucket contains it', () => {
    // Item 4 (row start with 4 columns) falls inside A's [2, 7) range, not M's.
    expect(activeLetterForItem(4, offsets)).toBe('A');
    expect(activeLetterForItem(7, offsets)).toBe('M');
  });

  it('activeLetterForRow attributes a column-misaligned row to the letter it was jumped to, not the tail letter it opens with', () => {
    // Row starting at item 4 mixes A's tail (items 4-6) with M's head (item
    // 7) - a jump to M lands exactly here, so the row must read as M's.
    expect(activeLetterForRow(4, 4, offsets)).toBe('M');
  });

  it('activeLetterForRow falls back to plain containment when no bucket starts inside the row (organic scrolling)', () => {
    // Row starting at item 8 is entirely within M's range (M spans 7-14) -
    // no bucket starts in [8, 11], so this is ordinary mid-letter scrolling.
    expect(activeLetterForRow(8, 4, offsets)).toBe('M');
  });

  it('activeLetterForRow is null while offsets are unknown', () => {
    expect(activeLetterForRow(4, 4, undefined)).toBeNull();
  });

  // Real numbers from the letter-jump investigation: 14 columns, G runs
  // 500-589 and H starts at 590, mid-way through row 42 (items 588-601).
  describe('regression: 14-column jump to H lands mid-row, one row up is still G', () => {
    const jumpOffsets = [
      { letter: 'G', count: 90, start: 500 },
      { letter: 'H', count: 40, start: 590 },
    ];

    it('the row the jump actually lands on (588) reads as H, the letter clicked', () => {
      expect(activeLetterForRow(588, 14, jumpOffsets)).toBe('H');
    });

    it('one row up (574), before H starts, still reads as G', () => {
      expect(activeLetterForRow(574, 14, jumpOffsets)).toBe('G');
    });
  });
});

describe('detailFromStub', () => {
  const stub: MediaDetailStub = {
    mediaId: 'media-1',
    title: 'Dune',
    year: 2021,
    posterUrl: 'https://example.com/poster.webp',
    posterVersion: 'abc12345',
    dominantColor: '#1a1a2e',
    servers: [
      {
        serverId: 'server-1',
        addedAt: '2024-01-01T00:00:00Z',
        videoResolution: '4k',
        fileSize: 123,
        versionCount: 1,
      },
    ],
  };

  it('maps stub fields onto the detail shape', () => {
    const result = detailFromStub(stub);

    expect(result.id).toBe(stub.mediaId);
    expect(result.title).toBe(stub.title);
    expect(result.year).toBe(stub.year);
    expect(result.posterUrl).toBe(stub.posterUrl);
    expect(result.posterVersion).toBe(stub.posterVersion);
    expect(result.dominantColor).toBe(stub.dominantColor);
    expect(result.servers).toEqual(stub.servers);
  });

  it('leaves every field the stub cannot supply undefined, never fabricated', () => {
    const result = detailFromStub(stub);

    expect(result.mediaType).toBeUndefined();
    expect(result.imdbId).toBeUndefined();
    expect(result.tmdbId).toBeUndefined();
    expect(result.tvdbId).toBeUndefined();
    expect(result.genres).toBeUndefined();
    expect(result.showMediaId).toBeUndefined();
    expect(result.mergedIds).toBeUndefined();
    expect(result.availability).toBeUndefined();
    expect(result.seasonCount).toBeUndefined();
    expect(result.episodeCount).toBeUndefined();
  });
});

describe('browse hooks forward the full serverIds selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('useCatalogWindow sends every selected server and the page offset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        data: [],
        meta: { offset: 60, pageSize: 60, totalItems: 0, totalFileSize: 0 },
      })
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(
      () =>
        useCatalogWindow(
          {
            type: 'movie',
            serverIds: ['server-b', 'server-a'],
            lens: 'all',
            filters: {},
            sort: 'title',
          },
          [1]
        ),
      { wrapper: wrapper(client) }
    );

    await waitFor(() => expect(result.current.totalItems).toBe(0));

    expect(requestedServerIds(fetchSpy)).toEqual(['server-a', 'server-b']);
    const url = new URL(fetchSpy.mock.calls[0]?.[0] as string, 'http://localhost');
    expect(url.searchParams.get('offset')).toBe('60');
    expect(url.searchParams.get('pageSize')).toBe('60');
  });

  it('useCatalogWindow keeps already-fetched pages when the needed set shifts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = new URL(String(input), 'http://localhost');
      const offset = Number(url.searchParams.get('offset'));
      return Promise.resolve(
        jsonResponse({
          data: [],
          meta: { offset, pageSize: 60, totalItems: 300, totalFileSize: 0 },
        })
      );
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const args = {
      type: 'movie' as const,
      serverIds: [],
      lens: 'all',
      filters: {},
      sort: 'title' as const,
    };

    const { result, rerender } = renderHook(
      ({ pages }: { pages: number[] }) => useCatalogWindow(args, pages),
      { wrapper: wrapper(client), initialProps: { pages: [0] } }
    );
    await waitFor(() => expect(result.current.totalItems).toBe(300));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Scroll to pages 1-2: two new fetches; page 0 is not refetched, and
    // scrolling back to page 0 serves it from cache.
    rerender({ pages: [1, 2] });
    await waitFor(() => expect(result.current.pages.has(2)).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    rerender({ pages: [0, 1] });
    await waitFor(() => expect(result.current.pages.has(0)).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('useCatalogLetters only fires under title sort', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ letters: [] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const args = {
      type: 'movie' as const,
      serverIds: [],
      lens: 'all',
      filters: {},
    };

    const added = renderHook(() => useCatalogLetters({ ...args, sort: 'added' }), {
      wrapper: wrapper(client),
    });
    expect(added.result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();

    const title = renderHook(() => useCatalogLetters({ ...args, sort: 'title' }), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(title.result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(fetchSpy.mock.calls[0]?.[0] as string, 'http://localhost');
    expect(url.pathname.endsWith('/library/catalog/letters')).toBe(true);
  });

  it('useShelves sends every selected server as a repeated serverIds param', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        period: 'month',
        recentlyAddedMovies: [],
        recentlyAddedShows: [],
        mostPopularMovies: [],
        mostPopularShows: [],
        deadWeight: [],
        kpis: {
          watchedInPeriod: { titlesTouched: 0, totalTitles: 0 },
          hoursWatched: 0,
          newlyAdded: { count: 0, totalBytes: 0, playedCount: 0 },
          deadWeight: { count: 0, totalBytes: 0 },
        },
        meta: { movies: 0, shows: 0, totalFileSize: 0 },
      })
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useShelves(['server-b', 'server-a'], { period: 'month' }), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requestedServerIds(fetchSpy)).toEqual(['server-a', 'server-b']);
  });

  it('useGenres sends every selected server as a repeated serverIds param', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useGenres('movie', ['server-b', 'server-a']), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requestedServerIds(fetchSpy)).toEqual(['server-a', 'server-b']);
  });

  it('useMediaDetail sends every selected server as a repeated serverIds param', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ id: 'media-1' }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(
      () => useMediaDetail('media-1', ['server-b', 'server-a'], 'all'),
      { wrapper: wrapper(client) }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requestedServerIds(fetchSpy)).toEqual(['server-a', 'server-b']);
  });

  it('produces the same cache key regardless of the order serverIds were selected in', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const first = renderHook(() => useGenres('movie', ['server-a', 'server-b']), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Same servers, opposite selection order: sorted before it ever reaches
    // the query key, so this must hit the same cache entry and skip the
    // network call entirely.
    const second = renderHook(() => useGenres('movie', ['server-b', 'server-a']), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('useMediaStats sends every selected server as a repeated serverIds param (shared by useMediaWatchers/useMediaPlatforms)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        mediaId: 'media-1',
        mediaType: 'show',
        windows: {
          all_time: { combined: { plays: 0, watchTimeMs: 0, uniqueUsers: 0 }, perServer: [] },
          last_30: { combined: { plays: 0, watchTimeMs: 0, uniqueUsers: 0 }, perServer: [] },
          last_7: { combined: { plays: 0, watchTimeMs: 0, uniqueUsers: 0 }, perServer: [] },
        },
      })
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useMediaStats('media-1', ['server-b', 'server-a']), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requestedServerIds(fetchSpy)).toEqual(['server-a', 'server-b']);
  });

  it('useSeasonHeat is disabled until the caller knows the media is a show', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ mediaId: 'media-1', seasons: [] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useSeasonHeat('media-1', ['server-a'], enabled),
      { wrapper: wrapper(client), initialProps: { enabled: false } }
    );

    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('useMediaHistory paginates by cursor via getNextPageParam', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({ data: [], meta: { nextCursor: 'cursor-2', pageSize: 50 } })
      )
      .mockResolvedValueOnce(jsonResponse({ data: [], meta: { nextCursor: null, pageSize: 50 } }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useMediaHistory('media-1', ['server-a']), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);

    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));

    const secondCallUrl = new URL(fetchSpy.mock.calls[1]?.[0] as string, 'http://localhost');
    expect(secondCallUrl.searchParams.get('cursor')).toBe('cursor-2');
  });
});

describe('findCachedMediaStub', () => {
  const stubFields = {
    mediaId: 'media-1',
    mediaType: 'movie' as const,
    title: 'Dune',
    year: 2021,
    genres: [] as string[],
    posterUrl: '/poster.jpg',
    posterVersion: 'v1',
    dominantColor: '#123456',
    servers: [] as CatalogResponse['data'][number]['servers'],
    resolutionBest: null,
    watchedState: 'unwatched' as const,
  };

  function catalogRow(
    overrides: Partial<CatalogResponse['data'][number]> = {}
  ): CatalogResponse['data'][number] {
    return {
      ...stubFields,
      watchedStateSelf: 'unwatched' as const,
      plays: 0,
      viewers: 0,
      ...overrides,
    };
  }

  function shelfRow(
    overrides: Partial<ShelvesResponse['recentlyAddedMovies'][number]> = {}
  ): ShelvesResponse['recentlyAddedMovies'][number] {
    return { ...stubFields, newEpisodes: null, ...overrides };
  }

  it('finds a row cached under a catalog window query and maps it to a stub', () => {
    const client = new QueryClient();
    client.setQueryData(
      ['media', 'catalog', 'movie', 'server-a', 'all', '{}', 'title', 'page', 0],
      {
        data: [catalogRow()],
        meta: { offset: 0, pageSize: 60, totalItems: 1, totalFileSize: 0 },
      }
    );

    const stub = findCachedMediaStub(client, 'media-1');

    expect(stub).toEqual({
      mediaId: 'media-1',
      title: 'Dune',
      year: 2021,
      posterUrl: '/poster.jpg',
      posterVersion: 'v1',
      dominantColor: '#123456',
      servers: [],
    });
  });

  it('finds a row cached under a shelves query when no catalog page has it', () => {
    const client = new QueryClient();
    const shelves: ShelvesResponse = {
      period: 'month',
      recentlyAddedMovies: [shelfRow({ mediaId: 'media-2', title: 'Shogun' })],
      recentlyAddedShows: [],
      mostPopularMovies: [],
      mostPopularShows: [],
      deadWeight: [],
      kpis: {
        watchedInPeriod: { titlesTouched: 0, totalTitles: 0 },
        hoursWatched: 0,
        newlyAdded: { count: 0, totalBytes: 0, playedCount: 0 },
        deadWeight: { count: 0, totalBytes: 0 },
      },
      meta: { movies: 0, shows: 0, totalFileSize: 0 },
    };
    client.setQueryData(['media', 'shelves', 'server-a', 'month'], shelves);

    const stub = findCachedMediaStub(client, 'media-2');

    expect(stub?.title).toBe('Shogun');
  });

  it('returns undefined on a cache miss (e.g. a direct URL visit)', () => {
    const client = new QueryClient();
    expect(findCachedMediaStub(client, 'media-unseen')).toBeUndefined();
  });
});
