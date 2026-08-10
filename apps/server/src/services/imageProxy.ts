/**
 * Image proxy service for Plex/Jellyfin images
 *
 * Fetches images from media servers, resizes them, and caches to disk.
 * This avoids CORS issues and reduces bandwidth to media servers.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import {
  readFile,
  writeFile,
  rename,
  stat as fsStat,
  unlink,
  utimes,
  readdir,
  mkdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { and, eq, isNull } from 'drizzle-orm';
import { TIME_MS } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, libraryItems } from '../db/schema.js';
import { registerService, unregisterService } from './serviceTracker.js';

// libvips defaults its thread pool to the core count, so one background
// precache walk can own every core of a small box. Inputs are server-resized
// thumbnails now; one thread is plenty and the poller keeps its CPU.
sharp.concurrency(1);
// Token encryption removed - tokens now stored in plain text (DB is localhost-only)

// Cache directory (in project root/data/image-cache), sharded by the first two
// hex chars of the cache key so no single directory holds every cached file.
const CACHE_DIR = join(process.cwd(), 'data', 'image-cache');
const CACHE_TTL_MS = TIME_MS.DAY;

// Maximum cache size in MB. Versioned entries (requests carrying `v=`) are
// exempt from the TTL sweep below but still count toward this cap and are
// evicted oldest-first, same as unversioned entries.
const IMAGE_CACHE_MAX_MB = (() => {
  const parsed = Number(process.env.IMAGE_CACHE_MAX_MB);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3072;
})();

// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

// Fallback SVG placeholders
const FALLBACK_POSTER = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
  <rect width="300" height="450" fill="#1a1a2e"/>
  <g transform="translate(110, 180)" fill="#4a4a6a">
    <rect x="0" y="0" width="80" height="100" rx="4"/>
    <circle cx="40" cy="35" r="15"/>
    <path d="M10 75 L35 50 L50 65 L70 45 L90 75 Z" fill="#3a3a5a"/>
  </g>
  <text x="150" y="320" text-anchor="middle" fill="#6a6a8a" font-family="system-ui" font-size="14">No Image</text>
</svg>`;

const FALLBACK_AVATAR = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#1a1a2e" rx="50"/>
  <circle cx="50" cy="38" r="18" fill="#4a4a6a"/>
  <ellipse cx="50" cy="85" rx="28" ry="22" fill="#4a4a6a"/>
</svg>`;

const FALLBACK_ART = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="280" viewBox="0 0 500 280">
  <defs>
    <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e"/>
      <stop offset="100%" style="stop-color:#0f0f1a"/>
    </linearGradient>
  </defs>
  <rect width="500" height="280" fill="url(#grad)"/>
</svg>`;

export type FallbackType = 'poster' | 'avatar' | 'art';

interface ProxyOptions {
  serverId: string;
  imagePath: string;
  width?: number;
  height?: number;
  fallback?: FallbackType;
  /** Cache-busting fingerprint from posterVersionFor; presence marks the cache entry immutable. */
  version?: string;
  /** Precache-only: waits for the real miss pipeline instead of racing it against
   *  the LQIP placeholder, so a slow upstream can't free the caller's warm-pool
   *  slot early and stack pipelines ahead of live requests. */
  skipLqipRace?: boolean;
}

interface ProxyResult {
  data: Buffer;
  contentType: string;
  cached: boolean;
  /** Overrides the caller's default Cache-Control (used for the LQIP degraded response). */
  cacheControl?: string;
}

/**
 * Neutral placeholder color used when no dominant color is known yet.
 */
const NEUTRAL_PLACEHOLDER_COLOR = '#27272a';

// A waiter stuck behind the fetch semaphore this long gets served the LQIP
// placeholder instead; the real pipeline keeps running in the background.
const SEMAPHORE_WAIT_TIMEOUT_MS = 2000;

// Cache-Control for degraded responses (LQIP placeholder, error fallback SVG):
// short-lived and never immutable, so a transient upstream failure or a slow
// pipeline can't get pinned into a versioned request's normally-year-long cache.
const DEGRADED_CACHE_CONTROL = 'public, max-age=15';

