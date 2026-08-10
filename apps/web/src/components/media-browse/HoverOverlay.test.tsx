import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import { HoverOverlay, type HoverOverlayServer } from './HoverOverlay';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const servers: HoverOverlayServer[] = [
  { serverId: 'srv-1', name: 'Plex', type: 'plex' as const, addedAt: '2025-03-12T00:00:00Z' },
];

const baseProps = {
  title: 'Blade Runner 2049',
  year: 2017,
  servers,
  resolution: '1080p',
};

describe('HoverOverlay a11y contract', () => {
  it('is aria-hidden at the root', () => {
    const { container } = render(<HoverOverlay {...baseProps} />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  it('contains no interactive children', () => {
    const { container } = render(<HoverOverlay {...baseProps} plays={12} viewers={7} />);
    expect(container.querySelectorAll('a, button, input, select, textarea')).toHaveLength(0);
    expect(container.querySelectorAll('[tabindex]')).toHaveLength(0);
  });

  it('stays hidden by default and reveals only via group-hover/group-focus-within', () => {
    const { container } = render(<HoverOverlay {...baseProps} />);
    const overlay = container.firstElementChild;
    expect(overlay).toHaveClass('opacity-0');
    expect(overlay).toHaveClass('group-hover:opacity-100');
    expect(overlay).toHaveClass('group-focus-within:opacity-100');
    expect(overlay).toHaveClass('pointer-events-none');
  });
});

describe('HoverOverlay containment (in-card, not below the card)', () => {
  it('covers the poster region exactly via inset-0, meant to be rendered inside the poster box', () => {
    const { container } = render(<HoverOverlay {...baseProps} />);
    const overlay = container.firstElementChild;
    expect(overlay).toHaveClass('absolute', 'inset-0', 'overflow-hidden');
    expect(overlay).not.toHaveClass('top-full');
  });
});

describe('HoverOverlay content', () => {
  it('renders the title', () => {
    render(<HoverOverlay {...baseProps} />);
    expect(screen.getByText('Blade Runner 2049')).toBeInTheDocument();
  });

  it('renders a quiet meta line joining year and resolution', () => {
    render(<HoverOverlay {...baseProps} />);
    expect(screen.getByText('2017 · 1080p')).toBeInTheDocument();
  });

  it('omits the meta line when both year and resolution are missing', () => {
    render(<HoverOverlay {...baseProps} year={null} resolution={null} servers={[]} />);
    expect(screen.queryByText(/1080p|2017/)).not.toBeInTheDocument();
  });

  it('renders a server row with a short added-date, not the server name', () => {
    render(<HoverOverlay {...baseProps} />);
    expect(screen.getByText('Added Mar 2025')).toBeInTheDocument();
    expect(screen.queryByText(/Plex/)).not.toBeInTheDocument();
  });

  it('renders one row per distinct server, never one combined row', () => {
    const multiServer: HoverOverlayServer[] = [
      { serverId: 'srv-1', name: 'Plex', type: 'plex', addedAt: '2025-03-12T00:00:00Z' },
      { serverId: 'srv-2', name: 'Jellyfin', type: 'jellyfin', addedAt: '2026-05-03T00:00:00Z' },
    ];
    render(<HoverOverlay {...baseProps} servers={multiServer} />);
    expect(screen.getByText('Added Mar 2025')).toBeInTheDocument();
    expect(screen.getByText('Added May 2026')).toBeInTheDocument();
  });

  it('caps server rows at two and summarizes the rest, so the fixed box never clips', () => {
    const manyServers: HoverOverlayServer[] = [
      { serverId: 'srv-1', name: 'Plex', type: 'plex', addedAt: '2025-03-12T00:00:00Z' },
      { serverId: 'srv-2', name: 'Jellyfin', type: 'jellyfin', addedAt: '2026-05-03T00:00:00Z' },
      { serverId: 'srv-3', name: 'Emby', type: 'emby', addedAt: '2026-06-01T00:00:00Z' },
      { serverId: 'srv-4', name: 'Plex 2', type: 'plex', addedAt: '2026-07-01T00:00:00Z' },
    ];
    render(<HoverOverlay {...baseProps} servers={manyServers} />);
    expect(screen.getByText('Added Mar 2025')).toBeInTheDocument();
    expect(screen.getByText('Added May 2026')).toBeInTheDocument();
    expect(screen.queryByText('Added Jun 2026')).not.toBeInTheDocument();
    expect(screen.getByText('+2 more')).toBeInTheDocument();
  });

  it('dedupes multiple library_items on the same server into one row', () => {
    const sameServerTwice: HoverOverlayServer[] = [
      { serverId: 'srv-1', name: 'Plex', type: 'plex', addedAt: '2025-03-12T00:00:00Z' },
      { serverId: 'srv-1', name: 'Plex', type: 'plex', addedAt: '2025-06-01T00:00:00Z' },
    ];
    const { container } = render(<HoverOverlay {...baseProps} servers={sameServerTwice} />);
    expect(screen.getAllByText('Added Mar 2025')).toHaveLength(1);
    expect(container.querySelectorAll('.bg-muted-foreground.rounded-full')).toHaveLength(1);
  });

  it('renders a plays/viewers stats line when provided', () => {
    render(<HoverOverlay {...baseProps} plays={12} viewers={7} />);
    expect(screen.getByText('12 plays · 7 viewers')).toBeInTheDocument();
  });

  it('omits plays from the stats line when undefined', () => {
    render(<HoverOverlay {...baseProps} viewers={7} />);
    expect(screen.getByText('7 viewers')).toBeInTheDocument();
    expect(screen.queryByText(/plays/)).not.toBeInTheDocument();
  });

  it('omits the stats line entirely when plays and viewers are both undefined', () => {
    render(<HoverOverlay {...baseProps} />);
    expect(screen.queryByText(/plays|viewers/)).not.toBeInTheDocument();
  });
});
