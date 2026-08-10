/**
 * Dynamic Range Classification
 *
 * Normalizes a media server's HDR/SDR label - Plex's Media.videoDynamicRange
 * attribute, or Jellyfin/Emby's VideoRangeType mapped to a display string -
 * into one lowercase token that library_items.video_dynamic_range stores and
 * the catalog HDR filter matches against. The token list is display
 * vocabulary, not an exhaustive allowlist: normalizeDynamicRange falls back
 * to lowercasing an unrecognized label rather than dropping it, so an HDR
 * variant Tracearr hasn't named yet still counts as non-SDR.
 */

export const DYNAMIC_RANGE_SDR_TOKEN = 'sdr';

export const DYNAMIC_RANGE_TOKENS = [
  'sdr',
  'hdr',
  'hdr10',
  'hdr10+',
  'hlg',
  'dolby vision',
] as const;

export type DynamicRangeToken = (typeof DYNAMIC_RANGE_TOKENS)[number];

const KNOWN_TOKENS: readonly string[] = DYNAMIC_RANGE_TOKENS;

export function normalizeDynamicRange(label: string | null | undefined): string | null {
  if (!label) return null;
  const lower = label.toLowerCase().trim();
  if (!lower) return null;

  if (KNOWN_TOKENS.includes(lower)) return lower;
  if (lower.startsWith('dolby vision') || lower === 'dovi' || lower === 'dv') return 'dolby vision';
  if (lower.includes('hdr10+')) return 'hdr10+';
  if (lower.includes('hdr10')) return 'hdr10';
  if (lower.includes('hlg')) return 'hlg';
  if (lower.includes('hdr')) return 'hdr';
  if (lower.includes('sdr')) return DYNAMIC_RANGE_SDR_TOKEN;

  // library_items.video_dynamic_range is varchar(20); an oversized unknown
  // label must not fail the whole sync upsert batch.
  return lower.slice(0, 20);
}
