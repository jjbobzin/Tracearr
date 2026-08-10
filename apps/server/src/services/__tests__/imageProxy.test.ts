/**
 * Image Proxy Service Tests
 *
 * Exercises the real imageProxy.ts pipeline logic with fs, fetch, and the
 * database fully mocked, so nothing here touches the real cache directory,
 * network, or a live database - safe to run alongside other checkouts.
 */

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  utimes: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

import {
  readFile,
  writeFile,
  rename,
  stat,
  unlink,
  utimes,
  readdir,
  mkdir,
} from 'node:fs/promises';
import sharp from 'sharp';
import { db } from '../../db/client.js';
import {
  proxyImage,
  posterVersionFor,
  posterCacheEntryExists,
  cleanupCache,
  buildLqipPlaceholder,
  buildUpstreamRequest,
  persistDominantColorIfNeeded,
  stopImageCacheCleanup,
  _resetServerRowCacheForTests,
} from '../imageProxy.js';

const CACHE_DIR = join(process.cwd(), 'data', 'image-cache');
const DAY_MS = 24 * 60 * 60 * 1000;

function mockSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

function mockUpdateChain() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.update).mockReturnValue(chain as never);
  return chain;
}

afterAll(() => {
  stopImageCacheCleanup();
});

afterEach(() => {
  vi.clearAllMocks();
  _resetServerRowCacheForTests();
});

describe('posterVersionFor', () => {
  it('is stable and matches the first 8 hex chars of sha1(thumbPath)', () => {
    const path = '/library/metadata/123/thumb/456';
    const expected = createHash('sha1').update(path).digest('hex').slice(0, 8);

    expect(posterVersionFor(path)).toBe(expected);
    expect(posterVersionFor(path)).toBe(posterVersionFor(path));
    expect(posterVersionFor(path)).toHaveLength(8);
  });

  it('produces different fingerprints for different paths', () => {
    expect(posterVersionFor('/a')).not.toBe(posterVersionFor('/b'));
  });
});

/** Mirrors buildCacheKeyInfo's derivation so tests can assert the exact path. */
function expectedCachePath(
  serverId: string,
  thumbPath: string,
  width: number,
  height: number
): string {
  const version = posterVersionFor(thumbPath);
  const baseHash = createHash('sha256')
    .update(`${serverId}:${thumbPath}:${width}:${height}`)
    .digest('hex')
    .slice(0, 16);
  const shard = baseHash.slice(0, 2);
  return join(CACHE_DIR, shard, `${baseHash}:v${version}.webp`);
}

describe('posterCacheEntryExists', () => {
  const serverId = 'server-1';
  const thumbPath = '/library/metadata/123/thumb/456';

  it('returns true when the versioned 240 cache file exists on disk', async () => {
    vi.mocked(stat).mockResolvedValue({ size: 100, mtimeMs: Date.now() } as never);

    await expect(posterCacheEntryExists(serverId, thumbPath, 240)).resolves.toBe(true);
    expect(vi.mocked(stat)).toHaveBeenCalledWith(expectedCachePath(serverId, thumbPath, 240, 360));
  });

  it('returns false when the cache file is missing', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

    await expect(posterCacheEntryExists(serverId, thumbPath, 360)).resolves.toBe(false);
  });

  it('checks distinct paths for the 160, 240, and 360 buckets', async () => {
    const seen: string[] = [];
    vi.mocked(stat).mockImplementation(async (path: unknown) => {
      seen.push(path as string);
      return { size: 100, mtimeMs: Date.now() } as never;
    });

    await posterCacheEntryExists(serverId, thumbPath, 160);
    await posterCacheEntryExists(serverId, thumbPath, 240);
    await posterCacheEntryExists(serverId, thumbPath, 360);

    expect(seen).toEqual([
      expectedCachePath(serverId, thumbPath, 160, 240),
      expectedCachePath(serverId, thumbPath, 240, 360),
      expectedCachePath(serverId, thumbPath, 360, 540),
    ]);
  });
});

