import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeSsePlugin } from '../ssePluginProbe.js';

function mockFetchJson(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

const JF_CFG = {
  baseUrl: 'http://jf.local:8096',
  serverType: 'jellyfin' as const,
  token: 'tok-jf',
};
const EMBY_CFG = {
  baseUrl: 'http://emby.local:8096',
  serverType: 'emby' as const,
  token: 'tok-emby',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

describe('probeSsePlugin', () => {
  it('queries the jellyfin plugin list with auth and reports blocked when active', async () => {
    const fetchMock = mockFetchJson([
      { Name: 'Tracearr SSE', Id: 'b4a6d7e28f3c4a1e9d5b2c7f0e8a1b3d', Status: 'Active' },
    ]);
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await probeSsePlugin(JF_CFG);

    expect(result).toBe('blocked');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://jf.local:8096/Plugins');
    expect(new Headers(init.headers).get('Authorization')).toBe('MediaBrowser Token="tok-jf"');
  });

  it('reports restart_required when jellyfin lists the plugin pending restart', async () => {
    globalThis.fetch = mockFetchJson([
      { Name: 'Tracearr SSE', Id: 'b4a6d7e28f3c4a1e9d5b2c7f0e8a1b3d', Status: 'Restart' },
    ]) as typeof fetch;

    expect(await probeSsePlugin(JF_CFG)).toBe('restart_required');
  });

  it('reports malfunctioned for a jellyfin plugin that failed to load', async () => {
    globalThis.fetch = mockFetchJson([
      { Name: 'Tracearr SSE', Id: 'b4a6d7e28f3c4a1e9d5b2c7f0e8a1b3d', Status: 'Malfunctioned' },
    ]) as typeof fetch;

    expect(await probeSsePlugin(JF_CFG)).toBe('malfunctioned');
  });

  it('reports missing when the plugin is not in the list', async () => {
    globalThis.fetch = mockFetchJson([
      { Name: 'AudioDB', Id: 'a629c0dafac54c7e931a7174223f14c8', Status: 'Active' },
    ]) as typeof fetch;

    expect(await probeSsePlugin(JF_CFG)).toBe('missing');
  });

  it('matches the emby plugin by dashed guid and uses the emby path and token header', async () => {
    const fetchMock = mockFetchJson([
      { Name: 'Tracearr SSE', Id: 'a3d8f1e6-2b7c-4e9a-8f5d-1c6b0a3e7f92', Version: '0.2.0.0' },
    ]);
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await probeSsePlugin(EMBY_CFG);

    expect(result).toBe('blocked');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://emby.local:8096/emby/Plugins');
    expect(new Headers(init.headers).get('X-Emby-Token')).toBe('tok-emby');
  });

  it('reports unknown when the plugin list request fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed')) as typeof fetch;
    expect(await probeSsePlugin(JF_CFG)).toBe('unknown');
  });

  it('reports unknown on a non-200 plugin list response', async () => {
    globalThis.fetch = mockFetchJson({ error: 'nope' }, 401) as typeof fetch;
    expect(await probeSsePlugin(JF_CFG)).toBe('unknown');
  });
});