interface CacheKeyInfo {
  fileName: string;
  shard: string;
  versioned: boolean;
}

/**
 * Build the sharded cache key/path info for a request. Versioned entries
 * (a `v=` fingerprint was supplied) get a `:v<hash>` suffix on the filename
 * so cleanup can tell them apart from unversioned entries at a glance.
 */
function buildCacheKeyInfo(
  serverId: string,
  imagePath: string,
  width: number,
  height: number,
  version?: string
): CacheKeyInfo {
  const baseHash = createHash('sha256')
    .update(`${serverId}:${imagePath}:${width}:${height}`)
    .digest('hex')
    .slice(0, 16);
  const shard = baseHash.slice(0, 2);
  const versioned = Boolean(version);
  const fileName = versioned ? `${baseHash}:v${version}.webp` : `${baseHash}.webp`;
  return { fileName, shard, versioned };
}

function isVersionedFileName(fileName: string): boolean {
  // Orphaned tmp files from a failed write inherit the `:v<hash>` substring
  // when the source entry was versioned, so `.tmp.` must win over that check
  // or they'd be treated as immutable and never swept.
  if (fileName.includes('.tmp.')) return false;
  return fileName.includes(':v');
}

/**
 * Get fallback SVG buffer
 */
function getFallbackImage(type: FallbackType, _width: number, _height: number): Buffer {
  let svg: string;
  switch (type) {
    case 'avatar':
      svg = FALLBACK_AVATAR;
      break;
    case 'art':
      svg = FALLBACK_ART;
      break;
    case 'poster':
    default:
      svg = FALLBACK_POSTER;
      break;
  }

  // Return the SVG resized to requested dimensions
  return Buffer.from(svg);
}

interface CacheFileInfo {
  path: string;
  size: number;
  mtime: number;
  versioned: boolean;
}

async function addCacheFileInfo(
  filePath: string,
  fileName: string,
  out: CacheFileInfo[]
): Promise<void> {
  try {
    const stats = await fsStat(filePath);
    out.push({
      path: filePath,
      size: stats.size,
      mtime: stats.mtimeMs,
      versioned: isVersionedFileName(fileName),
    });
  } catch {
    // Ignore errors for individual files
  }
}

interface CacheFileRef {
  path: string;
  fileName: string;
}

/** Enumerates the (sharded) cache dir without stat-ing anything yet; legacy flat files count too. */
async function listCacheFileRefs(): Promise<CacheFileRef[]> {
  const refs: CacheFileRef[] = [];
  let entries;
  try {
    entries = await readdir(CACHE_DIR, { withFileTypes: true });
  } catch {
    return refs;
  }

  for (const entry of entries) {
    const entryPath = join(CACHE_DIR, entry.name);
    if (entry.isDirectory()) {
      let shardFiles: string[];
      try {
        shardFiles = await readdir(entryPath);
      } catch {
        continue;
      }
      for (const file of shardFiles) {
        refs.push({ path: join(entryPath, file), fileName: file });
      }
    } else if (entry.isFile()) {
      refs.push({ path: entryPath, fileName: entry.name });
    }
  }

  return refs;
}

// Caps how many stat calls run at once during a sweep, so a cache holding
// hundreds of thousands of files doesn't stat them one at a time.
const CLEANUP_STAT_BATCH_SIZE = 32;

async function collectCacheFiles(): Promise<CacheFileInfo[]> {
  const refs = await listCacheFileRefs();
  const results: CacheFileInfo[] = [];
  for (let i = 0; i < refs.length; i += CLEANUP_STAT_BATCH_SIZE) {
    const batch = refs.slice(i, i + CLEANUP_STAT_BATCH_SIZE);
    await Promise.all(batch.map((ref) => addCacheFileInfo(ref.path, ref.fileName, results)));
  }
  return results;
}

/**
 * Clean up old cache files. Versioned entries are exempt from the TTL sweep
 * (their filename fingerprint changes whenever the source poster changes, so
 * age alone doesn't mean stale) but still count toward the size cap below.
 */
