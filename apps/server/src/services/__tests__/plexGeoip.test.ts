/**
 * Plex GeoIP Service Tests
 *
 * Tests the Redis caching layer added around the Plex GeoIP fetch in plexGeoip.ts:
 * - Cache hit skips the plex.tv fetch
 * - Cache miss fetches, then stores a positive entry with the 24h TTL
 * - A fetch failure stores a negative entry with the 10 minute TTL
 * - Redis being unavailable degrades to the uncached fetch behavior
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CACHE_TTL } from '@tracearr/shared';

vi.mock('../cache.js', () => ({
  getCacheService: vi.fn(),
}));

vi.mock('../geoip.js', () => ({
  geoipService: {
    isPrivateIP: vi.fn().mockReturnValue(false),
    lookup: vi.fn().mockReturnValue({
      city: 'MaxMind City',
      region: null,
      country: null,
      countryCode: null,
      continent: null,
      postal: null,
      lat: null,
      lon: null,
      asnNumber: null,
      asnOrganization: null,
    }),
  },
}));

vi.mock('../geoasn.js', () => ({
  geoasnService: {
    lookup: vi.fn().mockReturnValue({ number: null, organization: null }),
  },
}));

import { getCacheService } from '../cache.js';
import { geoipService } from '../geoip.js';
import { lookupGeoIP } from '../plexGeoip.js';

const PLEX_XML_RESPONSE =
  '<location code="US" country="United States" city="New York" subdivisions="New York" coordinates="40.7, -74.0"/>';

function mockCacheService(overrides: Record<string, unknown> = {}) {
  return {
    getPlexGeoipCache: vi.fn().mockResolvedValue(null),
    setPlexGeoipCache: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('lookupGeoIP Plex caching', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns the cached location and never calls fetch on a cache hit', async () => {
    const cached = {
      city: 'Cached City',
      region: 'NY',
      country: 'United States',
      countryCode: 'US',
      continent: null,
      postal: null,
      lat: 40.7,
      lon: -74.0,
      asnNumber: null,
      asnOrganization: null,
    };
    const cache = mockCacheService({
      getPlexGeoipCache: vi.fn().mockResolvedValue(JSON.stringify(cached)),
    });
    vi.mocked(getCacheService).mockReturnValue(cache as never);

    const result = await lookupGeoIP('1.2.3.4', true);

    expect(result.city).toBe('Cached City');
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.setPlexGeoipCache).not.toHaveBeenCalled();
  });

  it('fetches on a cache miss and stores a positive entry with the 24h TTL', async () => {
    const cache = mockCacheService();
    vi.mocked(getCacheService).mockReturnValue(cache as never);
    vi.mocked(fetch).mockResolvedValue(new Response(PLEX_XML_RESPONSE, { status: 200 }));

    const result = await lookupGeoIP('1.2.3.4', true);

    expect(result.city).toBe('New York');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.setPlexGeoipCache).toHaveBeenCalledWith(
      '1.2.3.4',
      expect.stringContaining('New York'),
      CACHE_TTL.PLEX_GEOIP
    );
  });

  it('stores a negative entry with the 10 minute TTL when the plex.tv fetch fails', async () => {
    const cache = mockCacheService();
    vi.mocked(getCacheService).mockReturnValue(cache as never);
    vi.mocked(fetch).mockResolvedValue(new Response('', { status: 500 }));

    const result = await lookupGeoIP('1.2.3.4', true);

    expect(result.city).toBe('MaxMind City');
    expect(cache.setPlexGeoipCache).toHaveBeenCalledWith(
      '1.2.3.4',
      'null',
      CACHE_TTL.PLEX_GEOIP_NEGATIVE
    );
  });

  it('falls back to an uncached fetch when Redis is unavailable', async () => {
    vi.mocked(getCacheService).mockReturnValue(null);
    vi.mocked(fetch).mockResolvedValue(new Response(PLEX_XML_RESPONSE, { status: 200 }));

    const result = await lookupGeoIP('1.2.3.4', true);

    expect(result.city).toBe('New York');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to an uncached fetch when the cache read throws', async () => {
    const cache = mockCacheService({
      getPlexGeoipCache: vi.fn().mockRejectedValue(new Error('redis down')),
    });
    vi.mocked(getCacheService).mockReturnValue(cache as never);
    vi.mocked(fetch).mockResolvedValue(new Response(PLEX_XML_RESPONSE, { status: 200 }));

    const result = await lookupGeoIP('1.2.3.4', true);

    expect(result.city).toBe('New York');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not call fetch for private IPs even when Plex GeoIP is enabled', async () => {
    vi.mocked(geoipService.isPrivateIP).mockReturnValue(true);
    vi.mocked(geoipService.lookup).mockReturnValue({
      locationName: 'Home',
      city: 'Denver',
      region: 'Colorado',
      country: 'United States',
      countryCode: 'US',
      continent: null,
      postal: null,
      lat: 39.7392,
      lon: -104.9903,
      asnNumber: null,
      asnOrganization: null,
    });

    const localConfig = {
      localLocationName: 'Home',
      localCity: 'Denver',
      localRegion: 'Colorado',
      localCountry: 'United States',
      localCountryCode: 'US',
      localLatitude: 39.7392,
      localLongitude: -104.9903,
    };

    const result = await lookupGeoIP('192.168.1.50', true, localConfig);

    expect(result.locationName).toBe('Home');
    expect(result.lat).toBe(39.7392);
    expect(fetch).not.toHaveBeenCalled();
    expect(geoipService.lookup).toHaveBeenCalledWith('192.168.1.50', localConfig);
  });
});
