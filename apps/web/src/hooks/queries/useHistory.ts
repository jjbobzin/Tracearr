import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { serverScopeFromIds, serverScopeKey } from '@tracearr/shared';
import type { HistoryQueryInput, HistoryAggregatesQueryInput } from '@tracearr/shared';
import { api } from '@/lib/api';

export interface HistoryFilters {
  serverUserIds?: string[];
  serverIds?: string[];
  state?: 'playing' | 'paused' | 'stopped';
  mediaTypes?: ('movie' | 'episode' | 'track' | 'live')[];
  startDate?: Date;
  endDate?: Date;
  search?: string;
  platforms?: string[];
  product?: string;
  device?: string;
  playerName?: string;
  ipAddress?: string;
  geoCountries?: string[];
  geoCity?: string;
  geoRegion?: string;
  transcodeDecisions?: ('directplay' | 'copy' | 'transcode')[];
  watched?: boolean;
  excludeShortSessions?: boolean;
  orderBy?: 'startedAt' | 'durationMs' | 'mediaTitle';
  orderDir?: 'asc' | 'desc';
}

export function useHistorySessions(filters: HistoryFilters = {}, pageSize = 50) {
  const serverIdsKey = serverScopeKey(serverScopeFromIds(filters.serverIds));
  return useInfiniteQuery({
    queryKey: ['sessions', 'history', { ...filters, serverIds: serverIdsKey }, pageSize],
    queryFn: async ({ pageParam }) => {
      const params: Partial<HistoryQueryInput> & { cursor?: string; serverIds?: string[] } = {
        ...filters,
        pageSize,
        cursor: pageParam,
      };
      return api.sessions.history(params);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 1000 * 60 * 2,
    refetchOnWindowFocus: false,
    placeholderData: (prev) => prev,
  });
}

export type AggregateFilters = Partial<HistoryAggregatesQueryInput> & { serverIds?: string[] };

export function useHistoryAggregates(filters: AggregateFilters = {}) {
  const serverIdsKey = serverScopeKey(serverScopeFromIds(filters.serverIds));
  return useQuery({
    queryKey: ['sessions', 'history', 'aggregates', { ...filters, serverIds: serverIdsKey }],
    queryFn: () => api.sessions.historyAggregates(filters),
    staleTime: 1000 * 60,
    placeholderData: (prev) => prev,
  });
}

export function useFilterOptions(params?: {
  serverIds?: string[];
  startDate?: Date;
  endDate?: Date;
}) {
  const serverIdsKey = serverScopeKey(serverScopeFromIds(params?.serverIds));
  return useQuery({
    queryKey: [
      'sessions',
      'filter-options',
      serverIdsKey,
      params?.startDate?.toISOString(),
      params?.endDate?.toISOString(),
    ],
    queryFn: () => api.sessions.filterOptions(params),
    staleTime: 1000 * 60 * 5,
  });
}

/**
 * Query for filter options for the rules builder.
 * Returns all countries (with hasSessions indicator) and servers.
 */
export function useRulesFilterOptions() {
  return useQuery({
    queryKey: ['sessions', 'filter-options', 'rules'],
    queryFn: () => api.sessions.rulesFilterOptions(),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