describe('cleanupCache', () => {
  it('exempts versioned entries from the TTL sweep while deleting an unversioned same-age entry', async () => {
    const now = Date.now();
    const staleMtime = now - (DAY_MS + 1000);
    const versionedFile = 'abcd1234567890ab:v11223344.webp';
    const unversionedFile = 'ef567890abcdef12.webp';
    const shardPath = join(CACHE_DIR, 'ab');

    vi.mocked(readdir).mockImplementation(async (path: unknown, opts?: unknown) => {
      if (path === CACHE_DIR && (opts as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
        return [{ name: 'ab', isDirectory: () => true, isFile: () => false }] as never;
      }
      if (path === shardPath) {
        return [versionedFile, unversionedFile] as never;
      }
      return [] as never;
    });

    vi.mocked(stat).mockResolvedValue({ size: 1000, mtimeMs: staleMtime } as never);
    vi.mocked(unlink).mockResolvedValue(undefined);

    await cleanupCache();

    expect(vi.mocked(unlink)).toHaveBeenCalledWith(join(shardPath, unversionedFile));
    expect(vi.mocked(unlink)).not.toHaveBeenCalledWith(join(shardPath, versionedFile));
  });

  it('treats a versioned-looking orphan tmp file as TTL-eligible, not immutable', async () => {
    const now = Date.now();
    const staleMtime = now - (DAY_MS + 1000);
    // A tmp file left behind by a failed write for a versioned entry inherits
    // the `:v<hash>` substring in its name but must still be swept.
    const versionedTmpFile = 'abcd1234567890ab:v11223344.webp.tmp.99999';
    const shardPath = join(CACHE_DIR, 'ab');

    vi.mocked(readdir).mockImplementation(async (path: unknown, opts?: unknown) => {
      if (path === CACHE_DIR && (opts as { withFileTypes?: boolean } | undefined)?.withFileTypes) {
        return [{ name: 'ab', isDirectory: () => true, isFile: () => false }] as never;
      }
      if (path === shardPath) {
        return [versionedTmpFile] as never;
      }
      return [] as never;
    });

    vi.mocked(stat).mockResolvedValue({ size: 1000, mtimeMs: staleMtime } as never);
    vi.mocked(unlink).mockResolvedValue(undefined);

    await cleanupCache();

    expect(vi.mocked(unlink)).toHaveBeenCalledWith(join(shardPath, versionedTmpFile));
  });
});

describe('buildLqipPlaceholder', () => {
  it('returns valid WebP bytes using the neutral color when dominantColor is null', async () => {
    const data = await buildLqipPlaceholder(null);

    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    // WebP container: 'RIFF'....'WEBP'
    expect(data.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(data.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });

  it('returns valid WebP bytes for a known dominant color', async () => {
    const data = await buildLqipPlaceholder('#336699');

    expect(data.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(data.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });
});

describe('proxyImage cache-miss pipeline', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let testImage: Buffer;

  beforeEach(async () => {
    const sharp = (await import('sharp')).default;
    testImage = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 50, g: 100, b: 150 } },
    })
      .jpeg()
      .toBuffer();

    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue(Buffer.from(''));
    vi.mocked(utimes).mockResolvedValue(undefined);
    vi.mocked(readdir).mockResolvedValue([] as never);

    mockUpdateChain();

    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(testImage, { status: 200, headers: { 'content-type': 'image/jpeg' } })
      );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('writes atomically: tmp path named after the pid, written before the rename into place', async () => {
    mockSelectChain([
      { id: 'server-1', type: 'plex', url: 'http://localhost:32400', token: 'token' },
    ]);

    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/1/thumb/1',
      width: 240,
      height: 360,
    });

    expect(result.cached).toBe(false);
    expect(result.contentType).toBe('image/webp');

    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);

    const [tmpPathArg] = vi.mocked(writeFile).mock.calls[0] as [string, Buffer];
    expect(tmpPathArg).toMatch(new RegExp(`\\.tmp\\.${process.pid}$`));

    const [renameFrom, renameTo] = vi.mocked(rename).mock.calls[0] as [string, string];
    expect(renameFrom).toBe(tmpPathArg);
    expect(renameTo).toBe(tmpPathArg.replace(`.tmp.${process.pid}`, ''));
    expect(renameTo.endsWith('.webp')).toBe(true);

    const writeOrder = vi.mocked(writeFile).mock.invocationCallOrder[0];
    const renameOrder = vi.mocked(rename).mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(renameOrder as number);

    // Drain the fire-and-forget color persist so it doesn't leak into the next test.
    await vi.waitFor(() => expect(vi.mocked(db.update)).toHaveBeenCalledTimes(1));
  });

  it('unlinks the tmp file when the atomic write fails, leaving no orphan', async () => {
    mockSelectChain([
      { id: 'server-4', type: 'plex', url: 'http://localhost:32400', token: 'token' },
    ]);
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));
    vi.mocked(unlink).mockResolvedValue(undefined);

    await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/4/thumb/4',
      width: 240,
      height: 360,
    });

    expect(vi.mocked(unlink)).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`\\.tmp\\.${process.pid}$`))
    );

    // The fire-and-forget color persist still runs regardless of the write
    // failure; drain it so it doesn't leak into the next test.
    await vi.waitFor(() => expect(vi.mocked(db.update)).toHaveBeenCalledTimes(1));
  });

  it('persists the dominant color only when the row does not have one yet', async () => {
    mockSelectChain([
      { id: 'server-2', type: 'plex', url: 'http://localhost:32400', token: 'token' },
    ]);
    const updateChain = mockUpdateChain();

    await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/2/thumb/2',
      width: 240,
      height: 360,
    });

    // The color write is fire-and-forget so the response doesn't wait on it;
    // give it a chance to land before asserting.
    await vi.waitFor(() => expect(vi.mocked(db.update)).toHaveBeenCalledTimes(1));
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ dominantColor: expect.stringMatching(/^#[0-9a-f]{6}$/) })
    );
  });

  it('falls back to the SVG placeholder with a short, non-immutable cacheControl and drains the body on an upstream HTTP error', async () => {
    mockSelectChain([
      { id: 'server-8', type: 'plex', url: 'http://localhost:32400', token: 'token' },
    ]);
    // Response.body is normally a ReadableStream; stub cancel to observe the drain.
    const cancel = vi.fn().mockResolvedValue(undefined);
    const errorResponse = new Response('server error', { status: 502 });
    Object.defineProperty(errorResponse, 'body', { value: { cancel } });
    fetchSpy.mockResolvedValue(errorResponse);

    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/8/thumb/8',
      width: 240,
      height: 360,
    });

    expect(result.contentType).toBe('image/svg+xml');
    expect(result.cacheControl).toBe('public, max-age=15');
    // Both upstream candidates (server-resized, then original) hit the same
    // erroring mock, and each drains its body.
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('with skipLqipRace, waits for the real pipeline instead of returning the LQIP placeholder once the wait timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      mockSelectChain([
        { id: 'server-9', type: 'plex', url: 'http://localhost:32400', token: 'token' },
      ]);

      let resolveFetch!: (value: Response) => void;
      fetchSpy.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );

      let settled = false;
      const resultPromise = proxyImage({
        serverId: randomUUID(),
        imagePath: '/library/metadata/9/thumb/9',
        width: 240,
        height: 360,
        skipLqipRace: true,
      }).then((result) => {
        settled = true;
        return result;
      });

      // Past the 2s semaphore-wait timeout that would otherwise trigger the LQIP race.
      await vi.advanceTimersByTimeAsync(2100);
      expect(settled).toBe(false);

      resolveFetch(new Response(testImage, { status: 200 }));
      const result = await resultPromise;

      expect(settled).toBe(true);
      expect(result.contentType).toBe('image/webp');
      expect(result.data.byteLength).toBeGreaterThan(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without a version fingerprint, waits for the real pipeline past the semaphore wait timeout instead of racing the LQIP placeholder', async () => {
    // A client caching by URL alone (no v=) can't revalidate a 200 LQIP
    // placeholder later, so it must never be served one - only the real
    // image, or the short-lived degraded fallback on an actual error.
    vi.useFakeTimers();
    try {
      mockSelectChain([
        { id: 'server-10', type: 'plex', url: 'http://localhost:32400', token: 'token' },
      ]);

      let resolveFetch!: (value: Response) => void;
      fetchSpy.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );

      let settled = false;
      const resultPromise = proxyImage({
        serverId: randomUUID(),
        imagePath: '/library/metadata/10/thumb/10',
        width: 240,
        height: 360,
      }).then((result) => {
        settled = true;
        return result;
      });

      // Past the 2s semaphore-wait timeout that would otherwise trigger the LQIP race.
      await vi.advanceTimersByTimeAsync(2100);
      expect(settled).toBe(false);

      resolveFetch(new Response(testImage, { status: 200 }));
      const result = await resultPromise;

      expect(settled).toBe(true);
      expect(result.contentType).toBe('image/webp');
      // A 1x1 LQIP placeholder is a handful of bytes; a real resized poster is much bigger.
      expect(result.data.byteLength).toBeGreaterThan(50);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('persistDominantColorIfNeeded', () => {
  const red1x1 = () =>
    sharp(Buffer.from([255, 0, 0]), { raw: { width: 1, height: 1, channels: 3 } })
      .png()
      .toBuffer();

  it('coalesces concurrent persists for the same image into one write', async () => {
    // Fire-and-forget persists from earlier proxyImage tests can settle
    // during this one and hit the shared db.update mock - drain them and
    // count only writes carrying this test's color
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.clearAllMocks();

    // The miss pipeline runs per size, so one poster at 160/240/360 lands
    // here three times at once - the shape that deadlocks multi-row updates
    const chain = mockUpdateChain();
    const serverId = randomUUID();
    const buffer = await red1x1();

    await Promise.all([
      persistDominantColorIfNeeded(serverId, '/thumb/coalesce', buffer),
      persistDominantColorIfNeeded(serverId, '/thumb/coalesce', buffer),
      persistDominantColorIfNeeded(serverId, '/thumb/coalesce', buffer),
    ]);

    const redWrites = chain.set.mock.calls.filter(
      (call) => (call[0] as { dominantColor?: string }).dominantColor === '#ff0000'
    );
    expect(redWrites).toHaveLength(1);
  });

  it('retries once after a deadlock and succeeds', async () => {
    const chain = {
      set: vi.fn().mockReturnThis(),
      where: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
        .mockResolvedValueOnce(undefined),
    };
    vi.mocked(db.update).mockReturnValue(chain as never);

    await persistDominantColorIfNeeded(randomUUID(), '/thumb/deadlock', await red1x1());

    expect(chain.where).toHaveBeenCalledTimes(2);
    expect(chain.set).toHaveBeenCalledWith({ dominantColor: '#ff0000' });
  });

  it('recognizes a wrapped deadlock via the error cause', async () => {
    const wrapped = Object.assign(new Error('query failed'), {
      cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    });
    const chain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValueOnce(wrapped).mockResolvedValueOnce(undefined),
    };
    vi.mocked(db.update).mockReturnValue(chain as never);

    await persistDominantColorIfNeeded(randomUUID(), '/thumb/wrapped', await red1x1());

    expect(chain.where).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-deadlock failures and never throws', async () => {
    const chain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: '23505' })),
    };
    vi.mocked(db.update).mockReturnValue(chain as never);

    await expect(
      persistDominantColorIfNeeded(randomUUID(), '/thumb/other-error', await red1x1())
    ).resolves.toBeUndefined();

    expect(chain.where).toHaveBeenCalledTimes(1);
  });
});

