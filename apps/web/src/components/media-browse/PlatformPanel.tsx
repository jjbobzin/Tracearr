import { useTranslation } from 'react-i18next';
import type { MediaPlatformBreakdownEntry } from '@tracearr/shared';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { InlineErrorState } from '@/components/library/ErrorState';
import { formatDuration } from '@/lib/formatters';
import { formatNumber } from '@/components/ui/stat-card';

interface PlatformPanelProps {
  data: MediaPlatformBreakdownEntry[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}

function PlatformPanelSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

export function PlatformPanel({ data, isLoading, isError, onRetry }: PlatformPanelProps) {
  const { t } = useTranslation('pages');

  return (
    <section
      aria-labelledby="platform-panel-heading"
      className="bg-card rounded-[calc(var(--radius)+2px)] border p-[16px_18px]"
    >
      <h2 id="platform-panel-heading" className="mb-3 text-[15px] font-semibold">
        {t('media.detail.platforms.title')}
      </h2>

      {isError ? (
        <InlineErrorState message={t('media.detail.platforms.loadError')} onRetry={onRetry} />
      ) : isLoading || data === undefined ? (
        <PlatformPanelSkeleton />
      ) : data.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
          {t('media.detail.platforms.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table aria-label={t('media.detail.platforms.title')}>
            <TableCaption className="sr-only">{t('media.detail.platforms.title')}</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('media.detail.platforms.columns.platform')}</TableHead>
                <TableHead className="text-right">
                  {t('media.detail.platforms.columns.plays')}
                </TableHead>
                <TableHead className="text-right">
                  {t('media.detail.platforms.columns.watchTime')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((entry, index) => (
                <TableRow key={`${entry.platform ?? ''}-${entry.player ?? ''}-${index}`}>
                  <TableCell>
                    <div className="font-medium">
                      {entry.platform ?? entry.player ?? t('media.detail.platforms.unknown')}
                    </div>
                    {entry.platform && entry.player && (
                      <div className="text-muted-foreground text-xs">{entry.player}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(entry.plays)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(entry.watchTimeMs, { style: 'compactShort' })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
