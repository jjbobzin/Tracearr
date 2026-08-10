/**
 * React Query hooks for library statistics endpoints
 *
 * All hooks follow the same patterns:
 * - 5-minute staleTime (library data updates daily)
 * - Timezone included in queryKey for endpoints that use it
 * - Consistent queryKey structure: ['library', endpoint, ...params, timezone?]
 */

import { useQuery } from '@tanstack/react-query';
import { serverScopeFromIds, serverScopeKey } from '@tracearr/shared';
import { api, getBrowserTimezone } from '@/lib/api';
import type { LibraryStatusResponse } from '@/lib/api';
import type {
  LibraryStatsResponse,
  LibraryGrowthResponse,
  LibraryQualityResponse,
  LibraryStorageResponse,
  DuplicatesResponse,
  StaleResponse,
  WatchResponse,
  CompletionResponse,
  PatternsResponse,
  RoiResponse,
  TopMoviesResponse,
  TopShowsResponse,
  LibraryCodecsResponse,
  LibraryResolutionResponse,
} from '@tracearr/shared';

// 5 minutes - library data is updated once daily
const LIBRARY_STALE_TIME = 1000 * 60 * 5;

/**
 * Fetch current library statistics (item counts, size, quality breakdown).
 * Backend deduplicates item counts and sums storage across servers.
 */
export function useLibraryStats(serverIds: string[], libraryId?: string | null) {
  const timezone = getBrowserTimezone();
  const sortedIds = serverScopeKey(serverScopeFromIds(serverIds));
  return useQuery<LibraryStatsResponse>({
    queryKey: ['library', 'stats', sortedIds, libraryId, timezone],
    queryFn: () => api.library.stats(serverIds, libraryId ?? undefined),
    staleTime: LIBRARY_STALE_TIME,
    enabled: serverIds.length > 0,
  });
}

/**
 * Fetch library growth timeline (additions/removals over time).
 * Each data point carries a serverId; Overview aggregates across servers before charting.
 */
export function useLibraryGrowth(
  serverIds: string[],
  libraryId?: string | null,
  period: string = '30d',
  startDate?: string,
  endDate?: string
) {
  const timezone = getBrowserTimezone();
  const sortedIds = serverScopeKey(serverScopeFromIds(serverIds));
  return useQuery<LibraryGrowthResponse>({
    queryKey: ['library', 'growth', sortedIds, libraryId, period, startDate, endDate, timezone],
    queryFn: () =>
      api.library.growth(serverIds, libraryId ?? undefined, period, startDate, endDate),
    staleTime: LIBRARY_STALE_TIME,
    enabled: serverIds.length > 0,
  });
}

/**
 * Fetch library quality evolution (resolution breakdown over time)
 * @param mediaType - Filter by media type: 'all' | 'movies' | 'shows'
 */
export function useLibraryQuality(
  serverId?: string | null,
  period: string = '30d',
  mediaType: 'all' | 'movies' | 'shows' = 'all',
  enabled: boolean = true
) {
  const timezone = getBrowserTimezone();
  return useQuery<LibraryQualityResponse>({
    queryKey: ['library', 'quality', serverId, period, mediaType, timezone],
    queryFn: () => api.library.quality(serverId ?? undefined, period, mediaType),
    staleTime: LIBRARY_STALE_TIME,
    enabled,
  });
}

/**
 * Fetch storage analytics with growth predictions
 */
