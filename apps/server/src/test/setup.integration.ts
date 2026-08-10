/**
 * Vitest Integration Test Setup
 *
 * This setup file is used for integration tests that require a real database.
 * Migrations and TimescaleDB init run once per suite in globalSetup.integration.ts;
 * this file handles the per-file database connection, matchers, console
 * silencing, and per-test cleanup/reset.
 *
 * Usage: vitest.integration.config.ts references this file.
 *
 * Requirements:
 * - Test database running: docker compose -f docker/docker-compose.test.yml up -d
 */

import { beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { installMatchers } from '@tracearr/test-utils/matchers';
import { resetAllFactoryCounters } from '@tracearr/test-utils/factories';
import { resetAllMocks } from '@tracearr/test-utils/mocks';
import { setupIntegrationTests, resetDatabaseBeforeEach } from '@tracearr/test-utils/vitest.setup';

// Set test environment variables BEFORE any database imports
const rawPoolId = Number(process.env.VITEST_POOL_ID);
if (!Number.isInteger(rawPoolId) || rawPoolId < 1) {
  throw new Error(
    'VITEST_POOL_ID is not set to a positive integer; per-worker database/redis isolation requires it'
  );
}
const poolId = rawPoolId;
const runToken = process.env.TRACEARR_TEST_RUN_TOKEN;
if (!runToken) {
  throw new Error(
    'TRACEARR_TEST_RUN_TOKEN is not set; globalSetup.integration.ts must run before this file'
  );
}

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-must-be-32-chars-min';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32-chars!!!';
// Use port 5433 for test database (docker-compose.test.yml) to avoid conflicts with dev.
// Each worker gets its own run-scoped, template-copied database.
process.env.DATABASE_URL = `postgresql://test:test@localhost:5433/tracearr_test_r${runToken}_w${poolId}`;
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
// Use port 6380 for test Redis to avoid conflicts with dev; each worker owns a DB index.
process.env.REDIS_URL = `redis://localhost:6380/${poolId}`;
process.env.DATABASE_POOL_MAX = '5';
process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret-32-chars!!';

// Install custom vitest matchers from test-utils
installMatchers();

// Silence console.log in tests unless DEBUG=true
if (!process.env.DEBUG) {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  vi.spyOn(console, 'info').mockImplementation(() => {});
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

// Database cleanup function
let cleanup: (() => Promise<void>) | null = null;

beforeAll(async () => {
  process.env.TEST_INITIALIZED = 'true';

  // Set up database connection (migrations + TimescaleDB init run once in globalSetup)
  cleanup = await setupIntegrationTests();
}, 60000); // 60s timeout for database connection setup

// Reset database and factories before each test for isolation
beforeEach(async () => {
  resetAllFactoryCounters();
  resetAllMocks();

  // Reset database to clean state
  await resetDatabaseBeforeEach();
});

afterAll(async () => {
  delete process.env.TEST_INITIALIZED;

  // Close database connection pool
  if (cleanup) {
    await cleanup();
  }
});
