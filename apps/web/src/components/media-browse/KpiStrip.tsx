import { useTranslation } from 'react-i18next';
import type { MediaStatsResponse, MediaWatcherEntry } from '@tracearr/shared';
import { StatCard, formatNumber } from '@/components/ui/stat-card';
import { InlineErrorState } from '@/components/library/ErrorState';

interface KpiStripProps {
  mediaType: string | undefined;
  stats: MediaStatsResponse | undefined;
  statsLoading: boolean;
  statsError: boolean;
  onRetryStats: () => void;
  watchers: MediaWatcherEntry[] | undefined;
  watchersLoading: boolean;
  watchersError: boolean;
  onRetryWatchers: () => void;
}

/** Whole hours only, matching the mockup's "182h" / "36h" kpi values (no day breakdown). */
export function formatKpiHours(ms: number): string {
  return `${Math.round(ms / 3_600_000)}h`;
}

/** Mean of the watchers' non-null completionPct values, rounded; null when nobody has a completion figure yet. */
export function averageCompletion(watchers: MediaWatcherEntry[]): number | null {
  const values = watchers.map((w) => w.completionPct).filter((p): p is number => p != null);
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function finishedEveryEpisodeCount(watchers: MediaWatcherEntry[]): number {
  return watchers.filter((w) => w.completionPct === 100).length;
}

export function KpiStrip({
  mediaType,
  stats,
  statsLoading,
  statsError,
  onRetryStats,
  watchers,
  watchersLoading,
  watchersError,
  onRetryWatchers,
}: KpiStripProps) {
  const { t } = useTranslation('pages');

  const watcherList = watchers ?? [];
  const avgCompletion = averageCompletion(watcherList);
  const finishedCount = finishedEveryEpisodeCount(watcherList);
  const totalWatchers = watcherList.length;
  const completionDetailKey =
    mediaType === 'movie'
      ? 'media.detail.kpis.completion.detailMovie'
      : 'media.detail.kpis.completion.detail';

  return (
    <div
      className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3"
      data-testid="detail-kpi-strip"
      aria-label={t('media.detail.kpis.ariaLabel')}
    >
      {statsError ? (
        <div className="col-span-full">
          <InlineErrorState message={t('media.detail.kpis.loadError')} onRetry={onRetryStats} />
        </div>
      ) : statsLoading || !stats ? (
        <>
          <StatCard label="" value="" isLoading variant="kpi" />
          <StatCard label="" value="" isLoading variant="kpi" />
          <StatCard label="" value="" isLoading variant="kpi" />
        </>
      ) : (
        <>
          <StatCard
            label={t('media.detail.kpis.plays.label')}
            value={formatNumber(stats.windows.all_time.combined.plays)}
            subValue={t('media.detail.kpis.plays.caption')}
            variant="kpi"
          />
          <StatCard
            label={t('media.detail.kpis.watchTime.label')}
            value={formatKpiHours(stats.windows.all_time.combined.watchTimeMs)}
            subValue={t('media.detail.kpis.watchTime.detail', {
              hours: Math.round(stats.windows.last_30.combined.watchTimeMs / 3_600_000),
            })}
            variant="kpi"
          />
          <StatCard
            label={t('media.detail.kpis.viewers.label')}
            value={formatNumber(stats.windows.all_time.combined.uniqueUsers)}
            subValue={t('media.detail.kpis.viewers.detail')}
            variant="kpi"
          />
        </>
      )}

      {watchersError ? (
        <div className="col-span-full">
          <InlineErrorState
            message={t('media.detail.kpis.completionLoadError')}
            onRetry={onRetryWatchers}
          />
        </div>
      ) : watchersLoading || watchers === undefined ? (
        <StatCard label="" value="" isLoading variant="kpi" />
      ) : (
        <StatCard
          label={t('media.detail.kpis.completion.label')}
          value={avgCompletion != null ? `${avgCompletion}%` : '—'}
          subValue={t(completionDetailKey, { finished: finishedCount, total: totalWatchers })}
          variant="kpi"
        />
      )}
    </div>
  );
}