export async function cleanupCache(): Promise<void> {
  try {
    const files = await collectCacheFiles();
    const now = Date.now();
    let totalSize = 0;
    const survivors: CacheFileInfo[] = [];

    for (const file of files) {
      if (!file.versioned && now - file.mtime > CACHE_TTL_MS) {
        try {
          await unlink(file.path);
          continue;
        } catch {
          // Ignore
        }
      }
      totalSize += file.size;
      survivors.push(file);
    }

    // If still over size limit, delete oldest files (LRU via mtime, kept
    // fresh on cache hits by the fire-and-forget utimes touch below)
    const maxSizeBytes = IMAGE_CACHE_MAX_MB * 1024 * 1024;
    if (totalSize > maxSizeBytes) {
      survivors.sort((a, b) => a.mtime - b.mtime);
      for (const file of survivors) {
        if (totalSize <= maxSizeBytes * 0.8) break; // Reduce to 80% of max
        try {
          await unlink(file.path);
          totalSize -= file.size;
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

// Run cleanup periodically (every hour)
let cleanupInterval: NodeJS.Timeout | null = setInterval(() => {
  void cleanupCache();
}, TIME_MS.HOUR);
registerService('image-cache-cleanup', {
  name: 'Image Cache Cleanup',
  description: 'Cleans up expired cached images',
  intervalMs: TIME_MS.HOUR,
});

// Also run on startup
void cleanupCache();

export function stopImageCacheCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    unregisterService('image-cache-cleanup');
  }
}

async function readFromCache(cachePath: string, versioned: boolean): Promise<ProxyResult | null> {
  let stats;
  try {
    stats = await fsStat(cachePath);
  } catch {
    return null;
  }

  const isFresh = versioned || Date.now() - stats.mtimeMs < CACHE_TTL_MS;
  if (!isFresh) return null;

  try {
    const data = await readFile(cachePath);
    // LRU touch so size-cap eviction favors recently-served entries; the
    // response doesn't depend on this succeeding.
    const now = new Date();
    void utimes(cachePath, now, now).catch(() => undefined);
    return { data, contentType: 'image/webp', cached: true };
  } catch {
    return null;
  }
}

async function writeCacheAtomic(shardDir: string, cachePath: string, data: Buffer): Promise<void> {
  const tmpPath = `${cachePath}.tmp.${process.pid}`;
  try {
    await mkdir(shardDir, { recursive: true });
    await writeFile(tmpPath, data);
    await rename(tmpPath, cachePath);
  } catch {
    // Cache write failure is non-fatal, but don't leave the tmp file behind
    await unlink(tmpPath).catch(() => undefined);
  }
}

async function computeDominantColorHex(imageBuffer: Buffer): Promise<string> {
  const { data, info } = await sharp(imageBuffer)
    .resize(1, 1)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const r = data[0] ?? 0;
  const g = info.channels > 1 ? (data[1] ?? r) : r;
  const b = info.channels > 1 ? (data[2] ?? g) : g;
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Persist the computed dominant color, but only when the row doesn't have
 * one yet. This pipeline is the sole writer of dominant_color (library sync
 * never touches it) - write-once by design, and a failed UPDATE here must
 * never fail the image response itself.
 *
 * The miss coalescing map is keyed per size, so one poster requested at
 * 160/240/360 reaches here concurrently, and several rows can share a
 * thumb_path - identical multi-row updates then deadlock on row order.
 * Same-image persists share one in-flight attempt; a deadlock loser retries
 * once, which the NULL guard turns into a no-op if another writer committed.
 */
const inFlightColorPersists = new Map<string, Promise<void>>();

function isDeadlockError(err: unknown): boolean {
  const code =
    (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  return code === '40P01';
}

export async function persistDominantColorIfNeeded(
  serverId: string,
  imagePath: string,
  imageBuffer: Buffer
): Promise<void> {
  const key = `${serverId}:${imagePath}`;
  const inFlight = inFlightColorPersists.get(key);
  if (inFlight) return inFlight;

  const attempt = (async () => {
    try {
      const hex = await computeDominantColorHex(imageBuffer);
      const write = () =>
        db
          .update(libraryItems)
          .set({ dominantColor: hex })
          .where(
            and(
              eq(libraryItems.serverId, serverId),
              eq(libraryItems.thumbPath, imagePath),
              isNull(libraryItems.dominantColor)
            )
          );
      try {
        await write();
      } catch (err) {
        if (!isDeadlockError(err)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 150));
        await write();
      }
    } catch (err) {
      console.error('[ImageProxy] Failed to persist dominant color', err);
    } finally {
      inFlightColorPersists.delete(key);
    }
  })();

  inFlightColorPersists.set(key, attempt);
  return attempt;
}

async function getKnownDominantColor(serverId: string, imagePath: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ dominantColor: libraryItems.dominantColor })
      .from(libraryItems)
      .where(and(eq(libraryItems.serverId, serverId), eq(libraryItems.thumbPath, imagePath)))
      .limit(1);
    return row?.dominantColor ?? null;
  } catch {
    return null;
  }
}

/**
 * Build a 1x1 WebP placeholder from a hex color (dominant color when known,
 * else a neutral gray). Used when a request is stuck behind the fetch
 * semaphore for too long.
 */
export async function buildLqipPlaceholder(dominantColorHex?: string | null): Promise<Buffer> {
  const hex = (dominantColorHex ?? NEUTRAL_PLACEHOLDER_COLOR).replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  return sharp(Buffer.from([r, g, b]), { raw: { width: 1, height: 1, channels: 3 } })
    .webp({ quality: 20 })
    .toBuffer();
}

// Global semaphore bounding concurrent upstream fetch+decode+write work
// across ALL requests, distinct keys included - inlined rather than adding
// a dependency (the repo has no p-limit).
const MAX_CONCURRENT_FETCHES = 6;
let activeFetchSlots = 0;
const fetchSlotQueue: Array<() => void> = [];

function acquireFetchSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      activeFetchSlots++;
      resolve(() => {
        activeFetchSlots--;
        const next = fetchSlotQueue.shift();
        if (next) next();
      });
    };
    if (activeFetchSlots < MAX_CONCURRENT_FETCHES) {
      grant();
    } else {
      fetchSlotQueue.push(grant);
    }
  });
}

