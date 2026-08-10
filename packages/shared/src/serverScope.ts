/**
 * Server-scope selection shared by web and mobile so the cache-key convention
 * and the query-param encoding exist in exactly one place.
 *
 * Param strategy is version-skew aware for mobile: self-hosted servers older
 * than 2026-02-20 (f1697c66) strip the unknown `serverIds` param, so All sends
 * nothing and a single server uses the legacy `serverId` param — both correct
 * on every server version a mobile app can pair with. Only a 2+ subset needs
 * the plural param.
 *
 * A subset scope built directly (not through `serverScopeFromIds`) is expected
 * to carry unique ids already — the caller guarantees this. `serverScopeKey`
 * and `serverScopeParamEntries` do not dedupe.
 */

export type ServerScope = { mode: 'all' } | { mode: 'subset'; serverIds: string[] };

export const ALL_SERVERS: ServerScope = { mode: 'all' };

export function serverScopeFromIds(ids?: readonly string[] | null): ServerScope {
  if (!ids || ids.length === 0) return ALL_SERVERS;
  return { mode: 'subset', serverIds: [...new Set(ids)] };
}

/** Cache-key segment: 'all' or the sorted ids joined with ','. */
export function serverScopeKey(scope: ServerScope): string {
  if (scope.mode === 'all' || scope.serverIds.length === 0) return 'all';
  return [...scope.serverIds].sort().join(',');
}

/** Query-param entries in append form so array encoding is unambiguous. */
export function serverScopeParamEntries(scope: ServerScope): [string, string][] {
  if (scope.mode === 'all' || scope.serverIds.length === 0) return [];
  const first = scope.serverIds[0];
  if (scope.serverIds.length === 1 && first !== undefined) return [['serverId', first]];
  return scope.serverIds.map((id): [string, string] => ['serverIds', id]);
}
