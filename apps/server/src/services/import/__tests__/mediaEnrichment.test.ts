import { describe, it, expect } from 'vitest';
import { fetchMediaEnrichment, type MediaServerClientWithItems } from '../mediaEnrichment.js';

describe('fetchMediaEnrichment', () => {
  it('converts RunTimeTicks to runtimeMs alongside season/episode data', async () => {
    const client: MediaServerClientWithItems = {
      getItems: async () => [
        {
          Id: 'x',
          Type: 'Episode',
          ParentIndexNumber: 2,
          IndexNumber: 5,
          RunTimeTicks: 26_400_000_000,
        },
      ],
    };

    const result = await fetchMediaEnrichment(client, ['x']);

    // ParentIndexNumber/IndexNumber double as disc/track number regardless of
    // item type; the caller picks the fields relevant to its mediaType.
    expect(result.get('x')).toEqual({
      seasonNumber: 2,
      episodeNumber: 5,
      discNumber: 2,
      trackNumber: 5,
      itemType: 'Episode',
      runtimeMs: 2_640_000,
    });
  });

  it('omits runtimeMs when RunTimeTicks is zero', async () => {
    const client: MediaServerClientWithItems = {
      getItems: async () => [
        {
          Id: 'x',
          Type: 'Episode',
          ParentIndexNumber: 2,
          IndexNumber: 5,
          RunTimeTicks: 0,
        },
      ],
    };

    const result = await fetchMediaEnrichment(client, ['x']);

    expect(result.get('x')).toEqual({
      seasonNumber: 2,
      episodeNumber: 5,
      discNumber: 2,
      trackNumber: 5,
      itemType: 'Episode',
    });
    expect(result.get('x')).not.toHaveProperty('runtimeMs');
  });
});