export function buildUpstreamRequest(
  server: typeof servers.$inferSelect,
  imagePath: string,
  resize?: { width: number; height: number }
): { imageUrl: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { Accept: 'image/*' };
  const baseUrl = server.url.replace(/\/$/, '');

  if (server.type === 'plex') {
    // Plex image URLs are relative paths like /library/metadata/123/thumb/456
    if (resize) {
      // Plex's photo transcoder resizes and caches server-side - a 240px
      // poster arrives as ~20KB instead of the multi-MB original. upscale=0
      // keeps small sources untouched; minSize=1 fills the requested box.
      const params = new URLSearchParams({
        width: String(resize.width),
        height: String(resize.height),
        minSize: '1',
        upscale: '0',
        url: imagePath,
        'X-Plex-Token': server.token,
      });
      return { imageUrl: `${baseUrl}/photo/:/transcode?${params.toString()}`, headers };
    }
    const separator = imagePath.includes('?') ? '&' : '?';
    return { imageUrl: `${baseUrl}${imagePath}${separator}X-Plex-Token=${server.token}`, headers };
  }

  // Jellyfin/Emby - imagePath should include the full endpoint
  if (server.type === 'jellyfin') {
    headers['Authorization'] = `MediaBrowser Token="${server.token}"`;
  } else {
    headers['X-Emby-Token'] = server.token;
  }
  if (resize) {
    // Both accept max-dimension params on image endpoints and cache the
    // result. Constrain only the target's long axis so the cover crop below
    // always has enough pixels where it matters; sharp still normalizes to
    // the exact box, but it decodes a thumbnail instead of the original.
    const separator = imagePath.includes('?') ? '&' : '?';
    const dimension =
      resize.height >= resize.width ? `maxHeight=${resize.height}` : `maxWidth=${resize.width}`;
    return {
      imageUrl: `${baseUrl}${imagePath}${separator}${dimension}&quality=90`,
      headers,
    };
  }
  return { imageUrl: `${baseUrl}${imagePath}`, headers };
}

