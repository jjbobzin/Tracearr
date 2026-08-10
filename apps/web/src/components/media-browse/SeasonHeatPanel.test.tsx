import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type { SeasonHeatSeason } from '@tracearr/shared';
import { SeasonHeatPanel } from './SeasonHeatPanel';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const season1: SeasonHeatSeason = {
  seasonNumber: 1,
  title: 'Season 1',
  year: 2022,
  episodeCount: 9,
  watchedCount: 7,
  watchedPct: 92,
  episodes: [
    { episodeNumber: 1, watchedState: 'watched' },
    { episodeNumber: 2, watchedState: 'watched' },
    { episodeNumber: 3, watchedState: 'partial' },
    { episodeNumber: 4, watchedState: 'unwatched' },
  ],
};

describe('SeasonHeatPanel', () => {
  it('shows a loading skeleton and no season rows while loading', () => {
    render(<SeasonHeatPanel seasons={undefined} isLoading isError={false} onRetry={vi.fn()} />);
    expect(screen.queryByText('Season 1')).not.toBeInTheDocument();
  });

  it('shows an inline error with retry on failure', () => {
    const onRetry = vi.fn();
    render(<SeasonHeatPanel seasons={undefined} isLoading={false} isError onRetry={onRetry} />);
    screen.getByRole('button', { name: /Try again/ }).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it('shows the empty-state copy when there is no season data', () => {
    render(<SeasonHeatPanel seasons={[]} isLoading={false} isError={false} onRetry={vi.fn()} />);
    expect(screen.getByText('No season data yet')).toBeInTheDocument();
  });

  it('maps each episode watched state to its aria-label using the S{n}E{n} pattern', () => {
    render(
      <SeasonHeatPanel seasons={[season1]} isLoading={false} isError={false} onRetry={vi.fn()} />
    );

    expect(screen.getByRole('img', { name: 'S1E1: watched' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'S1E3: partially watched' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'S1E4: unwatched' })).toBeInTheDocument();
  });

  it('maps watchedState to the full/part css classes and leaves unwatched bare', () => {
    render(
      <SeasonHeatPanel seasons={[season1]} isLoading={false} isError={false} onRetry={vi.fn()} />
    );

    const watched = screen.getByRole('img', { name: 'S1E1: watched' });
    const partial = screen.getByRole('img', { name: 'S1E3: partially watched' });
    const unwatched = screen.getByRole('img', { name: 'S1E4: unwatched' });

    expect(watched.className).toContain('bg-primary/85');
    expect(partial.className).toContain('bg-primary/35');
    expect(unwatched.className).not.toContain('bg-primary/85');
    expect(unwatched.className).not.toContain('bg-primary/35');
  });

  it('carries a percentage summary aria-label on the strip, "Season 1: 92% watched"', () => {
    render(
      <SeasonHeatPanel seasons={[season1]} isLoading={false} isError={false} onRetry={vi.fn()} />
    );

    expect(screen.getByRole('group', { name: 'Season 1: 92% watched' })).toBeInTheDocument();
  });

  it('falls back to the season title for the episode code when seasonNumber is null', () => {
    const specials: SeasonHeatSeason = {
      seasonNumber: null,
      title: 'Specials',
      year: null,
      episodeCount: 1,
      watchedCount: 0,
      watchedPct: 0,
      episodes: [{ episodeNumber: null, watchedState: 'unwatched' }],
    };
    render(
      <SeasonHeatPanel seasons={[specials]} isLoading={false} isError={false} onRetry={vi.fn()} />
    );

    expect(screen.getByRole('img', { name: 'Specials · E1: unwatched' })).toBeInTheDocument();
  });
});
