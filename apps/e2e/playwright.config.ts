import { defineConfig, devices } from '@playwright/test';
import path from 'path';

// Load root .env file (won't override existing env vars)
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../.env'));
} catch {
  // .env file is optional
}

const isCI = !!process.env.CI;

// Ensure CLAIM_CODE is available to both the test process and webServer
process.env.CLAIM_CODE ??= 'tracearr-e2e-test-claim-code';

// Isolated test-container database/redis, never the live dev stack on
// 5432/6379 - see apps/e2e/seed/env.ts and README.md "Media browse seed".
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://test:test@localhost:5433/tracearr_e2e';
const E2E_REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:6380';
const E2E_REDIS_PREFIX = process.env.E2E_REDIS_PREFIX ?? 'trr_e2e_';

export default defineConfig({
  testDir: './tests',
  globalSetup: './seed/globalSetup.ts',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  reporter: isCI ? [['html', { open: 'never' }], ['github']] : [['html', { open: 'on-failure' }]],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: isCI ? 'on-first-retry' : 'off',
  },

  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: path.resolve(import.meta.dirname, '.auth/user.json'),
      },
      dependencies: ['setup'],
      testIgnore: /media-browse\.spec\.ts/,
    },
    {
      // Links the real signed-in owner (created by the 'setup' project) to a
      // watched title - must run after login, so it can't be part of
      // globalSetup, which runs before any project. See README.md.
      name: 'media-seed',
      testMatch: /media-browse\.setup\.ts/,
      dependencies: ['setup'],
    },
    {
      name: 'media-browse',
      use: {
        ...devices['Desktop Chrome'],
        storageState: path.resolve(import.meta.dirname, '.auth/user.json'),
      },
      testMatch: /media-browse\.spec\.ts/,
      dependencies: ['setup', 'media-seed'],
    },
  ],

  webServer: [
    {
      // globalSetup.ts runs AFTER webServer, not before - Playwright starts
      // webServer as part of plugin setup, ahead of the globalSetups array.
      // The database has to exist and be migrated before this process even
      // starts, or its own boot-time migration runner crash-loops against a
      // database that isn't there yet. See README.md "Media browse seed".
      command: 'node seed/prepareDatabase.mjs && pnpm --filter @tracearr/server dev',
      cwd: path.resolve(import.meta.dirname),
      port: 3000,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: {
        DATABASE_URL: E2E_DATABASE_URL,
        REDIS_URL: E2E_REDIS_URL,
        REDIS_PREFIX: E2E_REDIS_PREFIX,
        JWT_SECRET: 'e2e-test-jwt-secret-must-be-32-chars',
        COOKIE_SECRET: 'e2e-test-cookie-secret-32-chars!',
        CORS_ORIGIN: 'http://localhost:5173',
        NODE_ENV: 'development',
        LOG_LEVEL: 'warn',
        PORT: '3000',
        CLAIM_CODE: process.env.CLAIM_CODE!,
      },
    },
    {
      command: 'pnpm --filter @tracearr/web dev',
      cwd: path.resolve(import.meta.dirname, '../..'),
      port: 5173,
      reuseExistingServer: !isCI,
      timeout: 30_000,
    },
  ],
});
