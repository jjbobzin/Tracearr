import { describe, expect, it } from 'vitest';
import { dedupeServersById } from './dedupeServersById';

describe('dedupeServersById', () => {
  it('keeps the first entry seen for each serverId', () => {
    const result = dedupeServersById([
      { serverId: 'srv-1', name: 'Plex', type: 'plex' as const },
      { serverId: 'srv-1', name: 'Plex (dup)', type: 'plex' as const },
      { serverId: 'srv-2', name: 'Jellyfin', type: 'jellyfin' as const },
    ]);

    expect(result).toEqual([
      { serverId: 'srv-1', name: 'Plex', type: 'plex' },
      { serverId: 'srv-2', name: 'Jellyfin', type: 'jellyfin' },
    ]);
  });

  it('returns an empty array for an empty input', () => {
    expect(dedupeServersById([])).toEqual([]);
  });
});
