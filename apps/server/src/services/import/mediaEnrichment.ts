/**
 * Media Enrichment
 *
 * Batch fetch season/episode/year/thumbnail and music metadata from the
 * Jellyfin/Emby /Items API. Shared by the Jellystat and Playback Reporting importers.
 */

import { shouldFilterItem } from '../mediaServer/shared/jellyfinEmbyUtils.js';

/**
 * Media enrichment data from Jellyfin/Emby API
 */
export interface MediaEnrichment {
  seasonNumber?: number;
  episodeNumber?: number;
  year?: number;
  thumbPath?: string;
  // Music track metadata
  artistName?: string;
  albumName?: string;
  trackNumber?: number;
  discNumber?: number;
  /** Item should be filtered (theme song, theme video, trailer, etc.) */
  filtered?: boolean;
  /** Item type from media server API (Audio, Movie, Episode, etc.) */
  itemType?: string;
  runtimeMs?: number;
}

/**
 * Interface for clients that support getItems (both Jellyfin and Emby)
 */
export interface MediaServerClientWithItems {
  getItems(ids: string[]): Promise<
    {
      Id: string;
      Type?: string;
      ExtraType?: string;
      ParentIndexNumber?: number;
      IndexNumber?: number;
      ProductionYear?: number;
      ImageTags?: { Primary?: string };
      // Episode series info for poster lookup
      SeriesId?: string;
      SeriesPrimaryImageTag?: string;
      // Music track metadata
      Album?: string;
      AlbumArtist?: string;
      Artists?: string[];
      AlbumId?: string;
      AlbumPrimaryImageTag?: string;
      RunTimeTicks?: number;
    }[]
  >;
}

/**
 * Batch fetch media enrichment data from Jellyfin/Emby
 */
export async function fetchMediaEnrichment(
  client: MediaServerClientWithItems,
  mediaIds: string[]
): Promise<Map<string, MediaEnrichment>> {
  const enrichmentMap = new Map<string, MediaEnrichment>();

  if (mediaIds.length === 0) return enrichmentMap;

  try {
    const items = await client.getItems(mediaIds);

    for (const item of items) {
      if (!item.Id) continue;

      const enrichment: MediaEnrichment = {};

      // Check if this item should be filtered (theme songs, theme videos, trailers, etc.)
      if (
        shouldFilterItem({
          Type: item.Type ?? '',
          ExtraType: item.ExtraType,
          ProviderIds: {},
        })
      ) {
        enrichment.filtered = true;
        enrichmentMap.set(item.Id, enrichment);
        continue;
      }

      if (item.ParentIndexNumber != null) {
        enrichment.seasonNumber = item.ParentIndexNumber;
      }
      if (item.IndexNumber != null) {
        enrichment.episodeNumber = item.IndexNumber;
      }
      if (item.ProductionYear != null) {
        enrichment.year = item.ProductionYear;
      }

      // For episodes, use series poster if available (preferred for consistency with live sessions)
      // Fall back to episode's own image if series info is missing
      if (item.SeriesId && item.SeriesPrimaryImageTag) {
        enrichment.thumbPath = `/Items/${item.SeriesId}/Images/Primary`;
      } else if (item.AlbumId && item.AlbumPrimaryImageTag) {
        // For music tracks, use album art
        enrichment.thumbPath = `/Items/${item.AlbumId}/Images/Primary`;
      } else if (item.ImageTags?.Primary) {
        enrichment.thumbPath = `/Items/${item.Id}/Images/Primary`;
      }

      // Music track metadata
      // For compilations ("Various Artists"), prefer track artist; otherwise prefer album artist
      // This matches the poller's extractMusicMetadata logic
      const albumArtist = item.AlbumArtist?.slice(0, 255);
      const trackArtist = item.Artists?.[0]?.slice(0, 255);
      const isCompilation = albumArtist?.toLowerCase() === 'various artists';
      const artistName = isCompilation ? trackArtist || albumArtist : albumArtist || trackArtist;
      if (artistName) {
        enrichment.artistName = artistName;
      }
      if (item.Album) {
        enrichment.albumName = item.Album.slice(0, 255);
      }
      // For music: IndexNumber is track number, ParentIndexNumber is disc number
      // These overlap with episode fields but are applied based on mediaType later
      if (item.IndexNumber != null) {
        enrichment.trackNumber = item.IndexNumber;
      }
      if (item.ParentIndexNumber != null) {
        enrichment.discNumber = item.ParentIndexNumber;
      }

      // Store item type for accurate media type detection
      if (item.Type) {
        enrichment.itemType = item.Type;
      }

      if (item.RunTimeTicks != null && item.RunTimeTicks > 0) {
        enrichment.runtimeMs = Math.floor(item.RunTimeTicks / 10000);
      }

      if (Object.keys(enrichment).length > 0) {
        enrichmentMap.set(item.Id, enrichment);
      }
    }
  } catch (error) {
    console.warn('[Import] Media enrichment batch failed:', error);
  }

  return enrichmentMap;
}
