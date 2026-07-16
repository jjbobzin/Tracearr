import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { getName as getCountryNameFromCode } from 'country-list';
import { formatEpisodeLabel, type MediaType } from '@tracearr/shared';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Convert ISO 3166-1 alpha-2 country code to full country name.
 * Returns the original value if not a recognized code (e.g., "Local Network").
 */
export function getCountryName(code: string | null | undefined): string | null {
  if (!code) return null;
  const name = getCountryNameFromCode(code) ?? code;
  // Strip ISO 3166-1 article suffixes like "(the)", "(The)"
  return name.replace(/\s*\([Tt]he\)$/, '');
}

/**
 * Compact location string: "City, Region" → "City, Country" → Country → null.
 * Suitable for table cells, card footers, and other space-constrained displays.
 */
export function formatLocationCompact(
  city: string | null | undefined,
  region: string | null | undefined,
  country: string | null | undefined
): string | null {
  const countryName = getCountryName(country);
  if (city && region) return `${city}, ${region}`;
  if (city && countryName) return `${city}, ${countryName}`;
  return city ?? countryName ?? null;
}

export function formatLocationDisplay(
  locationName: string | null | undefined,
  city: string | null | undefined,
  region: string | null | undefined,
  country: string | null | undefined
): string | null {
  return locationName ?? formatLocationCompact(city, region, country);
}

/**
 * Media display fields interface for formatting media titles
 */
interface MediaDisplayFields {
  mediaType: MediaType | null;
  mediaTitle: string | null;
  grandparentTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  year?: number | null;
  artistName?: string | null;
  albumName?: string | null;
}

/**
 * Get display title for media (handles TV shows vs movies vs music)
 * Formats media information consistently across the application.
 *
 * @param media - Media object with display fields
 * @returns Object with title and subtitle for display
 */
export function getMediaDisplay(media: MediaDisplayFields): {
  title: string;
  subtitle: string | null;
} {
  if (media.mediaType === 'episode' && media.grandparentTitle) {
    // TV Show episode
    const episodeInfo =
      formatEpisodeLabel(media.seasonNumber, media.episodeNumber, {
        spaced: true,
      }) ?? '';
    return {
      title: media.grandparentTitle,
      subtitle: episodeInfo
        ? `${episodeInfo} · ${media.mediaTitle ?? ''}`
        : (media.mediaTitle ?? null),
    };
  }
  if (media.mediaType === 'track') {
    // Music track - show track name as title, artist/album as subtitle
    const parts: string[] = [];
    if (media.artistName) parts.push(media.artistName);
    if (media.albumName) parts.push(media.albumName);
    return {
      title: media.mediaTitle ?? '',
      subtitle: parts.length > 0 ? parts.join(' · ') : null,
    };
  }
  // Movie or other
  return {
    title: media.mediaTitle ?? '',
    subtitle: media.year ? `${media.year}` : null,
  };
}
