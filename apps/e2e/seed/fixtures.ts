import { createHash } from 'node:crypto';

const VARIANT_NIBBLES = ['8', '9', 'a', 'b'];

/**
 * Deterministic, stable id derived from a plain string seed. Postgres's uuid
 * column accepts any 32 hex digits regardless of RFC version/variant bits,
 * but the API layer's zod schema (z.uuid()) validates them strictly - so the
 * version nibble is forced to '4' and the variant nibble to one of 8/9/a/b,
 * same as a real v4 UUID, without needing to hand-maintain a literal id table.
 */
export function fixtureId(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex').split('');
  hash[12] = '4';
  hash[16] = VARIANT_NIBBLES[parseInt(hash[16]!, 16) % 4]!;
  const h = hash.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Mirrors services/library/mediaMatchKey.ts's normalizeTitle - kept local so
 * the seed script never imports apps/server source across the app boundary. */
export function normalizeTitleLocal(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function matchKeyLocal(
  mediaType: 'movie' | 'show',
  title: string,
  year: number | null
): string {
  return `${mediaType}:title:${normalizeTitleLocal(title)}:${year ?? 0}`;
}

/** Mirrors mediaMatchKey.ts's buildSortTitle, same boundary rule as above.
 * Title A-Z ordering and the letter rail both sort on this column; rows
 * seeded without it collapse to insert-order and every jump test fails. */
export function sortTitleLocal(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/^\s*(the|an|a)\s+/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

export const SERVER_1_ID = fixtureId('media-browse:server:1');
export const SERVER_2_ID = fixtureId('media-browse:server:2');

export const OTHER_VIEWER_USER_ID = fixtureId('media-browse:user:other-viewer');
export const OTHER_VIEWER_SERVER_USER_ID = fixtureId(
  'media-browse:server-user:other-viewer:server1'
);

/** Resolved after the real owner signs up (media-browse.setup.ts links it). */
export const ADMIN_SERVER_USER_ID = fixtureId('media-browse:server-user:admin:server1');

export const FIXTURE = {
  articleTitle: {
    id: fixtureId('media-browse:movie:the-matrix'),
    title: 'The Matrix',
    year: 1999,
  },
  digitTitle: {
    id: fixtureId('media-browse:movie:12-monkeys'),
    title: '12 Monkeys',
    year: 1995,
  },
  twoCopyTitle: {
    id: fixtureId('media-browse:movie:duplicate-signal'),
    title: 'Duplicate Signal',
    year: 2012,
  },
  crossServerTitle: {
    id: fixtureId('media-browse:movie:shared-frontier'),
    title: 'Shared Frontier',
    year: 2015,
  },
  removedEverywhereTitle: {
    id: fixtureId('media-browse:movie:ghost-protocol-files'),
    title: 'Ghost Protocol Files',
    year: 2008,
  },
  watchedByOtherTitle: {
    id: fixtureId('media-browse:movie:watched-by-someone'),
    title: 'Watched By Someone',
    year: 2003,
  },
  watchedByAdminTitle: {
    id: fixtureId('media-browse:movie:watched-by-admin'),
    title: 'Watched By Admin',
    year: 2004,
  },
  /** Sorts last of every seeded title (article/accent-stripped ordering never
   * moves a 'z' prefix earlier), so it's a stable "definitely past page one" marker. */
  pageTwoMarkerTitle: {
    id: fixtureId('media-browse:movie:zulu-sentinel-marker'),
    title: 'Zulu Sentinel Marker',
    year: 2020,
  },
} as const;

const FILLER_LETTERS = [
  'Alpha',
  'Bravo',
  'Charlie',
  'Echo',
  'Foxtrot',
  'Hotel',
  'India',
  'Juliet',
] as const;
const FILLER_PER_LETTER = 10;

export interface FillerMovie {
  id: string;
  title: string;
  year: number;
  resolution: string | null;
  fileSizeGb: number;
}

/** ~80 filler movies spread across 8 letters (never M/#/D/G/S/W/Z, which the
 * named fixtures above own) so real pagination and letter-bucket math have
 * something to walk through beyond the handful of named titles. */
export function fillerMovies(): FillerMovie[] {
  const movies: FillerMovie[] = [];
  for (const word of FILLER_LETTERS) {
    for (let i = 1; i <= FILLER_PER_LETTER; i++) {
      const index = String(i).padStart(2, '0');
      const title = `${word} Filler ${index}`;
      movies.push({
        id: fixtureId(`media-browse:movie:filler:${word}:${index}`),
        title,
        year: 2000 + i,
        // Pairs with FIXTURE.twoCopyTitle's 1080p copy for a deterministic
        // resolution-filter narrow (the UI's "4K"/"SD" options don't
        // case-match the lowercase values library sync actually stores, so
        // 1080p/720p are the only filter values that work through the real
        // browser today).
        resolution: word === 'Bravo' && i === 1 ? '1080p' : null,
        // One lone filler is oversized so a size-on-disk filter has a
        // deterministic single-title narrow; everything else stays small.
        fileSizeGb: word === 'Hotel' && i === 1 ? 40 : 2,
      });
    }
  }
  return movies;
}

export interface FillerShow {
  id: string;
  title: string;
  year: number;
}

export function fillerShows(): FillerShow[] {
  const shows: FillerShow[] = [];
  for (let i = 1; i <= 10; i++) {
    const index = String(i).padStart(2, '0');
    shows.push({
      id: fixtureId(`media-browse:show:filler:${index}`),
      title: `Series Alpha ${index}`,
      year: 2010 + i,
    });
  }
  return shows;
}
