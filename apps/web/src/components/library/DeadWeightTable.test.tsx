import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { DeadWeightRow } from '@tracearr/shared';
import {
  DeadWeightTable,
  DeadWeightTableSkeleton,
  type ServerLookupEntry,
} from './DeadWeightTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));

const serverById = new Map<string, ServerLookupEntry>([
  ['srv-1', { name: 'Plex', type: 'plex', color: '#e5a00d' }],
]);

function makeRow(overrides: Partial<DeadWeightRow> = {}): DeadWeightRow {
  return {
    mediaId: 'dw-1',
    mediaType: 'movie',
    title: 'Ignored Movie',
    year: 2020,
    genres: [],
    posterUrl: 'https://example.com/api/library/poster?serverId=srv-1&path=x',
    posterVersion: null,
    dominantColor: null,
    servers: [
      {
        serverId: 'srv-1',
        addedAt: '2023-01-01T00:00:00Z',
        videoResolution: '1080p',
        fileSize: 1000,
        versionCount: 1,
      },
    ],
    resolutionBest: '1080p',
    watchedState: 'unwatched',
    fileBytes: 5_000_000_000,
    addedAt: '2023-01-01T00:00:00Z',
    ...overrides,
  };
}

function renderTable(props: Partial<Parameters<typeof DeadWeightTable>[0]> = {}) {
  return render(
    <MemoryRouter>
      <DeadWeightTable
        rows={[makeRow()]}
        count={1}
        totalBytes={5_000_000_000}
        serverById={serverById}
        allTimeLabel="all time"
        {...props}
      />
    </MemoryRouter>
  );
}

describe('DeadWeightTable', () => {
  it('renders the table with totals, the all-time label, and each row', () => {
    renderTable({ count: 9, totalBytes: 45_000_000_000 });

    expect(
      screen.getByText('media.landing.deadWeight.summary:{"count":9,"size":"41.9 GB"}')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('table', { name: 'media.landing.deadWeight.title' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ignored Movie/ })).toBeInTheDocument();
    expect(screen.getByText('4.7 GB')).toBeInTheDocument();
    expect(screen.getByText('(all time)')).toBeInTheDocument();
  });

  it('shows the empty state and no table when there are no rows', () => {
    renderTable({ rows: [], count: 0, totalBytes: 0 });

    expect(screen.getByText('media.landing.deadWeight.empty')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('falls back to "-" for the added column when addedAt is null (NaN-safe age)', () => {
    renderTable({ rows: [makeRow({ addedAt: null })] });

    const row = screen.getByRole('link', { name: /Ignored Movie/ }).closest('tr');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('-');
  });

  it('gives the disabled "View all" button a title so it reads as coming soon, not broken', () => {
    renderTable({ rows: [makeRow()], count: 2 });

    const viewAllButton = screen.getByRole('button', {
      name: 'media.landing.deadWeight.viewAll',
    });
    expect(viewAllButton).toBeDisabled();
    expect(viewAllButton).toHaveAttribute('title', 'media.landing.deadWeight.viewAllTooltip');
  });

  it('does not render the "View all" button when every dead-weight title is already shown', () => {
    renderTable({ rows: [makeRow()], count: 1 });

    expect(
      screen.queryByRole('button', { name: 'media.landing.deadWeight.viewAll' })
    ).not.toBeInTheDocument();
  });

  it('requests the thumbnail at a valid bucket width (regression: 48 gets 400d by the versioned proxy)', () => {
    const { container } = renderTable();

    const thumb = container.querySelector<HTMLImageElement>(
      'a[href="/media/dw-1"][aria-hidden="true"] img'
    );
    expect(thumb).not.toBeNull();
    expect(thumb!.src).toContain('width=160');
    expect(thumb!.src).not.toContain('width=48');
  });

  it('falls back to the titled placeholder when the thumbnail fails to load', () => {
    const { container } = renderTable();

    const thumb = container.querySelector<HTMLImageElement>(
      'a[href="/media/dw-1"][aria-hidden="true"] img'
    );
    expect(thumb).not.toBeNull();

    act(() => {
      thumb!.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('a[href="/media/dw-1"][aria-hidden="true"] img')).toBeNull();
    expect(
      container.querySelector('a[href="/media/dw-1"][aria-hidden="true"]')?.textContent
    ).toContain('I');
  });

  it('renders the loading skeleton', () => {
    const { container } = render(<DeadWeightTableSkeleton />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });
});
