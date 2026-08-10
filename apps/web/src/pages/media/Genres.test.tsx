import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { GenreRow } from '@tracearr/shared';
import { MediaGenres } from './Genres';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useGenres: vi.fn(),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@/components/library/LibraryEmptyState', () => ({
  LibraryEmptyState: () => <div data-testid="library-empty-state" />,
}));

vi.mock('@/components/charts/TopListChart', () => ({
  TopListChart: ({
    data,
    valueLabel,
    limit,
  }: {
    data: { name: string; value: number; subtitle?: string }[] | undefined;
    valueLabel: string;
    limit?: number;
  }) => <div data-testid="genres-chart">{JSON.stringify({ data, valueLabel, limit })}</div>,
}));

import { useGenres } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseGenres = vi.mocked(useGenres);
const mockUseServer = vi.mocked(useServer);

function serverReturn(overrides: Partial<ReturnType<typeof useServer>> = {}) {
  return {
    selectedServerIds: ['srv-1'],
    servers: [{ id: 'srv-1', name: 'Plex', type: 'plex', url: '', color: '#e5a00d' }],
    isLoading: false,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useServer>;
}

function genresReturn(overrides: Partial<ReturnType<typeof useGenres>> = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useGenres>;
}

function rows(): GenreRow[] {
  return [
    { genre: 'Action', itemCount: 40, plays: 12, watchTimeMs: 3 * 3_600_000 },
    { genre: 'Comedy', itemCount: 55, plays: 30, watchTimeMs: 7 * 3_600_000 },
    { genre: 'Drama', itemCount: 20, plays: 5, watchTimeMs: 3_600_000 },
  ];
}

function renderGenres() {
  return render(
    <MemoryRouter>
      <MediaGenres />
    </MemoryRouter>
  );
}

describe('MediaGenres', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue(serverReturn());
  });

  it('renders the table sorted by plays desc, with a browse link per genre', () => {
    mockUseGenres.mockReturnValue(genresReturn({ data: { data: rows() } }));

    renderGenres();

    const table = screen.getByRole('table', { name: 'media.genres.table.title' });
    const headers = table.querySelectorAll('th');
    expect(Array.from(headers).map((h) => h.textContent)).toEqual([
      'media.genres.table.columns.genre',
      'media.genres.table.columns.items',
      'media.genres.table.columns.plays',
      'media.genres.table.columns.watchTime',
    ]);

    const cells = table.querySelectorAll('tbody tr');
    expect(cells).toHaveLength(3);
    // Comedy has the most plays (30) so it sorts first.
    expect(cells[0]?.textContent).toContain('Comedy');
    expect(cells[0]?.textContent).toContain('7h 0m');

    const link = screen.getByRole('link', {
      name: 'media.genres.table.browseMovies:{"genre":"Comedy"}',
    });
    expect(link).toHaveAttribute('href', '/media/browse?genre=Comedy');
  });

  it('feeds the chart sorted-desc data limited to the top N, with plays as the value', () => {
    mockUseGenres.mockReturnValue(genresReturn({ data: { data: rows() } }));

    renderGenres();

    const chart = screen.getByTestId('genres-chart');
    const parsed = JSON.parse(chart.textContent ?? '{}');
    expect(parsed.limit).toBe(15);
    expect(parsed.valueLabel).toBe('media.genres.chart.valueLabel');
    expect(parsed.data.map((d: { name: string }) => d.name)).toEqual(['Comedy', 'Action', 'Drama']);
    expect(parsed.data[0].value).toBe(30);
  });

  it('switches the query type and re-fetches genres when the toggle is used', async () => {
    mockUseGenres.mockReturnValue(genresReturn({ data: { data: rows() } }));
    const user = userEvent.setup();

    renderGenres();

    expect(mockUseGenres).toHaveBeenLastCalledWith('movie', ['srv-1']);

    await user.click(screen.getByRole('radio', { name: 'media.grid.toolbar.showsToggle' }));

    expect(mockUseGenres).toHaveBeenLastCalledWith('show', ['srv-1']);
  });

  it('renders loading skeletons for the chart and table', () => {
    mockUseGenres.mockReturnValue(genresReturn({ isLoading: true }));

    renderGenres();

    expect(screen.getByTestId('genres-skeleton')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('genres-chart')).not.toBeInTheDocument();
  });

  it('renders an error state with retry when the genres query fails', async () => {
    const refetch = vi.fn();
    mockUseGenres.mockReturnValue(genresReturn({ isError: true, refetch }));
    const user = userEvent.setup();

    renderGenres();

    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('renders a proper empty state (not a blank) when no genres are captured', () => {
    mockUseGenres.mockReturnValue(genresReturn({ data: { data: [] } }));

    renderGenres();

    expect(screen.getByText('media.genres.empty.title')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the sync-aware LibraryEmptyState when no servers are selected', () => {
    mockUseServer.mockReturnValue(serverReturn({ selectedServerIds: [] }));
    mockUseGenres.mockReturnValue(genresReturn());

    renderGenres();

    expect(screen.getByTestId('library-empty-state')).toBeInTheDocument();
  });
});
