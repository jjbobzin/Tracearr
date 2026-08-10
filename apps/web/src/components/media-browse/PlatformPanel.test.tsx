import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type { MediaPlatformBreakdownEntry } from '@tracearr/shared';
import { PlatformPanel } from './PlatformPanel';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

describe('PlatformPanel', () => {
  it('shows the empty-state copy when there is no platform data', () => {
    render(<PlatformPanel data={[]} isLoading={false} isError={false} onRetry={vi.fn()} />);
    expect(screen.getByText('No platform data yet')).toBeInTheDocument();
  });

  it('shows an inline error with retry on failure', () => {
    const onRetry = vi.fn();
    render(<PlatformPanel data={undefined} isLoading={false} isError onRetry={onRetry} />);
    screen.getByRole('button', { name: /Try again/ }).click();
    expect(onRetry).toHaveBeenCalled();
  });

  it('renders platform, plays and watch time for each row', () => {
    const data: MediaPlatformBreakdownEntry[] = [
      { platform: 'Chrome', player: 'Plex Web', plays: 12, watchTimeMs: 9_000_000 },
      { platform: null, player: null, plays: 2, watchTimeMs: 60_000 },
    ];
    render(<PlatformPanel data={data} isLoading={false} isError={false} onRetry={vi.fn()} />);

    expect(screen.getByText('Chrome')).toBeInTheDocument();
    expect(screen.getByText('Plex Web')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });
});
