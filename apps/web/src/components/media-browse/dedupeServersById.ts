import type { ServerDotEntry } from './ServerDots';

/**
 * Deduplicates by serverId, keeping the first entry seen for each server - a
 * title can have two library_items on the same server (e.g. a film and its
 * trailer), and that must still read as one row/dot for that server, not two.
 * Callers that care about which entry "first" means (e.g. earliest addedAt)
 * should sort before calling this.
 */
export function dedupeServersById<T extends ServerDotEntry>(servers: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const server of servers) {
    if (seen.has(server.serverId)) continue;
    seen.add(server.serverId);
    deduped.push(server);
  }
  return deduped;
}
