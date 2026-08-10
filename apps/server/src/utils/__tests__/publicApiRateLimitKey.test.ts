import { describe, it, expect, vi } from 'vitest';
import { createPublicApiRateLimitKey } from '../publicApiRateLimitKey.js';

function req(ip: string, authorization?: string) {
  return { ip, headers: authorization === undefined ? {} : { authorization } };
}

describe('publicApiRateLimitKey', () => {
  const validTokens = new Set(['trr_pub_tokenA', 'trr_pub_tokenB', 'trr_pub_tok']);
  const isValidToken = vi.fn(async (token: string) => validTokens.has(token));
  const key = createPublicApiRateLimitKey(isValidToken);

  it('pins a validated public API bearer to the caller IP', async () => {
    await expect(key(req('1.2.3.4', 'Bearer trr_pub_tokenA'))).resolves.toBe(
      '1.2.3.4:trr_pub_tokenA'
    );
  });

  it('keeps distinct validated tokens behind one IP in separate buckets', async () => {
    const a = await key(req('1.2.3.4', 'Bearer trr_pub_tokenA'));
    const b = await key(req('1.2.3.4', 'Bearer trr_pub_tokenB'));
    expect(a).not.toBe(b);
    expect(a.startsWith('1.2.3.4:')).toBe(true);
    expect(b.startsWith('1.2.3.4:')).toBe(true);
  });

  it('scopes the same validated token under different IPs to different buckets', async () => {
    const a = await key(req('1.2.3.4', 'Bearer trr_pub_tok'));
    const b = await key(req('5.6.7.8', 'Bearer trr_pub_tok'));
    expect(a).not.toBe(b);
  });

  it('collapses an unrecognized trr_pub_ bearer into the plain per-IP bucket', async () => {
    const fake = await key(req('9.9.9.9', 'Bearer trr_pub_guess1'));
    const anon = await key(req('9.9.9.9'));
    expect(fake).toBe('9.9.9.9');
    expect(fake).toBe(anon);
  });

  it('never mints a fresh bucket for rotating fabricated tokens on one IP', async () => {
    const first = await key(req('9.9.9.9', 'Bearer trr_pub_guess1'));
    const second = await key(req('9.9.9.9', 'Bearer trr_pub_guess2'));
    const third = await key(req('9.9.9.9', 'Bearer trr_pub_guess3'));
    expect(first).toBe('9.9.9.9');
    expect(second).toBe('9.9.9.9');
    expect(third).toBe('9.9.9.9');
  });

  it('keys non-public bearers and anonymous requests by IP alone', async () => {
    await expect(key(req('1.2.3.4', 'Bearer something-else'))).resolves.toBe('1.2.3.4');
    await expect(key(req('1.2.3.4'))).resolves.toBe('1.2.3.4');
  });

  it('fails closed to the plain per-IP bucket when validation throws', async () => {
    const throwingValidator = vi.fn(async () => {
      throw new Error('cache/db error');
    });
    const throwingKey = createPublicApiRateLimitKey(throwingValidator);
    await expect(throwingKey(req('1.2.3.4', 'Bearer trr_pub_tokenA'))).resolves.toBe('1.2.3.4');
  });
});
