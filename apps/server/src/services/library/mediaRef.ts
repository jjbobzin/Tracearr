const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_RE = /^(movie|show|episode):(imdb|tmdb|tvdb):(.+)$/;

export function parseMediaRef(raw: string):
  | { kind: 'uuid'; id: string }
  | {
      kind: 'provider';
      mediaType: 'movie' | 'show' | 'episode';
      provider: 'imdb' | 'tmdb' | 'tvdb';
      id: string;
    }
  | null {
  if (UUID_RE.test(raw)) return { kind: 'uuid', id: raw.toLowerCase() };
  const m = PROVIDER_RE.exec(raw);
  if (!m) return null;
  return {
    kind: 'provider',
    mediaType: m[1] as 'movie' | 'show' | 'episode',
    provider: m[2] as 'imdb' | 'tmdb' | 'tvdb',
    id: m[3]!,
  };
}
