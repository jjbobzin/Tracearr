/**
 * Resolution Classification
 *
 * Single source of truth for turning a media server's resolution label
 * and/or video dimensions into a display resolution tier ("4K", "1080p",
 * etc). Every classifier in the app (session ingest, library sync, rules,
 * web/mobile display) should go through this module instead of hand-rolling
 * its own width/height cutoffs.
 */

/** Resolution tier rank (higher = better quality). Order is the vocabulary. */
export const RESOLUTION_TIERS = {
  '8K': 7,
  '4K': 6,
  '1440p': 5,
  '1080p': 4,
  '720p': 3,
  '480p': 2,
  SD: 1,
} as const;

export type ResolutionLabel = keyof typeof RESOLUTION_TIERS;

interface DimensionTier {
  label: ResolutionLabel;
  minWidth: number;
  minHeight: number;
}

const DIMENSION_LADDER: DimensionTier[] = [
  { label: '8K', minWidth: 6400, minHeight: 4000 },
  { label: '4K', minWidth: 3800, minHeight: 2000 },
  { label: '1440p', minWidth: 2500, minHeight: 1400 },
  { label: '1080p', minWidth: 1800, minHeight: 1000 },
  { label: '720p', minWidth: 1200, minHeight: 700 },
  { label: '480p', minWidth: 700, minHeight: 400 },
];

export function classifyByDimensions(
  width: number | null | undefined,
  height: number | null | undefined
): ResolutionLabel | null {
  if (!width && !height) return null;

  for (const tier of DIMENSION_LADDER) {
    if ((width && width >= tier.minWidth) || (height && height >= tier.minHeight)) {
      return tier.label;
    }
  }

  return 'SD';
}

/** Known resolution label spellings from Plex/Jellyfin/Emby/Tautulli. */
const LABEL_MAP: Record<string, ResolutionLabel> = {
  '8k': '8K',
  '4320': '8K',
  '4320p': '8K',
  '4k': '4K',
  uhd: '4K',
  '2160': '4K',
  '2160p': '4K',
  '2k': '1440p',
  qhd: '1440p',
  '1440': '1440p',
  '1440p': '1440p',
  '1080': '1080p',
  '1080p': '1080p',
  fhd: '1080p',
  '720': '720p',
  '720p': '720p',
  hd: '720p',
  '480': '480p',
  '480p': '480p',
  sd: 'SD',
};

export function normalizeResolutionLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const lower = label.toLowerCase().trim();
  if (!lower) return null;

  const mapped = LABEL_MAP[lower];
  if (mapped) return mapped;

  if (/^\d+$/.test(lower)) return `${lower}p`;

  return label;
}

/** Rank of a resolution label for magnitude comparisons, or null if unknown. */
export function resolutionTierRank(label: string | null | undefined): number | null {
  const normalized = normalizeResolutionLabel(label);
  if (!normalized || !(normalized in RESOLUTION_TIERS)) return null;
  return RESOLUTION_TIERS[normalized as ResolutionLabel];
}

/** The four-bucket vocabulary library snapshots and facet endpoints store. */
export type ResolutionBucket = '4k' | '1080p' | '720p' | 'sd';

/**
 * Fold a stored resolution label into the four-bucket vocabulary. Tiers above
 * 1080p (1440p, 8K) fold into 4k, the closest bucket, rather than dropping to
 * sd. Unknown non-null labels count as sd; null stays null (no video).
 */
export function resolutionBucket(label: string | null | undefined): ResolutionBucket | null {
  if (!label) return null;
  const rank = resolutionTierRank(label);
  if (rank !== null && rank >= RESOLUTION_TIERS['1440p']) return '4k';
  if (rank === RESOLUTION_TIERS['1080p']) return '1080p';
  if (rank === RESOLUTION_TIERS['720p']) return '720p';
  return 'sd';
}

/**
 * Every known spelling that folds into the given bucket, lowercase. Backs the
 * SQL IN-lists in resolutionBuckets.ts so database bucketing cannot drift
 * from resolutionBucket(). The sd bucket has no list: in SQL it is the
 * non-null complement of the other three.
 */
export function resolutionBucketSpellings(bucket: Exclude<ResolutionBucket, 'sd'>): string[] {
  return Object.keys(LABEL_MAP).filter((key) => resolutionBucket(key) === bucket);
}

/** All spellings that rank above the sd bucket, for SQL complement predicates. */
export function resolutionAboveSdSpellings(): string[] {
  return Object.keys(LABEL_MAP).filter((key) => resolutionBucket(key) !== 'sd');
}

/** Known spellings paired with their tier rank, for SQL rank CASE expressions. */
export function resolutionSpellingRanks(): Array<{ spelling: string; rank: number }> {
  return Object.keys(LABEL_MAP).map((spelling) => ({
    spelling,
    rank: resolutionTierRank(spelling) ?? 0,
  }));
}

export interface ResolutionInput {
  /** Resolution label from the media server (e.g. "1080", "4k", "sd") */
  label?: string | null;
  /** Video width in pixels */
  width?: number | null;
  /** Video height in pixels */
  height?: number | null;
}

// Label wins over dimensions: Tautulli displays Plex's own videoResolution
// verbatim rather than recomputing it from pixels, since Plex already
// accounts for scan type/aspect ratio server-side. Dimensions are only the
// fallback when no label is available (Jellyfin/Emby, or a Plex transcode
// session where only source pixels survive).
export function normalizeResolution(input: ResolutionInput): string | null {
  const { label, width, height } = input;

  const fromLabel = normalizeResolutionLabel(label);
  if (fromLabel) return fromLabel;

  return classifyByDimensions(width, height);
}
