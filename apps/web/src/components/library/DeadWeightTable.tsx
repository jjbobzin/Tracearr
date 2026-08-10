import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { CatalogRowServerEntry, DeadWeightRow, ServerType } from '@tracearr/shared';
import { buildPosterSrc, type PosterCardServer } from '@/components/media-browse/PosterCard';
import { ServerDots } from '@/components/media-browse/ServerDots';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes, formatCompactAge } from '@/lib/formatters';

export interface ServerLookupEntry {
  name: string;
  type: ServerType;
  color?: string | null;
}

function resolvePosterCardServers(
  entries: CatalogRowServerEntry[],
  serverById: Map<string, ServerLookupEntry>
): PosterCardServer[] {
  return entries.map((entry) => {
    const server = serverById.get(entry.serverId);
    return {
      serverId: entry.serverId,
      name: server?.name ?? entry.serverId,
      type: server?.type ?? 'plex',
      color: server?.color ?? null,
      addedAt: entry.addedAt,
      videoResolution: entry.videoResolution,
      versionCount: entry.versionCount,
    };
  });
}

export function DeadWeightTableSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-48" />
      <div className="space-y-2 rounded-lg border p-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="h-12 w-8 shrink-0 rounded-sm" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}

// The versioned image proxy only accepts POSTER_BUCKET_WIDTHS (160/240/360)
// when a `v` param is present; a smaller width 400s. Display size stays 32x48 via CSS.
const DEAD_WEIGHT_THUMB_WIDTH = 160;

function DeadWeightThumb({ row }: { row: DeadWeightRow }) {
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [row.posterUrl]);

  if (!row.posterUrl || imgError) {
    return (
      <div
        className="bg-muted flex h-12 w-8 shrink-0 items-center justify-center rounded-sm text-[9px] font-medium"
        style={row.dominantColor ? { backgroundColor: row.dominantColor } : undefined}
        aria-hidden="true"
      >
        {row.title.slice(0, 1)}
      </div>
    );
  }
  return (
    <img
      src={buildPosterSrc(row.posterUrl, DEAD_WEIGHT_THUMB_WIDTH, row.posterVersion)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setImgError(true)}
      className="h-12 w-8 shrink-0 rounded-sm object-cover"
    />
  );
}

/**
 * All-time list of never-watched titles, worth reclaiming disk space from.
 * Lives on the Storage page next to Stale Content (not-watched-recently) -
 * the two are cousins covering opposite ends of the same neglect spectrum.
 */
export function DeadWeightTable({
  rows,
  count,
  totalBytes,
  serverById,
  allTimeLabel,
}: {
  rows: DeadWeightRow[];
  count: number;
  totalBytes: number;
  serverById: Map<string, ServerLookupEntry>;
  allTimeLabel: string;
}) {
  const { t } = useTranslation('pages');
  const headingId = 'dead-weight-heading';

  return (
    <section
      aria-labelledby={headingId}
      className="bg-card-raised space-y-3 rounded-[calc(var(--radius)+2px)] border p-[16px_18px]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-[15px] font-semibold">
          {t('media.landing.deadWeight.title')}
          <span className="text-muted-foreground ml-1.5 text-xs font-normal">({allTimeLabel})</span>
        </h2>
        <span className="text-muted-foreground text-sm">
          {t('media.landing.deadWeight.summary', {
            count,
            size: formatBytes(totalBytes, 1, { minUnit: 'GB' }),
          })}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
          {t('media.landing.deadWeight.empty')}
        </p>
      ) : (
        <Table aria-label={t('media.landing.deadWeight.title')}>
          <TableCaption className="sr-only">{t('media.landing.deadWeight.title')}</TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="sr-only">
                {t('media.landing.deadWeight.columns.poster')}
              </TableHead>
              <TableHead className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.07em] uppercase">
                {t('media.landing.deadWeight.columns.title')}
              </TableHead>
              <TableHead className="text-muted-foreground text-right text-[10.5px] font-semibold tracking-[0.07em] uppercase">
                {t('media.landing.deadWeight.columns.size')}
              </TableHead>
              <TableHead className="text-muted-foreground text-right text-[10.5px] font-semibold tracking-[0.07em] uppercase">
                {t('media.landing.deadWeight.columns.added')}
              </TableHead>
              <TableHead className="text-muted-foreground text-[10.5px] font-semibold tracking-[0.07em] uppercase">
                {t('media.landing.deadWeight.columns.servers')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.mediaId}>
                <TableCell>
                  <Link to={`/media/${row.mediaId}`} tabIndex={-1} aria-hidden="true">
                    <DeadWeightThumb row={row} />
                  </Link>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <Link
                    to={`/media/${row.mediaId}`}
                    className="focus-visible:ring-ring rounded font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
                  >
                    {row.title}
                    {row.year != null && (
                      <span className="text-muted-foreground ml-1 font-normal">{row.year}</span>
                    )}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatBytes(row.fileBytes, 1, { minUnit: 'GB' })}
                </TableCell>
                <TableCell className="text-muted-foreground text-right">
                  {formatCompactAge(row.addedAt)}
                </TableCell>
                <TableCell>
                  <ServerDots servers={resolvePosterCardServers(row.servers, serverById)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Routes to the storage-reclaim grid view once it ships; inert until then. */}
      {count > rows.length && (
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={t('media.landing.deadWeight.viewAllTooltip')}
          className="text-muted-foreground text-sm underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('media.landing.deadWeight.viewAll')}
        </button>
      )}
    </section>
  );
}
