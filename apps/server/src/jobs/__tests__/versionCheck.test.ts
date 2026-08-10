/**
 * Version Check Queue Tests
 *
 * Tests the version comparison and parsing functions:
 * - parseVersion: Parse semantic version strings with prerelease support
 * - isPrerelease: Detect if a version is a prerelease
 * - getBaseVersion: Get base version without prerelease suffix
 * - compareVersions: Compare two semantic versions
 * - isNewerVersion: Check if one version is newer than another
 * - fetchGitHubReleases: Rate-limit error handling
 * - processVersionCheck: Cooldown guard and rate-limit recovery
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseVersion,
  isPrerelease,
  getBaseVersion,
  compareVersions,
  isNewerVersion,
  findBestUpdateForPrerelease,
  fetchGitHubReleases,
  GitHubRateLimitError,
  processVersionCheck,
  initVersionCheckQueue,
  type GitHubRelease,
} from '../versionCheckQueue.js';

// ---- module-level mocks needed for processVersionCheck tests ----

vi.mock('bullmq', () => {
  function MockQueue(this: Record<string, unknown>) {
    this.add = vi.fn();
    this.close = vi.fn();
    this.getJobSchedulers = vi.fn().mockResolvedValue([]);
    this.removeJobScheduler = vi.fn();
    this.on = vi.fn();
  }
  function MockWorker(this: Record<string, unknown>) {
    this.on = vi.fn();
    this.close = vi.fn();
  }
  return { Queue: MockQueue, Worker: MockWorker };
});

vi.mock('../../serverState.js', () => ({ isMaintenance: vi.fn().mockReturnValue(false) }));

const mockGetCurrentVersion = vi.fn().mockReturnValue('1.4.0');
vi.mock('../../utils/buildInfo.js', () => ({
  getCurrentVersion: () => mockGetCurrentVersion(),
  getCurrentTag: vi.fn(),
  getCurrentCommit: vi.fn(),
  getBuildDate: vi.fn(),
}));

describe('parseVersion', () => {
  describe('stable versions', () => {
    it('should parse simple version', () => {
      const v = parseVersion('1.3.9');
      expect(v.major).toBe(1);
      expect(v.minor).toBe(3);
      expect(v.patch).toBe(9);
      expect(v.isPrerelease).toBe(false);
      expect(v.prerelease).toBeNull();
      expect(v.prereleaseNum).toBeNull();
    });

    it('should parse version with v prefix', () => {
      const v = parseVersion('v1.3.9');
      expect(v.major).toBe(1);
      expect(v.minor).toBe(3);
      expect(v.patch).toBe(9);
      expect(v.isPrerelease).toBe(false);
    });

    it('should parse version with zeros', () => {
      const v = parseVersion('0.0.1');
      expect(v.major).toBe(0);
      expect(v.minor).toBe(0);
      expect(v.patch).toBe(1);
    });
  });

  describe('prerelease versions', () => {
    it('should parse beta version with number', () => {
      const v = parseVersion('1.3.9-beta.3');
      expect(v.major).toBe(1);
      expect(v.minor).toBe(3);
      expect(v.patch).toBe(9);
      expect(v.isPrerelease).toBe(true);
      expect(v.prerelease).toBe('beta');
      expect(v.prereleaseNum).toBe(3);
    });

    it('should parse alpha version', () => {
      const v = parseVersion('v2.0.0-alpha.1');
      expect(v.major).toBe(2);
      expect(v.minor).toBe(0);
      expect(v.patch).toBe(0);
      expect(v.isPrerelease).toBe(true);
      expect(v.prerelease).toBe('alpha');
      expect(v.prereleaseNum).toBe(1);
    });

    it('should parse rc version', () => {
      const v = parseVersion('1.4.0-rc.2');
      expect(v.major).toBe(1);
      expect(v.minor).toBe(4);
      expect(v.patch).toBe(0);
      expect(v.isPrerelease).toBe(true);
      expect(v.prerelease).toBe('rc');
      expect(v.prereleaseNum).toBe(2);
    });

    it('should handle double-digit prerelease numbers', () => {
      const v = parseVersion('1.3.9-beta.10');
      expect(v.prereleaseNum).toBe(10);
    });
  });

  describe('malformed versions', () => {
    it('should return zeros for empty string', () => {
      const v = parseVersion('');
      expect(v.major).toBe(0);
      expect(v.minor).toBe(0);
      expect(v.patch).toBe(0);
    });

    it('should return zeros for invalid format', () => {
      const v = parseVersion('not-a-version');
      expect(v.major).toBe(0);
      expect(v.minor).toBe(0);
      expect(v.patch).toBe(0);
    });
  });
});

describe('isPrerelease', () => {
  it('should return false for stable versions', () => {
    expect(isPrerelease('1.3.9')).toBe(false);
    expect(isPrerelease('v1.3.9')).toBe(false);
    expect(isPrerelease('0.0.1')).toBe(false);
  });

  it('should return true for beta versions', () => {
    expect(isPrerelease('1.3.9-beta.1')).toBe(true);
    expect(isPrerelease('v1.4.0-beta.3')).toBe(true);
  });

  it('should return true for alpha versions', () => {
    expect(isPrerelease('2.0.0-alpha.1')).toBe(true);
  });

  it('should return true for rc versions', () => {
    expect(isPrerelease('1.4.0-rc.1')).toBe(true);
  });

  it('should return true for other prerelease types', () => {
    expect(isPrerelease('1.0.0-dev.1')).toBe(true);
    expect(isPrerelease('1.0.0-canary.5')).toBe(true);
    expect(isPrerelease('1.0.0-next.2')).toBe(true);
  });
});

describe('getBaseVersion', () => {
  it('should return same version for stable', () => {
    expect(getBaseVersion('1.3.9')).toBe('1.3.9');
    expect(getBaseVersion('v1.3.9')).toBe('1.3.9');
  });

  it('should strip prerelease suffix', () => {
    expect(getBaseVersion('1.3.9-beta.3')).toBe('1.3.9');
    expect(getBaseVersion('v1.4.0-beta.10')).toBe('1.4.0');
    expect(getBaseVersion('2.0.0-alpha.1')).toBe('2.0.0');
  });
});

describe('compareVersions', () => {
  describe('stable version comparisons', () => {
    it('should return 0 for equal versions', () => {
      expect(compareVersions('1.3.9', '1.3.9')).toBe(0);
      expect(compareVersions('v1.3.9', '1.3.9')).toBe(0);
    });

    it('should compare major versions', () => {
      expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
      expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
    });

    it('should compare minor versions', () => {
      expect(compareVersions('1.4.0', '1.3.0')).toBe(1);
      expect(compareVersions('1.3.0', '1.4.0')).toBe(-1);
    });

    it('should compare patch versions', () => {
      expect(compareVersions('1.3.10', '1.3.9')).toBe(1);
      expect(compareVersions('1.3.9', '1.3.10')).toBe(-1);
    });
  });

  describe('prerelease vs stable', () => {
    it('should rank stable higher than prerelease of same base', () => {
      // 1.3.9 (stable) > 1.3.9-beta.99
      expect(compareVersions('1.3.9', '1.3.9-beta.99')).toBe(1);
      expect(compareVersions('1.3.9-beta.99', '1.3.9')).toBe(-1);
    });

    it('should rank higher base version prerelease over lower stable', () => {
      // 1.4.0-beta.1 > 1.3.9 (higher major.minor)
      expect(compareVersions('1.4.0-beta.1', '1.3.9')).toBe(1);
      expect(compareVersions('1.3.9', '1.4.0-beta.1')).toBe(-1);
    });
  });

  describe('prerelease comparisons', () => {
    it('should compare same prerelease type by number', () => {
      expect(compareVersions('1.3.9-beta.2', '1.3.9-beta.1')).toBe(1);
      expect(compareVersions('1.3.9-beta.1', '1.3.9-beta.2')).toBe(-1);
      expect(compareVersions('1.3.9-beta.10', '1.3.9-beta.9')).toBe(1);
    });

    it('should compare different prerelease types', () => {
      // alpha < beta < rc
      expect(compareVersions('1.3.9-beta.1', '1.3.9-alpha.1')).toBe(1);
      expect(compareVersions('1.3.9-rc.1', '1.3.9-beta.1')).toBe(1);
      expect(compareVersions('1.3.9-alpha.1', '1.3.9-beta.1')).toBe(-1);
    });

    it('should return 0 for equal prereleases', () => {
      expect(compareVersions('1.3.9-beta.3', '1.3.9-beta.3')).toBe(0);
    });
  });
});

describe('isNewerVersion', () => {
  describe('stable to stable', () => {
    it('should detect newer major version', () => {
      expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
      expect(isNewerVersion('1.9.9', '2.0.0')).toBe(false);
    });

    it('should detect newer minor version', () => {
      expect(isNewerVersion('1.4.0', '1.3.9')).toBe(true);
      expect(isNewerVersion('1.3.9', '1.4.0')).toBe(false);
    });

    it('should detect newer patch version', () => {
      expect(isNewerVersion('1.3.10', '1.3.9')).toBe(true);
      expect(isNewerVersion('1.3.9', '1.3.10')).toBe(false);
    });

    it('should return false for same version', () => {
      expect(isNewerVersion('1.3.9', '1.3.9')).toBe(false);
    });
  });

  describe('beta to beta', () => {
    it('should detect newer beta of same base', () => {
      expect(isNewerVersion('1.3.9-beta.2', '1.3.9-beta.1')).toBe(true);
      expect(isNewerVersion('1.3.9-beta.1', '1.3.9-beta.2')).toBe(false);
    });

    it('should handle double-digit beta numbers', () => {
      expect(isNewerVersion('1.3.9-beta.10', '1.3.9-beta.9')).toBe(true);
      expect(isNewerVersion('1.3.9-beta.9', '1.3.9-beta.10')).toBe(false);
    });

    it('should return false for same beta', () => {
      expect(isNewerVersion('1.3.9-beta.3', '1.3.9-beta.3')).toBe(false);
    });
  });

  describe('beta to stable transitions', () => {
    it('should detect stable release of same base as newer', () => {
      // User on 1.3.9-beta.4, stable 1.3.9 released
      expect(isNewerVersion('1.3.9', '1.3.9-beta.4')).toBe(true);
      expect(isNewerVersion('1.3.9', '1.3.9-beta.99')).toBe(true);
    });

    it('should not consider beta newer than same stable', () => {
      expect(isNewerVersion('1.3.9-beta.4', '1.3.9')).toBe(false);
    });
  });

  describe('cross-version comparisons', () => {
    it('should detect higher version beta as newer than lower stable', () => {
      // User on 1.3.9 stable, 1.4.0-beta.1 released (but they are on stable channel)
      // This would only show if they explicitly opt into beta
      expect(isNewerVersion('1.4.0-beta.1', '1.3.9')).toBe(true);
    });

    it('should not show lower stable as update to higher beta', () => {
      // User on 1.4.0-beta.3, latest stable is 1.3.9
      // Should NOT show 1.3.9 as an update (they are already ahead)
      expect(isNewerVersion('1.3.9', '1.4.0-beta.3')).toBe(false);
    });

    it('should show same-line stable as update to beta', () => {
      // User on 1.4.0-beta.3, stable 1.4.0 released
      expect(isNewerVersion('1.4.0', '1.4.0-beta.3')).toBe(true);
    });
  });

  describe('real-world scenarios', () => {
    it('scenario: beta.1 user sees beta.2', () => {
      expect(isNewerVersion('v1.3.9-beta.2', 'v1.3.9-beta.1')).toBe(true);
    });

    it('scenario: beta.4 user sees stable 1.3.9', () => {
      expect(isNewerVersion('v1.3.9', 'v1.3.9-beta.4')).toBe(true);
    });

    it('scenario: 1.4.0-beta.3 user sees 1.4.0 stable', () => {
      expect(isNewerVersion('v1.4.0', 'v1.4.0-beta.3')).toBe(true);
    });

    it('scenario: 1.4.0-beta.3 user sees 1.4.0-beta.4', () => {
      expect(isNewerVersion('v1.4.0-beta.4', 'v1.4.0-beta.3')).toBe(true);
    });

    it('scenario: stable 1.3.9 user does not see 1.4.0-beta.1 (stable channel)', () => {
      // This is handled by the fetch logic, not version comparison
      // But if compared directly, beta IS newer
      expect(isNewerVersion('v1.4.0-beta.1', 'v1.3.9')).toBe(true);
    });
  });
});

// Helper to create mock GitHub releases
function mockRelease(tag: string, prerelease: boolean, draft = false): GitHubRelease {
  return {
    tag_name: tag,
    html_url: `https://github.com/test/releases/tag/${tag}`,
    published_at: '2024-01-01T00:00:00Z',
    name: tag,
    body: null,
    prerelease,
    draft,
  };
}

describe('findBestUpdateForPrerelease', () => {
  it('should return newest stable when user is on older prerelease (issue #166)', () => {
    // User on v1.4.1-beta.17, v1.4.3 stable is available
    // Should show v1.4.3, not v1.4.1
    const releases = [
      mockRelease('v1.4.3', false),
      mockRelease('v1.4.3-beta.2', true),
      mockRelease('v1.4.3-beta.1', true),
      mockRelease('v1.4.2', false),
      mockRelease('v1.4.1', false),
      mockRelease('v1.4.1-beta.18', true),
      mockRelease('v1.4.1-beta.17', true),
    ];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result?.tag_name).toBe('v1.4.3');
  });

  it('should return same-base stable when no newer stable exists', () => {
    // User on v1.4.1-beta.17, latest stable is v1.4.1
    const releases = [
      mockRelease('v1.4.1', false),
      mockRelease('v1.4.1-beta.18', true),
      mockRelease('v1.4.1-beta.17', true),
    ];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result?.tag_name).toBe('v1.4.1');
  });

  it('should return newer prerelease when no stable is newer', () => {
    // User on v1.4.1-beta.17, newer beta exists but no newer stable
    const releases = [
      mockRelease('v1.4.0', false), // older stable
      mockRelease('v1.4.1-beta.18', true),
      mockRelease('v1.4.1-beta.17', true),
    ];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result?.tag_name).toBe('v1.4.1-beta.18');
  });

  it('should offer the newest prerelease when a new beta line exists past the latest stable', () => {
    // User on v1.5.0-beta.7 with 2.0.0-beta.1 released: the newest release
    // wins, not the 1.5.0 stable that merely outranks the user's own tag
    const releases = [
      mockRelease('v2.0.0-beta.1', true),
      mockRelease('v1.5.0', false),
      mockRelease('v1.5.0-beta.7', true),
    ];

    const result = findBestUpdateForPrerelease('v1.5.0-beta.7', releases);
    expect(result?.tag_name).toBe('v2.0.0-beta.1');
  });

  it('should return null when already on latest', () => {
    const releases = [mockRelease('v1.4.1-beta.17', true), mockRelease('v1.4.0', false)];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result).toBeNull();
  });

  it('should skip draft releases', () => {
    const releases = [
      mockRelease('v1.5.0', false, true), // draft - should be skipped
      mockRelease('v1.4.2', false),
    ];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result?.tag_name).toBe('v1.4.2');
  });

  it('should handle unsorted release list', () => {
    // Releases not in order - function should sort them
    const releases = [
      mockRelease('v1.4.1', false),
      mockRelease('v1.4.3', false),
      mockRelease('v1.4.2', false),
    ];

    const result = findBestUpdateForPrerelease('v1.4.1-beta.17', releases);
    expect(result?.tag_name).toBe('v1.4.3');
  });
});

// ============================================================================
// fetchGitHubReleases — rate-limit error handling
// ============================================================================

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockRateLimitResponse(headers: Record<string, string> = {}, status = 429) {
  return {
    ok: false,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: vi.fn(),
  };
}

describe('fetchGitHubReleases', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('throws GitHubRateLimitError with seconds from retry-after header', async () => {
    // 1800s is within the [900, 21600] clamp so it passes through unchanged
    mockFetch.mockResolvedValue(mockRateLimitResponse({ 'retry-after': '1800' }, 429));
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).retryAfterSeconds).toBe(1800);
  });

  it('throws GitHubRateLimitError with seconds from x-ratelimit-reset when retry-after absent', async () => {
    // 30 min from now — above the 15min clamp floor
    const wait = 30 * 60;
    const resetEpoch = Math.floor(Date.now() / 1000) + wait;
    mockFetch.mockResolvedValue(
      mockRateLimitResponse({ 'x-ratelimit-reset': String(resetEpoch) }, 403)
    );
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    const secs = (err as GitHubRateLimitError).retryAfterSeconds;
    // Allow a few seconds of test execution drift
    expect(secs).toBeGreaterThanOrEqual(wait - 5);
    expect(secs).toBeLessThanOrEqual(wait + 5);
  });

  it('clamps retryAfterSeconds to minimum of 15 min when header is tiny', async () => {
    mockFetch.mockResolvedValue(mockRateLimitResponse({ 'retry-after': '5' }, 429));
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).retryAfterSeconds).toBe(15 * 60);
  });

  it('clamps retryAfterSeconds to maximum of 6 h when header is huge', async () => {
    mockFetch.mockResolvedValue(mockRateLimitResponse({ 'retry-after': '999999' }, 429));
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).retryAfterSeconds).toBe(6 * 60 * 60);
  });

  it('defaults to 1 h when no rate-limit headers are present', async () => {
    mockFetch.mockResolvedValue(mockRateLimitResponse({}, 403));
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    // 3600 is clamped within [900, 21600] so stays at 3600
    expect((err as GitHubRateLimitError).retryAfterSeconds).toBe(3600);
  });

  it('falls back to 1 h when retry-after is an HTTP-date instead of seconds', async () => {
    mockFetch.mockResolvedValue(
      mockRateLimitResponse({ 'retry-after': 'Thu, 01 Jan 2026 00:00:00 GMT' }, 429)
    );
    const err = await fetchGitHubReleases('https://api.github.com/test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).retryAfterSeconds).toBe(3600);
  });
});

// ============================================================================
// processVersionCheck — cooldown guard and rate-limit recovery
// ============================================================================

// Single shared redis mock — initVersionCheckQueue only accepts the first call per module
// instance, so we control behavior via mockResolvedValueOnce per test.
const sharedRedis = {
  exists: vi.fn(),
  set: vi.fn().mockResolvedValue('OK'),
  get: vi.fn().mockResolvedValue(null),
};

// Initialise once; subsequent calls are no-ops due to the guard in the module.
initVersionCheckQueue('redis://localhost', sharedRedis as never, vi.fn());

function makeJob(force?: boolean) {
  return { id: 'test-job', data: { type: 'check' as const, force } } as Parameters<
    typeof processVersionCheck
  >[0];
}

describe('processVersionCheck', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    sharedRedis.exists.mockReset();
    sharedRedis.set.mockReset().mockResolvedValue('OK');
    mockGetCurrentVersion.mockReturnValue('1.4.0');
  });

  it('skips GitHub fetch when cooldown key exists and force is false', async () => {
    sharedRedis.exists.mockResolvedValue(1); // cooldown active
    await processVersionCheck(makeJob(false));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does NOT skip when force is true even if cooldown key exists', async () => {
    sharedRedis.exists.mockResolvedValue(1); // cooldown active — but force overrides
    const latestRelease: GitHubRelease = {
      tag_name: 'v1.4.0',
      html_url: 'https://github.com/test/releases/tag/v1.4.0',
      published_at: '2024-01-01T00:00:00Z',
      name: 'v1.4.0',
      body: null,
      prerelease: false,
      draft: false,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(latestRelease),
    });
    await processVersionCheck(makeJob(true));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sets cooldown key on rate-limit and returns without throwing', async () => {
    sharedRedis.exists.mockResolvedValue(0); // no cooldown
    mockFetch.mockResolvedValue(mockRateLimitResponse({ 'retry-after': '1800' }, 429));
    // Must not throw
    await expect(processVersionCheck(makeJob(false))).resolves.toBeUndefined();
    // Cooldown key must be set with the rate-limit TTL
    expect(sharedRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('version:check:cooldown'),
      '1',
      'EX',
      1800
    );
  });

  it('sets cooldown key after a successful fetch', async () => {
    sharedRedis.exists.mockResolvedValue(0); // no cooldown
    const latestRelease: GitHubRelease = {
      tag_name: 'v1.5.0',
      html_url: 'https://github.com/test/releases/tag/v1.5.0',
      published_at: '2024-01-01T00:00:00Z',
      name: 'v1.5.0',
      body: null,
      prerelease: false,
      draft: false,
    };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(latestRelease),
    });
    await processVersionCheck(makeJob(false));
    expect(sharedRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('version:check:cooldown'),
      '1',
      'EX',
      15 * 60
    );
  });

  it('rethrows non-rate-limit errors and does not set a cooldown', async () => {
    sharedRedis.exists.mockResolvedValue(0); // no cooldown
    mockFetch.mockResolvedValue(mockRateLimitResponse({}, 500));
    await expect(processVersionCheck(makeJob(false))).rejects.toThrow();
    expect(sharedRedis.set).not.toHaveBeenCalled();
  });
});
