import { API_BASE_PATH } from '@tracearr/shared';

let cachedBasePath: string | null = null;

/**
 * Normalized BASE_PATH from env: leading slash, no trailing slash, '' when
 * unset. Resolved lazily because index.ts pulls this module in through its
 * static import chain before dotenv has loaded .env, and cached because the
 * value is fixed for the process lifetime. Shared by the Fastify rewrite,
 * the Better Auth mount, and derived URLs so they cannot disagree.
 */
export function getBasePath(): string {
  if (cachedBasePath === null) {
    // Strip surrounding slashes before re-adding one leading slash, so
    // BASE_PATH='/' (root, meaning "no prefix") normalizes to '' instead of
    // '/' - '/' + a request path starting with '/' would otherwise parse as
    // a protocol-relative URL in toWebRequest.
    const trimmed = (process.env.BASE_PATH ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
    cachedBasePath = trimmed ? `/${trimmed}` : '';
  }
  return cachedBasePath;
}

/**
 * Better Auth mount path as the browser sees it, BASE_PATH included. Better
 * Auth appends this to the request-derived origin to build its baseURL and
 * the OIDC redirect_uri, so on subpath deploys the prefix has to be part of
 * it or the redirect_uri never matches what the provider has registered.
 */
export function betterAuthBasePath(): string {
  return `${getBasePath()}${API_BASE_PATH}/auth`;
}
