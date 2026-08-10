import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { ShelvesResponse } from '@tracearr/shared';
import { MediaOverview } from './Overview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useShelves: vi.fn(),
  useLibraryStats: vi.fn(),
  useLibraryGrowth: vi.fn(),
  useLibraryStatus: vi.fn(),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@/components/ui/time-range-picker', () => ({
  TimeRangePicker: ({
    onChange,
  }: {
    onChange: (value: { period: string; startDate?: Date; endDate?: Date }) => void;
  }) => <button onClick={() => onChange({ period: 'year' })}>switch-range</button>,
}));

vi.mock('@/components/charts', () => ({
  LibraryGrowthChart: () => <div data-testid="library-growth-chart" />,
}));

vi.mock('@/components/library/LibraryEmptyState', () => ({
  LibraryEmptyState: () => <div data-testid="library-empty-state" />,
}));

import {
  useShelves,
  useLibraryStats,
  useLibraryGrowth,
  useLibraryStatus,
  type LibraryStatusResponse,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseShelves = vi.mocked(useShelves);
const mockUseLibraryStats = vi.mocked(useLibraryStats);
const mockUseLibraryGrowth = vi.mocked(useLibraryGrowth);
const mockUseLibraryStatus = vi.mocked(useLibraryStatus);
const mockUseServer = vi.mocked(useServer);

function serverReturn(overrides: Partial<ReturnType<typeof useServer>> = {}) {
  return {
    selectedServerIds: ['srv-1'],
    selectedServers: [{ id: 'srv-1', name: 'Plex', type: 'plex', color: '#e5a00d' }],
    servers: [
      {
        id: 'srv-1',
        name: 'Plex',
        type: 'plex',
        url: '',
        color: '#e5a00d',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    isMultiServer: false,
    isLoading: false,
    ...overrides,
  } as unknown as ReturnType<typeof useServer>;
}

function statsReturn(overrides: Partial<ReturnType<typeof useLibraryStats>> = {}) {
  return {
    data: {
      totalItems: 500,
      totalSizeBytes: 2_000_000_000,
      movieCount: 300,
      episodeCount: 1500,
      showCount: 40,
      asOf: '2024-01-15T12:00:00Z',
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useLibraryStats>;
}

function growthReturn(overrides: Partial<ReturnType<typeof useLibraryGrowth>> = {}) {
  return {
    data: { period: '30d', movies: [], episodes: [], music: [] },
    isLoading: false,
    isError: false,
    error: null,
    ...overrides,
  } as unknown as ReturnType<typeof useLibraryGrowth>;
}

function statusReturn(
  byServer: Record<string, Partial<LibraryStatusResponse> | undefined> = {
    'srv-1': { isSynced: true, needsBackfill: false, isBackfillRunning: false },
  },
  isLoading = false
) {
  const map = new Map(
    Object.entries(byServer).map(([id, data]) => [id, { data: data as LibraryStatusResponse }])
  );
  return { byServer: map, isLoading, isFetching: false, error: null } as unknown as ReturnType<
    typeof useLibraryStatus
  >;
}

const rowBase = {
  genres: [] as string[],
  posterUrl: 'https://example.com/api/library/poster?serverId=srv-1&path=x',
  posterVersion: null,
  dominantColor: null,
  servers: [
    {
      serverId: 'srv-1',
      addedAt: '2024-01-01T00:00:00Z',
      videoResolution: '1080p',
      fileSize: 1000,
      versionCount: 1,
    },
  ],
  resolutionBest: '1080p',
};

function fullShelves(): ShelvesResponse {
  return {
    period: 'month',
    recentlyAddedMovies: [
      {
        ...rowBase,
        mediaId: 'ram-1',
        mediaType: 'movie',
        title: 'Recently Added Movie',
        year: 2024,
        watchedState: 'unwatched',
        newEpisodes: null,
      },
    ],
    recentlyAddedShows: [
      {
        ...rowBase,
        mediaId: 'ras-1',
        mediaType: 'show',
        title: 'Grouped Show',
        year: 2023,
        watchedState: 'partial',
        newEpisodes: 3,
      },
    ],
    mostPopularMovies: [
      {
        ...rowBase,
        mediaId: 'mpm-1',
        mediaType: 'movie',
        title: 'Popular Movie',
        year: 2022,
        watchedState: 'watched',
        plays: 12,
        viewers: 4,
        rank: 1,
      },
    ],
    mostPopularShows: [
      {
        ...rowBase,
        mediaId: 'mps-1',
        mediaType: 'show',
        title: 'Popular Show',
        year: 2021,
        watchedState: 'watched',
        plays: 8,
        viewers: 2,
        rank: 1,
      },
    ],
    deadWeight: [],
    kpis: {
      watchedInPeriod: { titlesTouched: 12, totalTitles: 48 },
      hoursWatched: 7230,
      newlyAdded: { count: 6, totalBytes: 3_000_000_000, playedCount: 2 },
      deadWeight: { count: 9, totalBytes: 45_000_000_000 },
    },
    meta: { movies: 42, shows: 7, totalFileSize: 123_456_789_000 },
  };
}

function renderOverview(initialEntries: string[] = ['/']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <MediaOverview />
    </MemoryRouter>
  );
}

function mockShelvesReturn(overrides: Partial<ReturnType<typeof useShelves>> = {}) {
  mockUseShelves.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useShelves>);
}

describe('MediaOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue(serverReturn());
    mockUseLibraryStats.mockReturnValue(statsReturn());
    mockUseLibraryGrowth.mockReturnValue(growthReturn());
    mockUseLibraryStatus.mockReturnValue(statusReturn());
  });

  it('renders the library stat cards and growth chart above the shelves', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.getByRole('heading', { name: 'library.title', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByTestId('library-growth-chart')).toBeInTheDocument();
  });

  it('marks the four total stat cards as all-time, leaving the Added card on its own period label', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    // The mocked t() returns the raw key for a call with no interpolation
    // options, lowercased by the component the same way it lowercases the
    // real "All Time" label. Cards render it inside "(...)", so match by
    // substring rather than the full node text.
    const allTimeHints = screen.getAllByText(/common:time\.alltime/);
    // Total Items, Total Size, Movies, Episodes.
    expect(allTimeHints.length).toBe(4);

    // The Added card still carries its own period label, not the all-time hint.
    expect(screen.getByText('library.overview.added')).toBeInTheDocument();
    expect(
      screen.getByText(/library\.overview\.thisMonth|library\.overview\.thisPeriod/)
    ).toBeInTheDocument();
  });

  it('shows a section-scoped error (not a full-page one) when the library stats query fails, while shelves still render', () => {
    mockUseLibraryStats.mockReturnValue(
      statsReturn({ data: undefined, isError: true, error: new Error('stats boom') })
    );
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.getByText('stats boom')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.recentlyAddedMovies')).toBeInTheDocument();
  });

  it('shows a section-scoped loading skeleton for the stats while shelves load independently', () => {
    mockUseLibraryStats.mockReturnValue(statsReturn({ data: undefined, isLoading: true }));
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.getByText('media.landing.shelves.recentlyAddedMovies')).toBeInTheDocument();
    expect(screen.queryByTestId('library-growth-chart')).not.toBeInTheDocument();
  });

  it('shows the sync-aware empty state (not the stats/shelves content) when every selected server needs sync', () => {
    mockUseLibraryStatus.mockReturnValue(
      statusReturn({ 'srv-1': { isSynced: false, needsBackfill: false, isBackfillRunning: false } })
    );
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.getByTestId('library-empty-state')).toBeInTheDocument();
    expect(screen.queryByTestId('library-growth-chart')).not.toBeInTheDocument();
    expect(screen.queryByText('media.landing.shelves.recentlyAddedMovies')).not.toBeInTheDocument();
  });

  it('renders all four shelves with their rows', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(screen.getByText('media.landing.shelves.recentlyAddedMovies')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.recentlyAddedShows')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.mostPopularMovies')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.mostPopularShows')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Recently Added Movie/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Grouped Show/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Popular Movie/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Popular Show/ })).toBeInTheDocument();
  });

  it('shows the heading and an empty note (not a vanished section) when only one type is empty', () => {
    const data = fullShelves();
    data.mostPopularShows = [];
    mockShelvesReturn({ data });

    renderOverview();

    expect(screen.getByText('media.landing.shelves.mostPopularShows')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.emptyMostPopular')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.recentlyAddedMovies')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Popular Movie/ })).toBeInTheDocument();
  });

  it('does not repeat the year in the card meta line (the hover overlay already shows it)', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    // The year appears exactly once - inside the hover overlay's meta line.
    expect(screen.getAllByText(/2022/)).toHaveLength(1);
  });

  it('refetches shelves with the new period when the time range changes', async () => {
    const user = userEvent.setup();
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    await user.click(screen.getByText('switch-range'));

    expect(mockUseShelves).toHaveBeenLastCalledWith(
      ['srv-1'],
      expect.objectContaining({ period: 'year' }),
      false
    );
  });

  it('always requests shelves with dead weight excluded (Storage page owns that computation)', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview();

    expect(mockUseShelves).toHaveBeenCalledWith(['srv-1'], expect.anything(), false);
  });

  it('sends an explicit startDate/endDate for a custom range instead of falling back to 30d', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview(['/?period=custom&from=2026-01-01&to=2026-01-31']);

    expect(mockUseLibraryGrowth).toHaveBeenCalledWith(
      ['srv-1'],
      null,
      '30d',
      '2026-01-01T00:00:00.000Z',
      '2026-01-31T00:00:00.000Z'
    );
  });

  it('sends an explicit 1-day startDate/endDate for the day period instead of silently using 30d', () => {
    mockShelvesReturn({ data: fullShelves() });

    renderOverview(['/?period=day']);

    const [, , calledPeriod, calledStart, calledEnd] = mockUseLibraryGrowth.mock.calls[0]!;
    expect(calledPeriod).toBe('30d');
    expect(calledStart).toBeDefined();
    expect(calledEnd).toBeDefined();
    const spanMs =
      new Date(calledEnd as string).getTime() - new Date(calledStart as string).getTime();
    expect(spanMs).toBe(24 * 60 * 60 * 1000);
  });

  it('renders loading skeletons for the shelves', () => {
    mockShelvesReturn({ data: undefined, isLoading: true });

    renderOverview();

    expect(screen.getByTestId('media-landing-skeleton')).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('renders a single error state for the shelves (not one per shelf) when the shelves query fails', () => {
    mockShelvesReturn({ data: undefined, isError: true, error: new Error('boom') });

    renderOverview();

    expect(screen.queryByText('media.landing.shelves.recentlyAddedMovies')).not.toBeInTheDocument();
    expect(screen.getByText('media.landing.loadError')).toBeInTheDocument();
  });

  it('renders the sync-aware empty state when no servers are selected', () => {
    mockUseServer.mockReturnValue(serverReturn({ selectedServerIds: [] }));
    mockShelvesReturn({ data: undefined });

    renderOverview();

    expect(screen.getByTestId('library-empty-state')).toBeInTheDocument();
  });

  it('renders the sync-aware empty state when the library has no movies or shows', () => {
    mockShelvesReturn({
      data: {
        ...fullShelves(),
        recentlyAddedMovies: [],
        recentlyAddedShows: [],
        mostPopularMovies: [],
        mostPopularShows: [],
        deadWeight: [],
        meta: { movies: 0, shows: 0, totalFileSize: 0 },
      },
    });

    renderOverview();

    expect(screen.getByTestId('library-empty-state')).toBeInTheDocument();
  });

  it('renders self-describing empty shelves on a quiet window instead of vanishing', () => {
    const data = fullShelves();
    data.recentlyAddedMovies = [];
    data.recentlyAddedShows = [];
    data.mostPopularMovies = [];
    data.mostPopularShows = [];
    mockShelvesReturn({ data });

    renderOverview();

    // Every shelf keeps its heading and shows a quiet empty note instead of vanishing.
    expect(screen.getByText('media.landing.shelves.recentlyAddedMovies')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.recentlyAddedShows')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.mostPopularMovies')).toBeInTheDocument();
    expect(screen.getByText('media.landing.shelves.mostPopularShows')).toBeInTheDocument();
    expect(screen.getAllByText('media.landing.shelves.emptyRecentlyAdded')).toHaveLength(2);
    expect(screen.getAllByText('media.landing.shelves.emptyMostPopular')).toHaveLength(2);
  });
});
