# E2E Tests

End-to-end browser tests for Tracearr using [Playwright](https://playwright.dev/). These tests exercise real user flows against the full stack (API server + web app) in a Chromium browser.

## Prerequisites

### Services

The E2E tests require a running TimescaleDB (PostgreSQL) and Redis instance. They run against the **isolated test containers** (never the live dev stack):

```bash
docker compose -f docker/docker-compose.test.yml up -d
```

This starts TimescaleDB on port 5433 and Redis on port 6380. If your services run on different ports, override them with `E2E_DATABASE_URL` and `E2E_REDIS_URL` (see [Configuration](#configuration)) - but the target database name must always be `tracearr_e2e`; the seed refuses to run against anything else (see [Media browse seed](#media-browse-seed)).

### Browser

Install Playwright's browser binaries (one-time setup):

```bash
pnpm --filter @tracearr/e2e exec playwright install chromium
```

### Servers

The test runner automatically starts the API server (port 3000) and web dev server (port 5173) via the `webServer` config in `playwright.config.ts`. You can also start them manually and they'll be reused.

## Running Tests

```bash
# Run all tests headless
pnpm --filter @tracearr/e2e test:e2e

# Open the interactive UI mode (pick & run tests visually)
pnpm --filter @tracearr/e2e test:e2e:ui

# Run tests in a visible browser window
pnpm --filter @tracearr/e2e test:e2e:headed

# Run tests in debug mode (step through with inspector)
pnpm --filter @tracearr/e2e test:e2e:debug

# Open the HTML report from the last run
pnpm --filter @tracearr/e2e test:e2e:report

# Just the media-browse suite (setup + seed-link + spec projects)
pnpm --filter @tracearr/e2e test:e2e:media
```

## Configuration

Environment variables are loaded from the root `.env` file. The following can be overridden:

| Variable           | Default                                              | Description                                       |
| ------------------ | ---------------------------------------------------- | ------------------------------------------------- |
| `E2E_DATABASE_URL` | `postgresql://test:test@localhost:5433/tracearr_e2e` | Database connection - name must be `tracearr_e2e` |
| `E2E_REDIS_URL`    | `redis://localhost:6380`                             | Redis connection                                  |
| `E2E_REDIS_PREFIX` | `trr_e2e_`                                           | Redis key prefix, isolates this run's keys        |
| `CLAIM_CODE`       | `tracearr-e2e-test-claim-code`                       | Claim code for first-time setup gate              |

## Test Structure

| File                    | What it tests                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `auth.setup.ts`         | Authentication setup project: handles first-time signup or login, saves auth state for other tests |
| `media-browse.setup.ts` | Phase 2 of the media browse seed: links the just-created owner to a watched title (see below)      |
| `auth.spec.ts`          | Login page, unauthenticated redirects, credential login                                            |
| `dashboard.spec.ts`     | Dashboard stat cards, sidebar navigation links                                                     |
| `media-browse.spec.ts`  | Media landing shelves/KPIs, grid pagination, letter rail, filters, detail, watched markers         |
| `navigation.spec.ts`    | Page navigation for all routes including collapsible sub-categories                                |
| `rules.spec.ts`         | Create and delete classic (template) and custom rules                                              |
| `settings.spec.ts`      | Settings page tabs and section content                                                             |

## Media browse seed

`media-browse.spec.ts` needs data no other spec provisions (two media servers, ~90 movies/shows,
watch history) and it must never touch a real library. The seed is fail-closed by design:

1. **Guard.** `seed/guard.ts` runs `SELECT current_database()` before any write and throws unless the
   name is exactly `tracearr_e2e`. Every seed script (`prepareDatabase.mjs`, `globalSetup.ts`,
   `media-browse.setup.ts`) calls this (or an equivalent literal check) before touching a row.
2. **Database + migrations, before the server even boots.** Playwright starts the `webServer`
   processes ahead of `globalSetup.ts` (not after - webServer is plugin setup, which precedes the
   `globalSetups` array), so `seed/prepareDatabase.mjs` is chained into the server's own `webServer`
   command: it creates `tracearr_e2e` on the test container if missing and applies the server's own
   migrations (`db:migrate`) before `pnpm --filter @tracearr/server dev` ever starts - otherwise the
   app's boot-time migration runner would crash-loop against a database that doesn't exist yet on a
   fresh checkout.
3. **Bulk fixture data.** `seed/globalSetup.ts` is Playwright's `globalSetup` hook - it runs once,
   after the webServer is already up, and seeds two media servers, ~90 movies/shows, and watch
   history (idempotent - safe to rerun). It also re-runs the ensure/migrate steps defensively in case
   a stale server process was reused instead (`reuseExistingServer`).
4. **Admin link.** One scenario (a title marked "watched by you") needs the real signed-in owner's id,
   which only exists after `auth.setup.ts` signs up/logs in. `media-browse.setup.ts` runs as its own
   Playwright project (`media-seed`, depends on `setup`) to link that account and refresh the watch
   aggregate.

First-time local setup (idempotent - safe to run again, and `globalSetup.ts` also does this check
itself on every run):

```bash
docker exec docker-timescale-test-1 psql -U test -d postgres -c 'CREATE DATABASE tracearr_e2e'
```

Then just run `pnpm --filter @tracearr/e2e test:e2e:media` - migrations and seeding happen
automatically.

## Auth State

The setup project (`auth.setup.ts`) runs first and saves browser storage state to `.auth/user.json`. All other test files reuse this state so they start already logged in. The `.auth/` directory is gitignored.
