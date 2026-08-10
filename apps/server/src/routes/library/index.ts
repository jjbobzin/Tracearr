/**
 * Library Statistics Routes
 *
 * Sub-routes for library analytics endpoints (stats, growth, quality, storage, duplicates, stale)
 */

import type { FastifyPluginAsync } from 'fastify';
import { libraryStatsRoute } from './stats.js';
import { libraryGrowthRoute } from './growth.js';
import { libraryQualityRoute } from './quality.js';
import { libraryStorageRoute } from './storage.js';
import { libraryDuplicatesRoute } from './duplicates.js';
import { libraryStaleRoute } from './stale.js';
import { libraryWatchRoute } from './watch.js';
import { libraryRoiRoute } from './roi.js';
import { libraryPatternsRoute } from './patterns.js';
import { libraryCompletionRoute } from './completion.js';
import { libraryTopContentRoute } from './topContent.js';
import { libraryCodecsRoute } from './codecs.js';
import { libraryResolutionRoute } from './resolution.js';
import { libraryStatusRoute } from './status.js';
import { libraryCatalogRoute } from './catalog.js';
import { libraryShelvesRoute } from './shelves.js';
import { libraryGenresRoute } from './genres.js';
import { libraryMediaRoute } from './media.js';
import { libraryLibrariesRoute } from './libraries.js';

export const libraryStatsRoutes: FastifyPluginAsync = async (app) => {
  // Register all sub-route plugins
  // Each plugin defines its own paths (no additional prefix needed)
  await app.register(libraryCatalogRoute);
  await app.register(libraryShelvesRoute);
  await app.register(libraryGenresRoute);
  await app.register(libraryMediaRoute);
  await app.register(libraryLibrariesRoute);
  await app.register(libraryStatsRoute);
  await app.register(libraryGrowthRoute);
  await app.register(libraryQualityRoute);
  await app.register(libraryStorageRoute);
  await app.register(libraryDuplicatesRoute);
  await app.register(libraryStaleRoute);
  await app.register(libraryWatchRoute);
  await app.register(libraryRoiRoute);
  await app.register(libraryPatternsRoute);
  await app.register(libraryCompletionRoute);
  await app.register(libraryTopContentRoute);
  await app.register(libraryCodecsRoute);
  await app.register(libraryResolutionRoute);
  await app.register(libraryStatusRoute);
};

// Re-export utilities for potential use by other modules
export { buildLibraryCacheKey } from './utils.js';
