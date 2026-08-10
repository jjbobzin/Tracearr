import { useTranslation } from 'react-i18next';
import type { ServerType } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { dedupeServersById } from './dedupeServersById';

export interface ServerDotEntry {
  serverId: string;
  name: string;
  type: ServerType;
  color?: string | null;
}

interface ServerDotsProps {
  servers: ServerDotEntry[];
  className?: string;
}

// apps/web's tsconfig lib target predates ES2021, so Intl.ListFormat has no
// ambient type here even though every supported runtime implements it.
interface ListFormatLike {
  format(items: string[]): string;
}
interface IntlWithListFormat {
  ListFormat: new (
    locales: string,
    options: { style: 'long'; type: 'conjunction' }
  ) => ListFormatLike;
}

/**
 * Calm per-card server indicator: a row of decorative dots carrying one
 * combined aria-label ("On Plex and Jellyfin") rather than per-dot labels,
 * since the dots themselves are not individually distinguishable visually.
 */
export function ServerDots({ servers: rawServers, className }: ServerDotsProps) {
  const { t, i18n } = useTranslation('pages');
  const servers = dedupeServersById(rawServers);

  if (servers.length === 0) return null;

  const names = servers.map((server) => server.name);
  const formatter = new (Intl as unknown as IntlWithListFormat).ListFormat(i18n.language, {
    style: 'long',
    type: 'conjunction',
  });
  const label = t('media.posterCard.onServers', { servers: formatter.format(names) });

  return (
    <span className={cn('inline-flex items-center gap-1', className)} role="img" aria-label={label}>
      {servers.map((server) => (
        <span
          key={server.serverId}
          aria-hidden="true"
          className="bg-muted-foreground h-1.5 w-1.5 shrink-0 rounded-full"
          style={server.color ? { backgroundColor: server.color } : undefined}
        />
      ))}
    </span>
  );
}
