/**
 * Integration Test Configuration
 *
 * Run with: pnpm test:integration
 *
 * Integration tests:
 * - Located in: test/integration/*.integration.test.ts
 * - Use a REAL database (TimescaleDB/PostgreSQL) for testing
 * - Database is automatically set up, migrated, and cleaned between tests
 * - Longer timeouts for database operations
 * - Run separately from unit tests to keep CI fast
 *
 * Prerequisites:
 * - Docker running with test database container
 * - TEST_DATABASE_URL environment variable (or uses default)
 */

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

export default defineConfig({
  test: {
    name: 'integration',
    globals: true,
    environment: 'node',
    include: [
      'test/integration/**/*.integration.test.ts',
      'src/db/__tests__/*.integration.test.ts',
      'scripts/__tests__/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./src/test/setup.integration.ts'],
    globalSetup: ['./src/test/globalSetup.integration.ts'],
    testTimeout: 30000, // Longer timeout for database operations
    hookTimeout: 30000,
    clearMocks: true,
    restoreMocks: true,
    // Each worker runs against its own template-copied database and redis
    // DB index (see globalSetup.integration.ts / setup.integration.ts),
    // so test files can run across multiple worker processes.
    pool: 'forks',
    maxWorkers: 7,
    reporters: isCI ? ['default', 'github-actions'] : ['default'],
    // Coverage for integration tests
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary'],
      reportsDirectory: './coverage/integration',
      include: ['src/services/**/*.ts', 'src/routes/**/*.ts', 'src/jobs/**/*.ts'],
      exclude: ['**/*.test.ts', '**/test/**', 'src/services/mediaServer/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@tracearr/shared': resolve(__dirname, '../../packages/shared/src'),
      // Use built files for test-utils to handle .js extension imports properly
      '@tracearr/test-utils': resolve(__dirname, '../../packages/test-utils/dist'),
    },
  },
});
