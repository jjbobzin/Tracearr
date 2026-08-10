import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type { MediaStatsResponse, MediaWatcherEntry } from '@tracearr/shared';
import { KpiStrip, averageCompletion, finishedEveryEpisodeCount, formatKpiHours } from './KpiStrip';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

function watcher(overrides: Partial<MediaWatcherEntry> = {}): MediaWatcherEntry {
  return {
    user: {
      serverUserId: 's1',
      userId: 'u1',
      serverId: 'srv-1',
      username: 'sarah',
      identityName: 'Sarah',
      thumb: null,
    },
    plays: 10,
    watchTimeMs: 1000,
    completionPct: 100,
    lastWatchedDay: '2026-07-01',
    distinctEpisodesWatched: 19,
    ...overrides,
  };
}

function stats(
  overrides: Partial<MediaStatsResponse['windows']['all_time']['combined']> = {}
): MediaStatsResponse {
  return {
    mediaId: 'media-1',
    mediaType: 'show',
    windows: {
      all_time: {
        combined: { plays: 214, watchTimeMs: 655_200_000, uniqueUsers: 14, ...overrides },
        perServer: [],
      },
      last_30: { combined: { plays: 30, watchTimeMs: 129_600_000, uniqueUsers: 4 }, perServer: [] },
      last_7: { combined: { plays: 5, watchTimeMs: 10_000, uniqueUsers: 2 }, perServer: [] },
    },
  };
}

describe('averageCompletion', () => {
  it('rounds the mean of every non-null completionPct', () => {
    const watchers = [
      watcher({ completionPct: 100 }),
      watcher({ completionPct: 74 }),
      watcher({ completionPct: 47 }),
    ];
    expect(averageCompletion(watchers)).toBe(74);
  });

  it('ignores watchers with a null completionPct', () => {
    const watchers = [watcher({ completionPct: 100 }), watcher({ completionPct: null })];
    expect(averageCompletion(watchers)).toBe(100);
  });

  it('returns null when no watcher has a completion figure', () => {
    expect(averageCompletion([watcher({ completionPct: null })])).toBeNull();
  });

  it('returns null for an empty watcher list', () => {
    expect(averageCompletion([])).toBeNull();
  });
});

describe('finishedEveryEpisodeCount', () => {
  it('counts only watchers at exactly 100%', () => {
    const watchers = [
      watcher({ completionPct: 100 }),
      watcher({ completionPct: 100 }),
      watcher({ completionPct: 99 }),
    ];
    expect(finishedEveryEpisodeCount(watchers)).toBe(2);
  });
});

describe('formatKpiHours', () => {
  it('rounds milliseconds down to whole hours', () => {
    expect(formatKpiHours(655_200_000)).toBe('182h');
  });
});

describe('KpiStrip', () => {
  it('renders the four kpi tiles with the avg-completion caption for a show', () => {
    const watchers = [
      watcher({ completionPct: 100 }),
      watcher({ completionPct: 74 }),
      watcher({ completionPct: 47 }),
      watcher({ completionPct: 100 }),
    ];
    render(
      <KpiStrip
        mediaType="show"
        stats={stats()}
        statsLoading={false}
        statsError={false}
        onRetryStats={vi.fn()}
        watchers={watchers}
        watchersLoading={false}
        watchersError={false}
        onRetryWatchers={vi.fn()}
      />
    );

    expect(screen.getByText('214')).toBeInTheDocument();
    expect(screen.getByText('182h')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('2 of 4 finished every episode')).toBeInTheDocument();
  });

  it('uses the movie-specific completion caption for a movie', () => {
    render(
      <KpiStrip
        mediaType="movie"
        stats={stats()}
        statsLoading={false}
        statsError={false}
        onRetryStats={vi.fn()}
        watchers={[watcher({ completionPct: 100 })]}
        watchersLoading={false}
        watchersError={false}
        onRetryWatchers={vi.fn()}
      />
    );

    expect(screen.getByText('1 of 1 watched to completion')).toBeInTheDocument();
  });

  it('shows an inline error with retry when stats fails to load, independent of watchers', () => {
    const onRetryStats = vi.fn();
    render(
      <KpiStrip
        mediaType="show"
        stats={undefined}
        statsLoading={false}
        statsError
        onRetryStats={onRetryStats}
        watchers={[watcher()]}
        watchersLoading={false}
        watchersError={false}
        onRetryWatchers={vi.fn()}
      />
    );

    screen.getByRole('button', { name: /Try again/ }).click();
    expect(onRetryStats).toHaveBeenCalled();
    // The completion tile still renders even though stats failed.
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders a dash for avg completion when no watcher has a completion figure', () => {
    render(
      <KpiStrip
        mediaType="show"
        stats={stats()}
        statsLoading={false}
        statsError={false}
        onRetryStats={vi.fn()}
        watchers={[]}
        watchersLoading={false}
        watchersError={false}
        onRetryWatchers={vi.fn()}
      />
    );

    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
