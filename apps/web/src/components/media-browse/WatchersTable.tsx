import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { MediaWatcherEntry } from '@tracearr/shared';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { InlineErrorState } from '@/components/library/ErrorState';
import { formatCompactAge } from '@/lib/formatters';
import { formatNumber } from '@/components/ui/stat-card';
import { getAvatarUrl } from '@/components/users/utils';

interface WatchersTableProps {
  watchers: MediaWatcherEntry[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  mediaType: string | undefined;
  episodeCount: number | null | undefined;
}

function WatchersTableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-[22px] w-[22px] shrink-0 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-10" />
        </div>
      ))}
    </div>
  );
}

export function WatchersTable({
  watchers,
  isLoading,
  isError,
  onRetry,
  mediaType,
  episodeCount,
}: WatchersTableProps) {
  const { t } = useTranslation('pages');
  const showEpisodes = mediaType === 'show';

  return (
    <section
      aria-labelledby="watchers-heading"
      className="bg-card rounded-[calc(var(--radius)+2px)] border p-[16px_18px]"
    >
      <h2 id="watchers-heading" className="mb-3 text-[15px] font-semibold">
        {t('media.detail.watchers.title')}
      </h2>

      {isError ? (
        <InlineErrorState message={t('media.detail.watchers.loadError')} onRetry={onRetry} />
      ) : isLoading || watchers === undefined ? (
        <WatchersTableSkeleton />
      ) : watchers.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
          {t('media.detail.watchers.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table aria-label={t('media.detail.watchers.title')}>
            <TableCaption className="sr-only">{t('media.detail.watchers.title')}</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('media.detail.watchers.columns.user')}</TableHead>
                <TableHead className="text-right">
                  {t('media.detail.watchers.columns.plays')}
                </TableHead>
                {showEpisodes && (
                  <TableHead className="text-right">
                    {t('media.detail.watchers.columns.episodes')}
                  </TableHead>
                )}
                <TableHead>{t('media.detail.watchers.columns.completion')}</TableHead>
                <TableHead className="text-right">
                  {t('media.detail.watchers.columns.lastWatched')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {watchers.map((watcher) => {
                const name = watcher.user.identityName ?? watcher.user.username ?? '?';
                const pct =
                  watcher.completionPct != null ? Math.round(watcher.completionPct) : null;
                return (
                  <TableRow key={watcher.user.serverUserId}>
                    <TableCell>
                      {(() => {
                        const cell = (
                          <>
                            <Avatar className="h-[22px] w-[22px] shrink-0">
                              <AvatarImage
                                src={
                                  getAvatarUrl(watcher.user.serverId, watcher.user.thumb, 22) ??
                                  undefined
                                }
                              />
                              <AvatarFallback className="text-xs">
                                {name[0]?.toUpperCase() ?? '?'}
                              </AvatarFallback>
                            </Avatar>
                            <span className="truncate">{name}</span>
                          </>
                        );
                        return watcher.user.userId ? (
                          <Link
                            to={`/users/${watcher.user.userId}`}
                            className="flex items-center gap-2 font-medium hover:underline"
                          >
                            {cell}
                          </Link>
                        ) : (
                          <div className="flex items-center gap-2 font-medium">{cell}</div>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(watcher.plays)}
                    </TableCell>
                    {showEpisodes && (
                      <TableCell className="text-right tabular-nums">
                        {watcher.distinctEpisodesWatched ?? 0}
                        {episodeCount != null ? ` / ${episodeCount}` : ''}
                      </TableCell>
                    )}
                    <TableCell>
                      {pct != null ? (
                        <div
                          role="progressbar"
                          aria-label={t('media.detail.watchers.completionLabel', { percent: pct })}
                          aria-valuenow={Math.max(0, Math.min(100, pct))}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="bg-muted h-[5px] w-[110px] overflow-hidden rounded-full"
                        >
                          <div
                            className="bg-primary h-full rounded-full"
                            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                          />
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right">
                      {watcher.lastWatchedDay
                        ? t('media.detail.watchers.lastWatchedAgo', {
                            age: formatCompactAge(watcher.lastWatchedDay),
                          })
                        : '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