interface MissPipelineArgs {
  serverId: string;
  imagePath: string;
  width: number;
  height: number;
  fallback: FallbackType;
  cachePath: string;
  shardDir: string;
}

/**
 * The whole cache-miss pipeline: server lookup, upstream fetch (behind the
 * global semaphore), resize/encode, atomic cache write, and the write-once
 * dominant color persist. Wrapped by the coalescing map in proxyImage so
 * concurrent misses for the same key run this exactly once.
 */
// Server rows change rarely (URL or token edits), and every cache miss needs
// one - during a warm pass that's hundreds of identical point lookups. The
// short TTL means a token rotation takes at most 30s to reach this path.
const SERVER_ROW_TTL_MS = 30_000;
const serverRowCache = new Map<string, { row: typeof servers.$inferSelect | null; at: number }>();

export function _resetServerRowCacheForTests(): void {
  serverRowCache.clear();
}

async function getServerRow(serverId: string): Promise<typeof servers.$inferSelect | null> {
  const cached = serverRowCache.get(serverId);
  if (cached && Date.now() - cached.at < SERVER_ROW_TTL_MS) return cached.row;
  const [row] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  serverRowCache.set(serverId, { row: row ?? null, at: Date.now() });
  return row ?? null;
}

async function runMissPipeline(args: MissPipelineArgs): Promise<ProxyResult> {
  const { serverId, imagePath, width, height, fallback, cachePath, shardDir } = args;

  const server = await getServerRow(serverId);
  if (!server) {
    return {
      data: getFallbackImage(fallback, width, height),
      contentType: 'image/svg+xml',
      cached: false,
      cacheControl: DEGRADED_CACHE_CONTROL,
    };
  }

  // Ask the media server for a pre-resized image first (all three types
  // resize and cache server-side; a 240px poster is ~20-40KB against a
  // multi-MB original). Fall back to the original path so a transcoder
  // hiccup degrades to the old behavior instead of a broken image.
  const candidates = [
    buildUpstreamRequest(server, imagePath, { width, height }),
    buildUpstreamRequest(server, imagePath),
  ];

  const release = await acquireFetchSlot();
  try {
    let imageBuffer: Buffer | null = null;
    let lastError: unknown = null;
    for (const { imageUrl, headers } of candidates) {
      try {
        const response = await fetch(imageUrl, {
          headers,
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });

        // Reject only clearly-non-image payloads (the Plex transcoder can
        // return an XML error page with a 200). Anything else - image/*,
        // octet-stream, or a missing header - proceeds; sharp is the final
        // arbiter and its failure lands in the same fallback path.
        const contentType = response.headers?.get('content-type') ?? '';
        const clearlyNotImage = /^(text\/|application\/(json|xml|xhtml))/i.test(contentType);
        if (!response.ok || clearlyNotImage) {
          // Drain the body so undici releases the connection instead of
          // holding it open until the socket times out.
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`HTTP ${response.status} (${contentType || 'no content-type'})`);
        }

        imageBuffer = Buffer.from(await response.arrayBuffer());
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!imageBuffer) {
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError ?? 'upstream fetch failed'));
    }

    const resized = await sharp(imageBuffer)
      .resize(width, height, {
        fit: 'cover',
        position: 'center',
      })
      .webp({ quality: 80 })
      .toBuffer();

    await writeCacheAtomic(shardDir, cachePath, resized);
    // Fire-and-forget: the write-once color persist already self-catches
    // errors, so the response and semaphore release don't wait on a DB round-trip.
    void persistDominantColorIfNeeded(serverId, imagePath, resized);

    return { data: resized, contentType: 'image/webp', cached: false };
  } catch {
    // Return fallback on any error, capped at a short cache lifetime so an
    // upstream blip (e.g. a Plex restart) can't pin "No Image" for a year.
    return {
      data: getFallbackImage(fallback, width, height),
      contentType: 'image/svg+xml',
      cached: false,
      cacheControl: DEGRADED_CACHE_CONTROL,
    };
  } finally {
    release();
  }
}

// Coalesces concurrent misses for the same cache key into one pipeline run.
const inFlightMisses = new Map<string, Promise<ProxyResult>>();

