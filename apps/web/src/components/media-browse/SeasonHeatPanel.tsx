import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SeasonHeatEpisode, SeasonHeatSeason } from '@tracearr/shared';
import { Skeleton } from '@/components/ui/skeleton';
import { InlineErrorState } from '@/components/library/ErrorState';
import { cn } from '@/lib/utils';

interface SeasonHeatPanelProps {
  seasons: SeasonHeatSeason[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

const EPISODE_LABEL_KEYS = {
  watched: 'media.detail.seasons.episodeLabel.watched',
  partial: 'media.detail.seasons.episodeLabel.partial',
  unwatched: 'media.detail.seasons.episodeLabel.unwatched',
} as const;

/** "S1E4: watched" when both numbers resolve, degrading to the season title when a number is missing. */
export function episodeAriaLabel(
  t: TFunction<'pages'>,
  season: SeasonHeatSeason,
  episode: SeasonHeatEpisode,
  index: number
): string {
  const episodeNumber = episode.episodeNumber ?? index + 1;
  const code =
    season.seasonNumber != null
      ? `S${season.seasonNumber}E${episodeNumber}`
      : `${season.title} · E${episodeNumber}`;
  return t(EPISODE_LABEL_KEYS[episode.watchedState], { code });
}

function SeasonHeatSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 2 }).map((_, index) => (
        <div key={index} className="grid grid-cols-[120px_1fr_80px] items-center gap-3.5 py-2">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-[18px] w-full" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function SeasonHeatPanel({ seasons, isLoading, isError, onRetry }: SeasonHeatPanelProps) {
  const { t } = useTranslation('pages');

  return (
    <section
      aria-labelledby="season-heat-heading"
      className="bg-card rounded-[calc(var(--radius)+2px)] border p-[16px_18px]"
    >
      <h2 id="season-heat-heading" className="mb-3 text-[15px] font-semibold">
        {t('media.detail.seasons.title')}
      </h2>

      {isError ? (
        <InlineErrorState message={t('media.detail.seasons.loadError')} onRetry={onRetry} />
      ) : isLoading || seasons === undefined ? (
        <SeasonHeatSkeleton />
      ) : seasons.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
          {t('media.detail.seasons.empty')}
        </p>
      ) : (
        <div>
          {seasons.map((season) => {
            const percent = Math.round(season.watchedPct);
            return (
              <div
                key={season.seasonNumber ?? season.title}
                className="border-border/50 grid grid-cols-[100px_1fr_100px] items-center gap-3.5 border-b py-2.5 last:border-b-0 min-[600px]:grid-cols-[120px_1fr_120px]"
              >
                <div>
                  <div className="text-[13px] font-semibold">{season.title}</div>
                  <small className="text-muted-foreground block text-[11px] font-normal">
                    {t('media.detail.seasons.episodeCount', { count: season.episodeCount })}
                    {season.year != null ? ` · ${season.year}` : ''}
                  </small>
                </div>
                <div
                  role="group"
                  aria-label={t('media.detail.seasons.stripSummary', {
                    season: season.title,
                    percent,
                  })}
                  className="grid auto-cols-fr grid-flow-col gap-[3px]"
                >
                  {season.episodes.map((episode, index) => (
                    <span
                      key={`${season.seasonNumber ?? season.title}-${episode.episodeNumber ?? index}`}
                      role="img"
                      aria-label={episodeAriaLabel(t, season, episode, index)}
                      className={cn(
                        'bg-muted h-[18px] rounded-[3px]',
                        episode.watchedState === 'watched' && 'bg-primary/85',
                        episode.watchedState === 'partial' && 'bg-primary/35'
                      )}
                    />
                  ))}
                </div>
                <div className="text-muted-foreground text-right text-xs tabular-nums">
                  {t('media.detail.seasons.watchedPct', { percent })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
