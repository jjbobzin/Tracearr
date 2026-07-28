import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson } from '../../../../utils/http.js';
import { JellyfinClient } from '../../jellyfin/client.js';

const mockFetchJson = vi.mocked(fetchJson);
const mockFetch = vi.fn();

function makeClient() {
  return new JellyfinClient({ url: 'http://jf.local:8096', token: 'tok' });
}

/** Point /Sessions at a fixed list of raw session objects. */
function withSessions(sessions: Array<Record<string, unknown>>) {
  mockFetchJson.mockResolvedValue(sessions);
}

describe('BaseMediaServerClient.terminateSession control-capability guard', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stops a controllable session', async () => {
    withSessions([{ Id: 'sess1', SupportsMediaControl: true }]);

    await expect(makeClient().terminateSession('sess1')).resolves.toBe(true);

    const stopped = mockFetch.mock.calls.some(([url]) =>
      String(url).includes('/Sessions/sess1/Playing/Stop')
    );
    expect(stopped).toBe(true);
  });

  it('throws (not a false success) when the client cannot be remote-controlled', async () => {
    withSessions([{ Id: 'sess1', SupportsMediaControl: false }]);

    await expect(makeClient().terminateSession('sess1')).rejects.toThrow(
      /does not support remote control/
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws "not found" when the session is no longer active', async () => {
    withSessions([{ Id: 'someone-else', SupportsMediaControl: true }]);

    await expect(makeClient().terminateSession('sess1')).rejects.toThrow(/not found/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends the reason message before stopping a controllable session', async () => {
    withSessions([{ Id: 'sess1', SupportsMediaControl: true }]);

    await makeClient().terminateSession('sess1', 'Concurrent stream limit');

    const urls = mockFetch.mock.calls.map(([url]) => String(url));
    const messageIdx = urls.findIndex((u) => u.includes('/Sessions/sess1/Message'));
    const stopIdx = urls.findIndex((u) => u.includes('/Sessions/sess1/Playing/Stop'));
    expect(messageIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeGreaterThan(messageIdx);
  });

  it('bounds both the message and Stop calls with an AbortSignal, so an unresponsive server cannot hang the kill worker', async () => {
    withSessions([{ Id: 'sess1', SupportsMediaControl: true }]);

    await makeClient().terminateSession('sess1', 'Concurrent stream limit');

    const [, messageOpts] = mockFetch.mock.calls.find(([url]) =>
      String(url).includes('/Sessions/sess1/Message')
    )!;
    const [, stopOpts] = mockFetch.mock.calls.find(([url]) =>
      String(url).includes('/Sessions/sess1/Playing/Stop')
    )!;
    expect(messageOpts.signal).toBeInstanceOf(AbortSignal);
    expect(stopOpts.signal).toBeInstanceOf(AbortSignal);
  });
});
