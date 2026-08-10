import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson, HttpClientError } from '../../../../utils/http.js';
import { JellyfinClient } from '../../jellyfin/client.js';
import { EmbyClient } from '../../emby/client.js';

const mockFetchJson = vi.mocked(fetchJson);

function makeJellyfinClient() {
  return new JellyfinClient({ url: 'http://jf.local:8096', token: 'tok123' });
}

function makeEmbyClient() {
  return new EmbyClient({ url: 'http://emby.local:8096', token: 'tok123' });
}

function httpError(statusCode: number): HttpClientError {
  return new HttpClientError({
    service: 'jellyfin',
    statusCode,
    statusText: 'error',
    url: 'http://jf.local:8096/x',
  });
}

beforeEach(() => {
  mockFetchJson.mockReset();
});

describe('queryPlaybackReporting', () => {
  it('POSTs to the Jellyfin plugin endpoint with the standard auth header and query body', async () => {
    mockFetchJson.mockResolvedValue({ results: [] });

    const client = makeJellyfinClient();
    await client.queryPlaybackReporting('SELECT 1');

    const url = mockFetchJson.mock.calls[0]?.[0] as string;
    const options = mockFetchJson.mock.calls[0]?.[1];
    const headers = options?.headers as Record<string, string>;

    expect(url).toBe('http://jf.local:8096/user_usage_stats/submit_custom_query');
    expect(headers.Authorization).toContain('Token="tok123"');
    expect(headers['Content-Type']).toBe('application/json');
    expect(options?.body).toBe(JSON.stringify({ CustomQueryString: 'SELECT 1' }));
  });

  it('POSTs to the Emby plugin endpoint with the Emby auth header', async () => {
    mockFetchJson.mockResolvedValue({ results: [] });

    const client = makeEmbyClient();
    await client.queryPlaybackReporting('SELECT 1');

    const url = mockFetchJson.mock.calls[0]?.[0] as string;
    const headers = mockFetchJson.mock.calls[0]?.[1]?.headers as Record<string, string>;

    expect(url).toBe('http://emby.local:8096/emby/user_usage_stats/submit_custom_query');
    expect(headers['X-Emby-Authorization']).toContain('Token="tok123"');
  });

  it('returns the results array untouched when present', async () => {
    const rows = [
      ['a', 'b'],
      ['c', 'd'],
    ];
    mockFetchJson.mockResolvedValue({ results: rows, message: 'Query executed successfully.' });

    const client = makeJellyfinClient();
    const result = await client.queryPlaybackReporting('SELECT 1');

    expect(result).toEqual(rows);
  });

  it('throws with the plugin message text on a SQL error', async () => {
    mockFetchJson.mockResolvedValue({
      colums: [],
      results: [],
      message: 'Error Running Query</br>no such table',
    });

    const client = makeJellyfinClient();

    await expect(client.queryPlaybackReporting('SELECT * FROM missing')).rejects.toThrow(
      'Playback Reporting query failed: Error Running Query</br>no such table'
    );
  });

  it('does not throw on an empty result set', async () => {
    mockFetchJson.mockResolvedValue({
      colums: [],
      results: [],
      message: 'Query executed, no data returned.',
    });

    const client = makeJellyfinClient();
    const result = await client.queryPlaybackReporting('SELECT 1 WHERE 1=0');

    expect(result).toEqual([]);
  });
});

describe('getPlaybackReportingInfo', () => {
  it('returns installed: false when the plugin endpoint 404s', async () => {
    mockFetchJson.mockRejectedValue(httpError(404));

    const client = makeJellyfinClient();
    const info = await client.getPlaybackReportingInfo();

    expect(info).toEqual({ installed: false });
  });

  it('rethrows non-404 errors', async () => {
    mockFetchJson.mockRejectedValue(httpError(500));

    const client = makeJellyfinClient();

    await expect(client.getPlaybackReportingInfo()).rejects.toThrow();
  });

  it('reports columns, record count, and date range on the happy path', async () => {
    mockFetchJson
      .mockResolvedValueOnce({
        results: [
          ['0', 'DateCreated', 'DATETIME', '1', '', '0'],
          ['1', 'UserId', 'TEXT', '0', '', '0'],
        ],
      })
      .mockResolvedValueOnce({
        results: [['42', '2023-01-01 10:00:00', '2026-08-01 21:00:00']],
      });

    const client = makeJellyfinClient();
    const info = await client.getPlaybackReportingInfo();

    expect(info).toEqual({
      installed: true,
      columns: ['DateCreated', 'UserId'],
      totalRecords: 42,
      oldestDate: '2023-01-01 10:00:00',
      newestDate: '2026-08-01 21:00:00',
    });

    const secondCallBody = JSON.parse(mockFetchJson.mock.calls[1]?.[1]?.body as string);
    expect(secondCallBody.CustomQueryString).toBe(
      'SELECT COUNT(1), MIN(DateCreated), MAX(DateCreated) FROM PlaybackActivity'
    );
  });
});
