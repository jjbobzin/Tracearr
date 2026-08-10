import { isKnownPublicApiToken } from './publicApiTokenCache.js';

interface RateLimitKeySource {
  ip: string;
  headers: { authorization?: string | string[] };
}

export type PublicApiTokenValidator = (token: string) => Promise<boolean>;

const BEARER_PUBLIC_PREFIX = 'Bearer trr_pub_';

/**
 * Rate-limit bucket key for the global limiter and the public API v2 limiter.
 *
 * A `trr_pub_` bearer only earns its own `${ip}:${token}` bucket once it
 * resolves against the known-token validator; an unrecognized or fabricated
 * token falls back to the plain per-IP bucket instead of minting a fresh one,
 * so an attacker rotating fake suffixes can't escape per-IP throttling.
 * Distinct valid tokens behind the same IP still get separate budgets.
 * Validator failures resolve to "unvalidated" (fail closed).
 */
export function createPublicApiRateLimitKey(
  isValidToken: PublicApiTokenValidator
): (req: RateLimitKeySource) => Promise<string> {
  return async function publicApiRateLimitKey(req: RateLimitKeySource): Promise<string> {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith(BEARER_PUBLIC_PREFIX)) {
      const token = auth.slice('Bearer '.length);
      let valid: boolean;
      try {
        valid = await isValidToken(token);
      } catch {
        valid = false;
      }
      if (valid) {
        return `${req.ip}:${token}`;
      }
    }
    return req.ip;
  };
}

export const publicApiRateLimitKey = createPublicApiRateLimitKey(isKnownPublicApiToken);
