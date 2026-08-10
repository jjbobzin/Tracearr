/**
 * BASE_PATH handling for the Better Auth mount (#926).
 *
 * Better Auth builds the OIDC redirect_uri from the origin of the shim-built
 * request URL plus its configured basePath. Fastify's rewriteUrl strips
 * BASE_PATH before routing, so both inputs re-prefix it; otherwise the
 * redirect_uri loses the subpath and the provider rejects it as
 * unregistered.
 *
 * getBasePath() caches its env read, so each case stubs the env, resets the
 * module registry, and dynamically imports (same pattern as oidc.test.ts).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';

function fakeRequest(url: string): FastifyRequest {
  return {
    url,
    headers: { host: 'example.com' },
    protocol: 'https',
    ip: '203.0.113.7',
    method: 'GET',
    body: undefined,
  } as unknown as FastifyRequest;
}

describe('better auth BASE_PATH handling', () => {
  afterEach(() => {
    delete process.env.BASE_PATH;
    vi.resetModules();
  });

  describe('lib/basePath', () => {
    it('normalizes BASE_PATH and exposes the prefixed better auth mount path', async () => {
      process.env.BASE_PATH = '/tracearr/';
      vi.resetModules();
      const { getBasePath, betterAuthBasePath } = await import('../basePath.js');
      expect(getBasePath()).toBe('/tracearr');
      expect(betterAuthBasePath()).toBe('/tracearr/api/v1/auth');
    });

    it('is empty with no BASE_PATH set', async () => {
      delete process.env.BASE_PATH;
      vi.resetModules();
      const { getBasePath, betterAuthBasePath } = await import('../basePath.js');
      expect(getBasePath()).toBe('');
      expect(betterAuthBasePath()).toBe('/api/v1/auth');
    });

    it('normalizes BASE_PATH="/" (root) to empty, not "/"', async () => {
      process.env.BASE_PATH = '/';
      vi.resetModules();
      const { getBasePath, betterAuthBasePath } = await import('../basePath.js');
      expect(getBasePath()).toBe('');
      expect(betterAuthBasePath()).toBe('/api/v1/auth');
    });

    it('normalizes whitespace-only BASE_PATH to empty', async () => {
      process.env.BASE_PATH = '   ';
      vi.resetModules();
      const { getBasePath } = await import('../basePath.js');
      expect(getBasePath()).toBe('');
    });
  });

  describe('toWebRequest', () => {
    it('re-prefixes BASE_PATH onto the rewritten request url', async () => {
      process.env.BASE_PATH = '/tracearr';
      vi.resetModules();
      const { toWebRequest } = await import('../betterAuthRequest.js');
      // rewriteUrl has already stripped /tracearr by the time the shim runs
      const webRequest = toWebRequest(fakeRequest('/api/v1/auth/sign-in/oauth2'));
      expect(webRequest.url).toBe('https://example.com/tracearr/api/v1/auth/sign-in/oauth2');
    });

    it('leaves the url untouched with no BASE_PATH', async () => {
      delete process.env.BASE_PATH;
      vi.resetModules();
      const { toWebRequest } = await import('../betterAuthRequest.js');
      const webRequest = toWebRequest(fakeRequest('/api/v1/auth/sign-in/oauth2'));
      expect(webRequest.url).toBe('https://example.com/api/v1/auth/sign-in/oauth2');
    });

    it('builds a correct absolute url with BASE_PATH="/" (root), not a protocol-relative one', async () => {
      process.env.BASE_PATH = '/';
      vi.resetModules();
      const { toWebRequest } = await import('../betterAuthRequest.js');
      const webRequest = toWebRequest(fakeRequest('/api/v1/auth/sign-in/oauth2'));
      expect(webRequest.url).toBe('https://example.com/api/v1/auth/sign-in/oauth2');
    });
  });

  describe('auth instance basePath', () => {
    it('includes BASE_PATH so derived callback URLs keep the subpath', async () => {
      process.env.BASE_PATH = '/tracearr';
      vi.resetModules();
      const { getAuth, closeAuth } = await import('../auth.js');
      try {
        expect(getAuth().options.basePath).toBe('/tracearr/api/v1/auth');
      } finally {
        await closeAuth();
      }
    });

    it('stays at the bare mount path with no BASE_PATH', async () => {
      delete process.env.BASE_PATH;
      vi.resetModules();
      const { getAuth, closeAuth } = await import('../auth.js');
      try {
        expect(getAuth().options.basePath).toBe('/api/v1/auth');
      } finally {
        await closeAuth();
      }
    });
  });
});
