import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Clock, AlertTriangle, Tv, MapPin, Calendar, Users, Activity } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { StatCard } from '@/components/ui/stat-card';
import { NowPlayingCard } from '@/components/sessions';
import { StreamCard } from '@/components/map';
import { SessionDetailSheet } from '@/components/history/SessionDetailSheet';
import { ServerResourceCharts } from '@/components/charts/ServerResourceCharts';
import { ServerBandwidthChart } from '@/components/charts/BandwidthChart';
import { ErrorState } from '@/components/library/ErrorState';
import { NowPlayingCardSkeleton } from '@/components/ui/skeleton';
import { useDashboardStats, useActiveSessions } from '@/hooks/queries';
import { useServerLiveStats, useMultiServerLiveStats } from '@/hooks/queries/useServers';
import { useServer } from '@/hooks/useServer';
import { useServerColorMap } from '@/hooks/useServerColorMap';
import { useSocket } from '@/hooks/useSocket';
import { pickServerColor, type ActiveSession } from '@tracearr/shared';

export function Dashboard() {
  const { t } = useTranslation(['pages', 'common']);
  const { selectedServerIds, selectedServers, isMultiServer, selectedServerId } = useServer();
  const { isConnected } = useSocket();
  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsError,
    error: statsErrorObj,
    refetch: refetchStats,
  } = useDashboardStats(selectedServerIds);
  const {
    data: sessions,
    isError: sessionsError,
    error: sessionsErrorObj,
    refetch: refetchSessions,
  } = useActiveSessions(selectedServerIds, isConnected);

  // Session detail sheet state
  const [selectedSession, setSelectedSession] = useState<ActiveSession | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const serverColorMap = useServerColorMap();

  // Sort sessions by server display order so cards group by server
  const sortedSessions = useMemo(() => {
    if (!sessions) return undefined;
    const orderMap = new Map(selectedServers.map((s) => [s.id, s.displayOrder ?? 0]));
    return [...sessions].sort(
      (a, b) => (orderMap.get(a.serverId) ?? 0) - (orderMap.get(b.serverId) ?? 0)
    );
  }, [sessions, selectedServers]);

  // Single-server view: Plex always shows the section; Jellyfin/Emby show it
  // once the SSE plugin's server.stats samples start arriving
  const singleServer = !isMultiServer ? selectedServers[0] : undefined;
  const singleIsPlex = singleServer?.type === 'plex';

  // Multi-server view fans out to every selected server and overlays one
  // line per server that reports data. Servers without a stats source yet
  // (Jellyfin/Emby until the SSE plugin samples them) return empty series
  // and contribute no line.
  const statsServerIds = useMemo(
    () => (isMultiServer ? selectedServers.map((s) => s.id) : []),
    [isMultiServer, selectedServers]
  );

  const {
    statistics: serverStats,
    statisticsAverages: averages,
    bandwidth: bandwidthStats,
    bandwidthAverages,
    clockSkewMs: singleClockSkewMs,
    isLoading: liveStatsLoading,
  } = useServerLiveStats(selectedServerId ?? undefined, !!singleServer);

  const showServerResources = !!singleServer && (singleIsPlex || (serverStats?.length ?? 0) > 0);

  // Plex measures bandwidth; Jellyfin/Emby have no source for it
  const showBandwidthChart =
    singleIsPlex || (isMultiServer && selectedServers.some((s) => s.type === 'plex'));
  const singleProcessLabel = singleServer
    ? { plex: 'Plex Media Server', jellyfin: 'Jellyfin', emby: 'Emby' }[singleServer.type]
    : undefined;

  const {
    series: multiLiveStats,
    clockSkewMs: multiClockSkewMs,
    isLoading: multiStatsLoading,
  } = useMultiServerLiveStats(statsServerIds, statsServerIds.length > 0);

  const clockSkewMs = showServerResources ? singleClockSkewMs : multiClockSkewMs;

  const hasAnyMultiData = multiLiveStats.some(
    (s) => s.statistics.length > 0 || s.bandwidth.length > 0
  );
  const showMultiServerResources =
    isMultiServer && (hasAnyMultiData || selectedServers.some((s) => s.type === 'plex'));

  const seriesMeta = useCallback(
    (serverId: string) => {
      const server = selectedServers.find((p) => p.id === serverId);
      return {
        serverId,
        serverName: server?.name ?? serverId,
        color:
          serverColorMap.get(serverId) ??
          pickServerColor(
            server?.type ?? 'plex',
            selectedServers.map((p) => p.color)
          ),
      };
    },
    [selectedServers, serverColorMap]
  );

  const resourceMultiSeries = useMemo(
    () =>
      showMultiServerResources
        ? multiLiveStats
            .filter((s) => s.statistics.length > 0)
            .map((s) => ({ ...seriesMeta(s.serverId), data: s.statistics }))
        : undefined,
    [showMultiServerResources, multiLiveStats, seriesMeta]
  );

  const bandwidthMultiSeries = useMemo(
    () =>
      showMultiServerResources
        ? multiLiveStats
            .filter((s) => s.bandwidth.length > 0)
            .map((s) => ({ ...seriesMeta(s.serverId), data: s.bandwidth }))
        : undefined,
    [showMultiServerResources, multiLiveStats, seriesMeta]
  );

  const activeCount = sessions?.length ?? 0;
  const hasActiveStreams = activeCount > 0;

  if (statsError || sessionsError) {
    return (
      <ErrorState
        title={t('common:errors.somethingWentWrong')}
        message={
          statsErrorObj?.message ?? sessionsErrorObj?.message ?? t('common:errors.unexpectedError')
        }
        onRetry={() => {
          void refetchStats();
          void refetchSessions();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Today Stats Section */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <Calendar className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t('common:time.today')}</h2>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            icon={AlertTriangle}
            label={t('dashboard.alerts')}
            value={stats?.alertsLast24h ?? 0}
            isLoading={statsLoading}
            href="/violations"
          />
          <StatCard
            icon={Play}
            label={t('dashboard.plays')}
            value={stats?.todayPlays ?? 0}
            isLoading={statsLoading}
            href="/history"
            subValue={
              stats?.todaySessions && stats.todaySessions > stats.todayPlays
                ? t('common:count.session', { count: stats.todaySessions })
                : undefined
            }
          />
          <StatCard
            icon={Clock}
            label={t('dashboard.watchTime')}
            value={`${stats?.watchTimeHours ?? 0}h`}
            isLoading={statsLoading}
            href="/stats/activity"
          />
          <StatCard
            icon={Users}
            label={t('dashboard.activeUsers')}
            value={stats?.activeUsersToday ?? 0}
            isLoading={statsLoading}
            href="/stats/users"
          />
        </div>
      </section>

      {/* Now Playing Section */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <Tv className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">{t('dashboard.nowPlaying')}</h2>
          {hasActiveStreams && (
            <span className="bg-muted text-foreground rounded-full px-2 py-0.5 text-xs font-medium">
              {t('common:count.stream', { count: activeCount })}
            </span>
          )}
        </div>

        {!sortedSessions ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <NowPlayingCardSkeleton key={i} />
            ))}
          </div>
        ) : sortedSessions.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <div className="bg-muted rounded-full p-4">
                <Tv className="text-muted-foreground h-8 w-8" />
              </div>
              <h3 className="mt-4 font-semibold">{t('dashboard.noActiveStreams')}</h3>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('dashboard.streamsAppearHere')}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {sortedSessions.map((session) => (
              <NowPlayingCard
                key={session.id}
                session={session}
                onClick={() => {
                  setSelectedSession(session);
                  setSheetOpen(true);
                }}
              />
            ))}
          </div>
        )}
      </section>

      {/* Stream Map - only show when there are active streams */}
      {hasActiveStreams && (
        <section>
          <div className="mb-4 flex items-center gap-2">
            <MapPin className="text-primary h-5 w-5" />
            <h2 className="text-lg font-semibold">{t('dashboard.streamLocations')}</h2>
          </div>
          <Card className="overflow-hidden">
            <StreamCard
              sessions={sessions}
              height={320}
              isMultiServer={isMultiServer}
              serverColorMap={serverColorMap}
            />
          </Card>
        </section>
      )}

      {/* Server Resource Stats (single server, or per-server overlay lines) */}
      {(showServerResources || showMultiServerResources) && (
        <section>
          <div className="mb-4 flex items-center gap-2">
            <Activity className="text-primary h-5 w-5" />
            <h2 className="text-lg font-semibold">{t('dashboard.serverResources')}</h2>
          </div>
          <div className={`grid gap-4 ${showBandwidthChart ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
            <ServerResourceCharts
              data={showServerResources ? serverStats : undefined}
              isLoading={
                showServerResources ? liveStatsLoading : multiStatsLoading && !hasAnyMultiData
              }
              averages={showServerResources ? averages : undefined}
              multiSeries={showMultiServerResources ? resourceMultiSeries : undefined}
              processLabel={singleProcessLabel}
              clockSkewMs={clockSkewMs}
            />
            {showBandwidthChart && (
              <ServerBandwidthChart
                data={showServerResources ? bandwidthStats : undefined}
                isLoading={
                  showServerResources ? liveStatsLoading : multiStatsLoading && !hasAnyMultiData
                }
                averages={showServerResources ? bandwidthAverages : undefined}
                multiSeries={showMultiServerResources ? bandwidthMultiSeries : undefined}
                clockSkewMs={clockSkewMs}
              />
            )}
          </div>
        </section>
      )}

      {/* Session Detail Sheet */}
      <SessionDetailSheet session={selectedSession} open={sheetOpen} onOpenChange={setSheetOpen} />
    </div>
  );
}