/**
 * If the shared pipeline promise hasn't settled within the semaphore wait
 * timeout, resolve THIS caller with an LQIP placeholder instead of making it
 * wait longer. The pipeline keeps running in the background (other callers,
 * or a future request, still get the real image once it lands).
 */
function raceWithLqipFallback(
  pipelinePromise: Promise<ProxyResult>,
  serverId: string,
  imagePath: string
): Promise<ProxyResult> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void (async () => {
        const known = await getKnownDominantColor(serverId, imagePath);
        const data = await buildLqipPlaceholder(known);
        resolve({
          data,
          contentType: 'image/webp',
          cached: false,
          cacheControl: DEGRADED_CACHE_CONTROL,
        });
      })().catch(reject);
    }, SEMAPHORE_WAIT_TIMEOUT_MS);

    pipelinePromise.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/**
 * Fetch and proxy an image from a media server
 */
export async function proxyImage(options: ProxyOptions): Promise<ProxyResult> {
  const {
    serverId,
    imagePath,
    width = 300,
    height = 450,
    fallback = 'poster',
    version,
    skipLqipRace,
  } = options;

  const { fileName, shard, versioned } = buildCacheKeyInfo(
    serverId,
    imagePath,
    width,
    height,
    version
  );
  const shardDir = join(CACHE_DIR, shard);
  const cachePath = join(shardDir, fileName);

  const cached = await readFromCache(cachePath, versioned);
  if (cached) {
    return cached;
  }

  let pipelinePromise = inFlightMisses.get(fileName);
  if (!pipelinePromise) {
    pipelinePromise = runMissPipeline({
      serverId,
      imagePath,
      width,
      height,
      fallback,
      cachePath,
      shardDir,
    }).finally(() => {
      inFlightMisses.delete(fileName);
    });
    inFlightMisses.set(fileName, pipelinePromise);
  }

  // Only versioned requests can revalidate later, so only they get raced against the LQIP placeholder.
  if (skipLqipRace || !versioned) return pipelinePromise;
  return raceWithLqipFallback(pipelinePromise, serverId, imagePath);
}

/**
 * Get a gravatar URL for an email
 */
