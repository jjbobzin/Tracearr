export interface MatchKeyInput {
  mediaType: string;
  imdbId?: string | null;
  tmdbId?: number | null;
  tvdbId?: number | null;
  musicBrainzId?: string | null;
  title?: string | null;
  year?: number | null;
  serverId: string;
  ratingKey: string;
  showMediaId?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  grandparentRatingKey?: string | null;
  parentRatingKey?: string | null;
  // Music context, meaning depends on mediaType like parentRatingKey does: track -> artist/album, album -> its own parent artist, artist -> unused.
  grandparentTitle?: string | null;
  parentTitle?: string | null;
}

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// Article-stripped variant backing media.sort_title; only for ordering, never
// for matching (stripping articles there would merge "The Office" with "Office")
export function buildSortTitle(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/^\s*(the|an|a)\s+/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

export function buildMediaMatchKey(input: MatchKeyInput): string {
  const { mediaType } = input;
  const localKey = `local:${input.serverId}:${input.ratingKey}`;

  if (mediaType === 'episode') {
    if (input.tvdbId) return `episode:tvdb:${input.tvdbId}`;
    if (input.imdbId) return `episode:imdb:${input.imdbId}`;
    if (input.tmdbId) return `episode:tmdb:${input.tmdbId}`;
    if (
      input.showMediaId &&
      input.seasonNumber != null &&
      input.seasonNumber > 0 &&
      input.episodeNumber != null
    ) {
      return `episode:${input.showMediaId}:s${input.seasonNumber}e${input.episodeNumber}`;
    }
    return localKey;
  }

  if (mediaType === 'season') {
    if (input.showMediaId && input.seasonNumber != null && input.seasonNumber >= 0) {
      return `season:${input.showMediaId}:s${input.seasonNumber}`;
    }
    return localKey;
  }

  if (mediaType === 'track' || mediaType === 'album' || mediaType === 'artist') {
    if (input.musicBrainzId) return `${mediaType}:mbid:${input.musicBrainzId}`;

    const titleNorm = input.title ? normalizeTitle(input.title) : '';
    if (!titleNorm) return localKey;

    if (mediaType === 'track') {
      const artist = input.grandparentTitle ? normalizeTitle(input.grandparentTitle) : '';
      const album = input.parentTitle ? normalizeTitle(input.parentTitle) : '';
      if (!artist && !album) return localKey;
      return `track:title:${artist}:${album}:${titleNorm}`;
    }
    if (mediaType === 'album') {
      const artist = input.parentTitle ? normalizeTitle(input.parentTitle) : '';
      if (!artist) return localKey;
      return `album:title:${artist}:${titleNorm}`;
    }
    return localKey;
  }

  if (input.imdbId) return `${mediaType}:imdb:${input.imdbId}`;
  if (input.tmdbId) return `${mediaType}:tmdb:${input.tmdbId}`;
  if (input.tvdbId) return `${mediaType}:tvdb:${input.tvdbId}`;

  const normalized = input.title ? normalizeTitle(input.title) : '';
  if (!normalized) return localKey;
  return `${mediaType}:title:${normalized}:${input.year ?? 0}`;
}