describe('buildUpstreamRequest', () => {
  const baseServer = {
    id: randomUUID(),
    name: 'Test',
    url: 'http://media:1234/',
    token: 'tok123',
  };

  it('plex without resize appends the token to the raw path', () => {
    const server = { ...baseServer, type: 'plex' } as never;
    const { imageUrl } = buildUpstreamRequest(server, '/library/metadata/1/thumb/2');
    expect(imageUrl).toBe('http://media:1234/library/metadata/1/thumb/2?X-Plex-Token=tok123');
  });

  it('plex with resize routes through the photo transcoder with the path encoded', () => {
    const server = { ...baseServer, type: 'plex' } as never;
    const { imageUrl } = buildUpstreamRequest(server, '/library/metadata/1/thumb/2', {
      width: 240,
      height: 360,
    });
    const url = new URL(imageUrl);
    expect(url.pathname).toBe('/photo/:/transcode');
    expect(url.searchParams.get('width')).toBe('240');
    expect(url.searchParams.get('height')).toBe('360');
    expect(url.searchParams.get('upscale')).toBe('0');
    expect(url.searchParams.get('minSize')).toBe('1');
    expect(url.searchParams.get('url')).toBe('/library/metadata/1/thumb/2');
    expect(url.searchParams.get('X-Plex-Token')).toBe('tok123');
  });

  it('jellyfin portrait resize constrains the long axis via maxHeight', () => {
    const server = { ...baseServer, type: 'jellyfin' } as never;
    const { imageUrl, headers } = buildUpstreamRequest(server, '/Items/abc/Images/Primary', {
      width: 240,
      height: 360,
    });
    expect(imageUrl).toBe('http://media:1234/Items/abc/Images/Primary?maxHeight=360&quality=90');
    expect(headers['Authorization']).toBe('MediaBrowser Token="tok123"');
  });

  it('emby landscape resize constrains the long axis via maxWidth', () => {
    const server = { ...baseServer, type: 'emby' } as never;
    const { imageUrl, headers } = buildUpstreamRequest(server, '/emby/Items/9/Images/Backdrop', {
      width: 500,
      height: 280,
    });
    expect(imageUrl).toBe('http://media:1234/emby/Items/9/Images/Backdrop?maxWidth=500&quality=90');
    expect(headers['X-Emby-Token']).toBe('tok123');
  });

  it('preserves an existing query string when appending resize params', () => {
    const server = { ...baseServer, type: 'jellyfin' } as never;
    const { imageUrl } = buildUpstreamRequest(server, '/Items/abc/Images/Primary?tag=5', {
      width: 240,
      height: 360,
    });
    expect(imageUrl).toBe(
      'http://media:1234/Items/abc/Images/Primary?tag=5&maxHeight=360&quality=90'
    );
  });
});