export function getGravatarUrl(email: string | null | undefined, size: number = 100): string {
  if (!email) {
    return ''; // Will use fallback
  }
  const hash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=mp`;
}

// ============================================================================
// External URL Construction
// ============================================================================

/**
 * Size presets optimized for different use cases.
 * Push notifications use smaller images to reduce bandwidth and load faster.
 * API responses use standard sizes for flexibility.
 */
export const IMAGE_SIZES = {
  // Push notification sizes (smaller for fast loading)
  pushPoster: { width: 200, height: 300 },
  pushAvatar: { width: 80, height: 80 },
  pushLogo: { width: 128, height: 128 },

  // API response sizes (standard)
  apiPoster: { width: 300, height: 450 },
  apiPosterSmall: { width: 150, height: 225 },
  apiAvatar: { width: 100, height: 100 },
  apiArt: { width: 500, height: 280 },

  // Browsing grid buckets (must stay in sync with POSTER_BUCKET_WIDTHS)
  posterGrid160: { width: 160, height: 240 },
  posterGrid240: { width: 240, height: 360 },
  posterGrid360: { width: 360, height: 540 },
} as const;

/**
 * Allow-list of widths the `v=` versioned cache path accepts. Requests
 * carrying a version fingerprint must use one of these buckets.
 */
export const POSTER_BUCKET_WIDTHS = [160, 240, 360] as const;

export interface ProxyUrlOptions {
  serverId: string;
  path: string;
  width?: number;
  height?: number;
  fallback?: FallbackType;
}

/**
 * Build a relative proxy URL for use in API responses.
 * Callers can prepend their known base URL.
 */
export function buildProxyUrl(options: ProxyUrlOptions): string {
  const { serverId, path, width = 300, height = 450, fallback = 'poster' } = options;
  const params = new URLSearchParams({
    server: serverId,
    url: path,
    width: String(width),
    height: String(height),
    fallback,
  });
  return `/api/v1/images/proxy?${params}`;
}

/**
 * Build an absolute proxy URL for push notifications.
 * Returns null if baseUrl is not configured or path is missing.
 */
export function buildAbsoluteProxyUrl(
  baseUrl: string | null | undefined,
  options: ProxyUrlOptions
): string | null {
  if (!baseUrl || !options.path) return null;
  return `${baseUrl.replace(/\/$/, '')}${buildProxyUrl(options)}`;
}

/**
 * Short cache-busting fingerprint for a poster path (first 8 hex chars of its sha1).
 */
export function posterVersionFor(thumbPath: string): string {
  return createHash('sha1').update(thumbPath).digest('hex').slice(0, 8);
}

/**
 * Whether the versioned poster-grid cache entry for this path already exists
 * on disk, using the exact cache key derivation the proxy pipeline itself
 * uses (buildCacheKeyInfo + posterVersionFor). Width must be one of the
 * grid buckets the browse UI requests (posterGrid160 / posterGrid240 / posterGrid360).
 */
export async function posterCacheEntryExists(
  serverId: string,
  thumbPath: string,
  width: 160 | 240 | 360
): Promise<boolean> {
  const dimensions =
    width === 160
      ? IMAGE_SIZES.posterGrid160
      : width === 240
        ? IMAGE_SIZES.posterGrid240
        : IMAGE_SIZES.posterGrid360;
  const version = posterVersionFor(thumbPath);
  const { fileName, shard } = buildCacheKeyInfo(
    serverId,
    thumbPath,
    dimensions.width,
    dimensions.height,
    version
  );
  try {
    await fsStat(join(CACHE_DIR, shard, fileName));
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a poster URL for API responses (relative).
 */
export function buildPosterUrl(
  serverId: string | null | undefined,
  thumbPath: string | null | undefined,
  size: 'standard' | 'small' = 'standard'
): string | null {
  if (!serverId || !thumbPath) return null;
  const dimensions = size === 'small' ? IMAGE_SIZES.apiPosterSmall : IMAGE_SIZES.apiPoster;
  return buildProxyUrl({
    serverId,
    path: thumbPath,
    ...dimensions,
    fallback: 'poster',
  });
}

/**
 * Build an avatar URL for API responses (relative).
 * Returns the URL as-is if it's already an absolute URL (e.g., from Plex.tv).
 */
export function buildAvatarUrl(
  serverId: string | null | undefined,
  thumbUrl: string | null | undefined,
  size: number = IMAGE_SIZES.apiAvatar.width
): string | null {
  if (!thumbUrl) return null;
  // Direct links (e.g., from Plex.tv) are already absolute
  if (thumbUrl.startsWith('http')) return thumbUrl;
  if (!serverId) return null;
  return buildProxyUrl({
    serverId,
    path: thumbUrl,
    width: size,
    height: size,
    fallback: 'avatar',
  });
}

/**
 * Build a poster URL for push notifications (absolute).
 */
export function buildPushPosterUrl(
  baseUrl: string | null | undefined,
  serverId: string | null | undefined,
  thumbPath: string | null | undefined
): string | null {
  if (!serverId || !thumbPath) return null;
  return buildAbsoluteProxyUrl(baseUrl, {
    serverId,
    path: thumbPath,
    ...IMAGE_SIZES.pushPoster,
    fallback: 'poster',
  });
}

/**
 * Build an avatar URL for push notifications (absolute).
 * Returns the URL as-is if it's already an absolute URL.
 */
export function buildPushAvatarUrl(
  baseUrl: string | null | undefined,
  serverId: string | null | undefined,
  thumbUrl: string | null | undefined
): string | null {
  if (!thumbUrl) return null;
  // Direct links are already absolute
  if (thumbUrl.startsWith('http')) return thumbUrl;
  if (!serverId) return null;
  return buildAbsoluteProxyUrl(baseUrl, {
    serverId,
    path: thumbUrl,
    ...IMAGE_SIZES.pushAvatar,
    fallback: 'avatar',
  });
}

/**
 * Build the static logo URL for push notifications.
 */
export function buildLogoUrl(baseUrl: string | null | undefined): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, '')}/api/v1/images/logo`;
}