export function useLibraryStorage(
  serverId?: string | null,
  libraryId?: string | null,
  period: string = '30d'
) {
  const timezone = getBrowserTimezone();
  return useQuery<LibraryStorageResponse>({
    queryKey: ['library', 'storage', serverId, libraryId, period, timezone],
    queryFn: () => api.library.storage(serverId ?? undefined, libraryId ?? undefined, period),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch storage analytics over the whole server selection in one request, so
 * the server-side mirror dedup spans servers. Used for the combined KPI;
 * per-server charts keep the fan-out.
 */
export function useLibraryStorageScoped(
  serverIds: string[],
  period: string = '30d',
  enabled: boolean = true
) {
  const timezone = getBrowserTimezone();
  const sortedIds = serverScopeKey(serverScopeFromIds(serverIds));
  return useQuery<LibraryStorageResponse>({
    queryKey: ['library', 'storage', 'scoped', sortedIds, period, timezone],
    queryFn: () => api.library.storageScoped(serverIds, period),
    staleTime: LIBRARY_STALE_TIME,
    enabled: enabled && serverIds.length > 0,
  });
}

/**
 * Fetch cross-server duplicate detection results
 * @param enabled - Set to false to skip fetching (e.g., when only one server is selected)
 */
export function useLibraryDuplicates(
  serverIds: string[],
  page: number = 1,
  pageSize: number = 20,
  enabled: boolean = true
) {
  const sortedIds = serverScopeKey(serverScopeFromIds(serverIds));
  return useQuery<DuplicatesResponse>({
    queryKey: ['library', 'duplicates', sortedIds, page, pageSize],
    queryFn: () => api.library.duplicates(serverIds, page, pageSize),
    staleTime: LIBRARY_STALE_TIME,
    enabled,
  });
}

/**
 * Fetch stale/unwatched content analysis - combined across all selected servers.
 */
export function useLibraryStale(
  serverIds: string[],
  libraryId?: string | null,
  staleDays: number = 90,
  category: 'all' | 'never_watched' | 'stale' = 'all',
  page: number = 1,
  pageSize: number = 20,
  mediaType?: 'movie' | 'show' | 'artist',
  sortBy: 'size' | 'title' | 'days_stale' | 'added_at' = 'size',
  sortOrder: 'asc' | 'desc' = 'desc'
) {
  const sortedIds = serverScopeKey(serverScopeFromIds(serverIds));
  return useQuery<StaleResponse>({
    queryKey: [
      'library',
      'stale',
      sortedIds,
      libraryId,
      staleDays,
      category,
      page,
      pageSize,
      mediaType,
      sortBy,
      sortOrder,
    ],
    queryFn: () =>
      api.library.stale(
        serverIds,
        libraryId ?? undefined,
        staleDays,
        category,
        page,
        pageSize,
        mediaType,
        sortBy,
        sortOrder
      ),
    staleTime: LIBRARY_STALE_TIME,
    enabled: serverIds.length > 0,
  });
}

/**
 * Fetch per-item watch statistics across one or more servers.
 * Summary counts (watchedCount, totalItems, completedCount) are deduped by the backend.
 * totalWatchMs is summed. Items are deduped per title with serverIds[] attached.
 */
export function useLibraryWatch(
  serverIds: string[],
  libraryId?: string | null,
  page: number = 1,
  pageSize: number = 20
) {
  const sortedIds = serverScopeKey(serverScopeFromIds(serverIds));
  return useQuery<WatchResponse>({
    queryKey: ['library', 'watch', sortedIds, libraryId, page, pageSize],
    queryFn: () => api.library.watch(serverIds, libraryId ?? undefined, page, pageSize),
    staleTime: LIBRARY_STALE_TIME,
    enabled: serverIds.length > 0,
  });
}

/**
 * Fetch completion rate analysis (item/season/series level)
 */
export function useLibraryCompletion(
  serverId?: string | null,
  libraryId?: string | null,
  aggregateLevel: string = 'item',
  page: number = 1,
  pageSize: number = 20,
  mediaType?: 'movie' | 'episode'
) {
  return useQuery<CompletionResponse>({
    queryKey: [
      'library',
      'completion',
      serverId,
      libraryId,
      aggregateLevel,
      page,
      pageSize,
      mediaType,
    ],
    // Skip when no server is targeted (multi-server pages render per-server cards instead)
    enabled: serverId != null,
    queryFn: () =>
      api.library.completion(
        serverId ?? undefined,
        libraryId ?? undefined,
        aggregateLevel,
        page,
        pageSize,
        mediaType
      ),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch watch patterns analysis (binge shows, peak times, trends) across one or more servers.
 * Hourly/monthly/peak are aggregated by the backend. BingeShow rows are deduped by show.
 */
export function useLibraryPatterns(
  serverIds: string[],
  libraryId?: string | null,
  periodWeeks: number = 12
) {
  const timezone = getBrowserTimezone();
  const sortedIds = serverScopeKey(serverScopeFromIds(serverIds));
  return useQuery<PatternsResponse>({
    queryKey: ['library', 'patterns', sortedIds, libraryId, periodWeeks, timezone],
    queryFn: () => api.library.patterns(serverIds, libraryId ?? undefined, periodWeeks),
    staleTime: LIBRARY_STALE_TIME,
    enabled: serverIds.length > 0,
  });
}

/**
 * Fetch content ROI analysis - combined across all selected servers.
 */
export function useLibraryRoi(
  serverIds: string[],
  libraryId?: string | null,
  page: number = 1,
  pageSize: number = 20,
  mediaType?: 'movie' | 'show' | 'artist',
  sortBy: 'watch_hours_per_gb' | 'value_score' | 'file_size' | 'title' = 'watch_hours_per_gb',
  sortOrder: 'asc' | 'desc' = 'asc'
) {
  const timezone = getBrowserTimezone();
  const sortedIds = serverScopeKey(serverScopeFromIds(serverIds));
  return useQuery<RoiResponse>({
    queryKey: [
      'library',
      'roi',
      sortedIds,
      libraryId,
      page,
      pageSize,
      mediaType,
      sortBy,
      sortOrder,
      timezone,
    ],
    queryFn: () =>
      api.library.roi(
        serverIds,
        libraryId ?? undefined,
        page,
        pageSize,
        mediaType,
        sortBy,
        sortOrder
      ),
    staleTime: LIBRARY_STALE_TIME,
    enabled: serverIds.length > 0,
  });
}

/**
 * Fetch top movies by engagement metrics across one or more servers.
 */
export function useTopMovies(
  serverIds: string[],
  period: string = '30d',
  sortBy: string = 'plays',
  sortOrder: string = 'desc',
  page: number = 1,
  pageSize: number = 20
) {
  const sortedIds = serverScopeKey(serverScopeFromIds(serverIds));
  return useQuery<TopMoviesResponse>({
    queryKey: ['library', 'top-movies', sortedIds, period, sortBy, sortOrder, page, pageSize],
    queryFn: () => api.library.topMovies(serverIds, period, sortBy, sortOrder, page, pageSize),
    staleTime: LIBRARY_STALE_TIME,
    enabled: serverIds.length > 0,
  });
}

/**
 * Fetch top TV shows by engagement metrics across one or more servers.
 */
export function useTopShows(
  serverIds: string[],
  period: string = '30d',
  sortBy: string = 'plays',
  sortOrder: string = 'desc',
  page: number = 1,
  pageSize: number = 20
) {
  const sortedIds = serverScopeKey(serverScopeFromIds(serverIds));
  return useQuery<TopShowsResponse>({
    queryKey: ['library', 'top-shows', sortedIds, period, sortBy, sortOrder, page, pageSize],
    queryFn: () => api.library.topShows(serverIds, period, sortBy, sortOrder, page, pageSize),
    staleTime: LIBRARY_STALE_TIME,
    enabled: serverIds.length > 0,
  });
}

/**
 * Fetch codec distribution for library items
 */
export function useLibraryCodecs(serverId?: string | null, libraryId?: string | null) {
  return useQuery<LibraryCodecsResponse>({
    queryKey: ['library', 'codecs', serverId, libraryId],
    queryFn: () => api.library.codecs(serverId ?? undefined, libraryId ?? undefined),
    staleTime: LIBRARY_STALE_TIME,
  });
}

/**
 * Fetch resolution distribution for library items (movies vs TV)
 */
export function useLibraryResolution(serverId?: string | null, libraryId?: string | null) {
  return useQuery<LibraryResolutionResponse>({
    queryKey: ['library', 'resolution', serverId, libraryId],
    queryFn: () => api.library.resolution(serverId ?? undefined, libraryId ?? undefined),
    staleTime: LIBRARY_STALE_TIME,
  });
}

export type { LibraryStatusResponse } from '@/lib/api';

export interface LibraryStatusFanOut {
  byServer: Map<string, { data?: LibraryStatusResponse; isLoading: boolean }>;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
}

/** Fetch sync/backfill status for every selected server in one request. */
export function useLibraryStatus(serverIds: string[]): LibraryStatusFanOut {
  const sortedIds = serverScopeKey(serverScopeFromIds(serverIds));
  const query = useQuery<Record<string, LibraryStatusResponse>>({
    queryKey: ['library', 'status', sortedIds],
    queryFn: () => api.library.status(serverIds),
    staleTime: 1000 * 30,
    enabled: serverIds.length > 0,
  });

  const byServer = new Map(
    serverIds.map((id) => [id, { data: query.data?.[id], isLoading: query.isLoading }])
  );

  return {
    byServer,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
  };
}
