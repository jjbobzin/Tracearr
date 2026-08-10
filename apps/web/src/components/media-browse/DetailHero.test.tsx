import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { initI18n } from '@tracearr/translations';
import type { MediaAvailabilityEntry } from '@tracearr/shared';
import { DetailHero, hexToHslTriple, type HeroServerLookupEntry } from './DetailHero';
import type { MediaDetailData, MediaDetailStub } from '@/hooks/queries';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const serverById = new Map<string, HeroServerLookupEntry>([
  ['srv-plex', { name: 'Plex', type: 'plex', color: '#e5a00d', url: 'https://plex.example.com' }],
  [
    'srv-jf',
    { name: 'Jellyfin', type: 'jellyfin', color: '#8a5cf6', url: 'https://jf.example.com' },
  ],
]);

const stub: MediaDetailStub = {
  mediaId: 'media-1',
  title: 'Severance',
  year: 2022,
  posterUrl: '/api/v1/images/proxy?server=srv-plex&url=%2Flibrary%2Fthumb%2F1',
  posterVersion: 'v1',
  dominantColor: '#1f6f6f',
  servers: [],
};

function renderHero(overrides: Partial<React.ComponentProps<typeof DetailHero>> = {}) {
  const props: React.ComponentProps<typeof DetailHero> = {
    data: undefined,
    stub: undefined,
    isLoading: false,
    isError: false,
    onRetry: vi.fn(),
    serverById,
    onFullHistoryClick: vi.fn(),
    ...overrides,
  };
  return render(
    <MemoryRouter>
      <DetailHero {...props} />
    </MemoryRouter>
  );
}

function fullDetail(overrides: Partial<MediaDetailData> = {}): MediaDetailData {
  return {
    id: 'media-1',
    mediaType: 'show',
    title: 'Severance',
    year: 2022,
    imdbId: null,
    tmdbId: null,
    tvdbId: null,
    genres: ['Sci-Fi', 'Thriller'],
    showMediaId: null,
    mergedIds: [],
    availability: [
      {
        serverId: 'srv-plex',
        serverType: 'plex',
        libraryId: 'lib-1',
        libraryName: 'Movies',
        ratingKey: 'rk-1',
        addedAt: '2025-03-12T00:00:00Z',
        removedAt: null,
        videoResolution: '4k',
        fileSize: 126_000_000_000,
        episodeFileSize: null,
        episodeResolutions: null,
        episodeCount: null,
        versions: [],
      },
    ],
    seasonCount: 2,
    episodeCount: 19,
    posterUrl: null,
    posterVersion: null,
    dominantColor: null,
    servers: [],
    ...overrides,
  };
}

describe('hexToHslTriple', () => {
  it('converts a hex color to an unwrapped H S% L% triple', () => {
    expect(hexToHslTriple('#1f6f6f')).toMatch(/^\d+ \d+% \d+%$/);
  });

  it('returns null for an invalid hex string', () => {
    expect(hexToHslTriple('not-a-color')).toBeNull();
  });
});

describe('DetailHero', () => {
  it('renders a full skeleton with no title, no stub, and no data', () => {
    renderHero({ isLoading: true });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('paints the title and poster from the stub while the full detail is still loading', () => {
    const { container } = renderHero({ stub, isLoading: true });

    expect(screen.getByRole('heading', { level: 1, name: 'Severance' })).toBeInTheDocument();
    const img = container.querySelector('img');
    expect(img?.src).toContain('width=360');
  });

  it('shows a section skeleton for meta/availability/actions while only the stub has painted', () => {
    renderHero({ stub, isLoading: true });

    expect(screen.queryByRole('button', { name: /Full history/ })).not.toBeInTheDocument();
  });

  it('renders the breadcrumb, meta line, availability rows and actions once full data loads', () => {
    renderHero({ data: fullDetail(), stub });

    expect(screen.getByRole('navigation')).toBeInTheDocument();
    expect(screen.getByText(/2 seasons/)).toBeInTheDocument();
    expect(screen.getByText(/19 episodes/)).toBeInTheDocument();
    expect(screen.getByText('Plex')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Full history' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open on server/ })).toHaveAttribute(
      'href',
      'https://plex.example.com'
    );
  });

  it('strikes through and dims a removed-but-not-everywhere availability row', () => {
    const availability: MediaAvailabilityEntry[] = [
      {
        serverId: 'srv-plex',
        serverType: 'plex',
        libraryId: 'lib-1',
        libraryName: 'Movies',
        ratingKey: 'rk-1',
        addedAt: '2025-03-12T00:00:00Z',
        removedAt: null,
        videoResolution: '4k',
        fileSize: 1000,
        episodeFileSize: null,
        episodeResolutions: null,
        episodeCount: null,
        versions: [],
      },
      {
        serverId: 'srv-jf',
        serverType: 'jellyfin',
        libraryId: 'lib-2',
        libraryName: 'Movies',
        ratingKey: 'rk-2',
        addedAt: '2025-01-01T00:00:00Z',
        removedAt: '2026-06-08T00:00:00Z',
        videoResolution: '1080p',
        fileSize: 2000,
        episodeFileSize: null,
        episodeResolutions: null,
        episodeCount: null,
        versions: [],
      },
    ];
    renderHero({ data: fullDetail({ availability }) });

    expect(screen.getByText(/removed/)).toBeInTheDocument();
  });

  it('removed-everywhere variant: no poster fetch, no Open on server action, and a removal caption', () => {
    const availability: MediaAvailabilityEntry[] = [
      {
        serverId: 'srv-plex',
        serverType: 'plex',
        libraryId: 'lib-1',
        libraryName: 'Movies',
        ratingKey: 'rk-1',
        addedAt: '2025-03-12T00:00:00Z',
        removedAt: '2026-06-08T00:00:00Z',
        videoResolution: '4k',
        fileSize: 1000,
        episodeFileSize: null,
        episodeResolutions: null,
        episodeCount: null,
        versions: [],
      },
    ];
    const { container } = renderHero({ data: fullDetail({ availability }), stub });

    // The poster falls back to the initials tile - no <img> attempted, even
    // though the stub carries a posterUrl.
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open on server/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open on server/ })).not.toBeInTheDocument();
    expect(screen.getByText('No longer available on any connected server')).toBeInTheDocument();
  });

  it('renders an inline error with retry when the detail fetch fails and there is no stub at all', () => {
    const onRetry = vi.fn();
    renderHero({ isError: true, onRetry });

    screen.getByRole('button', { name: /Try again/ }).click();
    expect(onRetry).toHaveBeenCalled();
  });
});
