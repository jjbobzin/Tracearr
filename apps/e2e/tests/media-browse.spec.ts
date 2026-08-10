/**
 * Media browsing e2e coverage (landing shelves, movie/show grids, letter
 * rail, filters, detail, watched markers).
 *
 * Runs against the isolated tracearr_e2e database on the 5433 test
 * container, never the live dev stack - see apps/e2e/seed/guard.ts (hard
 * assert on the database name) and apps/e2e/README.md. Fixture data is
 * seeded in two phases: apps/e2e/seed/globalSetup.ts (bulk data, before any
 * project runs) and tests/media-browse.setup.ts (the one row that needs the
 * real signed-in owner's id, which only exists after auth.setup.ts logs in).
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import path from 'path';
import { FIXTURE } from '../seed/fixtures';

test.use({ storageState: path.resolve(import.meta.dirname, '../.auth/user.json') });

// 80 filler titles + 7 named titles that appear in the grid (the
// removed-everywhere title never does - see seed/seedCore.ts).
const MOVIES_TOTAL = 87;

function moviesGridRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Movies' });
}

async function scrollGridToBottom(page: Page, region: Locator) {
  await region.hover();
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, 2000);
  }
}

async function scrollGridToTop(page: Page, region: Locator) {
  await region.hover();
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, -2000);
  }
}

function gridScrollTop(region: Locator): Promise<number> {
  return region.locator('.overflow-y-auto').evaluate((el) => el.scrollTop);
}

test.describe('Media overview', () => {
  test('renders the library stats and the shelves below them', async ({ page }) => {
    await page.goto('/media');

    await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
    await expect(page.getByText('Total Items')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recently Added Movies' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recently Added Shows' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Most Popular Movies' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Most Popular Shows' })).toBeVisible();
  });
});

test.describe('Old media URLs redirect to Browse', () => {
  test('/media/movies lands on Browse with the movies grid active', async ({ page }) => {
    await page.goto('/media/movies');

    await expect(page).toHaveURL(/\/media\/browse$/);
    await expect(moviesGridRegion(page).getByRole('link').first()).toBeVisible();
  });

  test('/media/shows lands on Browse with the shows grid active', async ({ page }) => {
    await page.goto('/media/shows');

    await expect(page).toHaveURL(/\/media\/browse\?type=shows$/);
    await expect(
      page.getByRole('region', { name: 'Shows' }).getByRole('link').first()
    ).toBeVisible();
  });
});

test.describe('Movies grid pagination', () => {
  test('a real scroll loads a later page, and scrolling up after a deep letter jump works', async ({
    page,
  }) => {
    await page.goto('/media/browse');
    const region = moviesGridRegion(page);
    await expect(region.getByRole('link').first()).toBeVisible();

    // A genuine scroll (not a programmatic jump) reaches the title that
    // sorts last across the whole seeded catalog - only a second catalog
    // page can supply it.
    await scrollGridToBottom(page, region);
    await expect(region.getByRole('link', { name: /Zulu Sentinel Marker/ })).toBeInViewport();

    // Jump deep via the letter rail, then scroll UP with the mouse - the
    // regression class recent commits fixed (loading earlier pages on a
    // real scroll near the top, not just re-firing the jump).
    await page.getByRole('option', { name: 'J', exact: true }).click();
    await expect(region.getByRole('link', { name: /Juliet Filler 01/ })).toBeInViewport();
    await scrollGridToTop(page, region);
    await expect(region.getByRole('link', { name: /12 Monkeys/ })).toBeInViewport();
  });
});

test.describe('Letter rail', () => {
  test('a single click lands the jumped-to letter as the top row, and the rail tracks the landed row', async ({
    page,
  }) => {
    await page.goto('/media/browse');
    const region = moviesGridRegion(page);
    await expect(region.getByRole('link').first()).toBeVisible();

    // "The Matrix" sorts under M once the leading article is stripped. The
    // grid is one continuous alphabetical wall, so the jump lands the ROW
    // holding the first M title at the top - M itself sits mid-row whenever
    // the preceding census doesn't divide by the column count, and rows
    // above the viewport stay mounted, so neither DOM order nor "Matrix is
    // the first card" can be asserted here. Geometry can.
    await page.getByRole('option', { name: 'M', exact: true }).click();
    const matrix = region.getByRole('link', { name: /The Matrix/ });
    await expect(matrix).toBeInViewport();
    const gridScroll = region.locator('.overflow-y-auto');
    await expect
      .poll(async () => {
        const container = await gridScroll.boundingBox();
        const card = await matrix.boundingBox();
        if (!container || !card) return 'no-box';
        const delta = card.y - container.y;
        return delta > -card.height / 2 && delta < card.height
          ? 'top-row'
          : `off-by-${Math.round(delta)}px`;
      })
      .toBe('top-row');

    // WHICH letter the rail credits a landed row to is a stateless tiebreak
    // pinned by the activeLetterForRow unit tests (a row can hold the tail
    // of one letter and the start of two more, and the top item can settle
    // a pixel into the row above) - re-pinning a specific letter here would
    // couple this test to census, column count, and settle timing at once.
    // The rail just has to settle on exactly one current letter.
    await expect(page.locator('[role="option"][aria-current="true"]')).toHaveCount(1);

    // "12 Monkeys" sorts under # (digits collate before letters) at the very
    // top of the whole catalog - nothing can stay mounted above item zero,
    // so plain DOM order is safe for this jump.
    await page.getByRole('option', { name: '#', exact: true }).click();
    await expect(region.getByRole('link', { name: /12 Monkeys/ })).toBeInViewport();
    await expect(region.getByRole('link').first()).toHaveAccessibleName(/12 Monkeys/);
    await expect(page.locator('[role="option"][aria-current="true"]')).toHaveCount(1);

    // No seeded title starts with X.
    await expect(page.getByRole('option', { name: 'X', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
  });

  test('a wheel scroll right after a deep jump moves the viewport immediately, with no snap-back to the jumped position', async ({
    page,
  }) => {
    await page.goto('/media/browse');
    const region = moviesGridRegion(page);
    await expect(region.getByRole('link').first()).toBeVisible();

    await page.getByRole('option', { name: 'J', exact: true }).click();
    await expect(region.getByRole('link', { name: /Juliet Filler 01/ })).toBeInViewport();
    const landedScrollTop = await gridScrollTop(region);

    await region.hover();
    await page.mouse.wheel(0, -600);

    // The wheel moved the viewport up right away - never held at the landed position.
    await expect.poll(() => gridScrollTop(region)).toBeLessThan(landedScrollTop);
    const afterWheelScrollTop = await gridScrollTop(region);

    // The old bug: a delayed re-measure would snap scrollTop back up toward
    // where the jump landed a moment later. It must stay put (or keep moving
    // with further input), never climb back toward landedScrollTop on its own.
    await page.waitForTimeout(300);
    expect(await gridScrollTop(region)).toBeLessThanOrEqual(afterWheelScrollTop);
  });
});

test.describe('Movies grid filters', () => {
  test('resolution filter narrows the grid, search narrows further, clearing restores', async ({
    page,
  }) => {
    await page.goto('/media/browse');
    const region = moviesGridRegion(page);
    await expect(region.getByRole('link').first()).toBeVisible();
    await expect(page.getByText(`${MOVIES_TOTAL} titles`)).toBeVisible();

    // "1080p"/"720p" are the only resolution options whose casing actually
    // matches what library sync stores today ("4K"/"SD" don't case-match
    // the lowercase stored values) - see seed/fixtures.ts.
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('combobox', { name: 'Resolution', exact: true }).click();
    await page.getByRole('option', { name: '1080p', exact: true }).click();
    await page.keyboard.press('Escape');

    await expect(page.getByText('2 titles')).toBeVisible();
    await expect(region.getByRole('link', { name: /Duplicate Signal/ })).toBeVisible();

    await page.getByRole('button', { name: 'Remove 1080p filter' }).click();
    await expect(page.getByText(`${MOVIES_TOTAL} titles`)).toBeVisible();

    await page.getByRole('textbox', { name: 'Search titles' }).fill('Zulu Sentinel');
    await expect(page.getByText(/\b1 title\b/)).toBeVisible();
    await expect(region.getByRole('link', { name: /Zulu Sentinel Marker/ })).toBeVisible();

    await page.getByRole('textbox', { name: 'Search titles' }).fill('');
    await expect(page.getByText(`${MOVIES_TOTAL} titles`)).toBeVisible();
  });

  test('library filter narrows the grid to that library', async ({ page }) => {
    // The filters popover lists nine fields; the default 720px-tall viewport
    // clips the Library field near the bottom, so it never scrolls into view.
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto('/media/browse');
    const region = moviesGridRegion(page);
    await expect(region.getByRole('link').first()).toBeVisible();
    await expect(page.getByText(`${MOVIES_TOTAL} titles`)).toBeVisible();

    // Only the 80 filler movies live in the "Feature Films" library - the
    // 7 named fixture titles stay on an unmapped library id (see
    // seed/seedCore.ts) so they drop out of this filtered view entirely.
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('combobox', { name: 'Library', exact: true }).click();
    await page.getByRole('option', { name: 'Feature Films', exact: true }).click();
    await page.keyboard.press('Escape');

    await expect(page.getByText('80 titles')).toBeVisible();
    await expect(region.getByRole('link', { name: /Alpha Filler 01/ })).toBeVisible();
    await expect(region.getByRole('link', { name: /The Matrix/ })).toHaveCount(0);
  });

  test('HDR-only filter narrows the grid to the HDR-tagged titles', async ({ page }) => {
    await page.goto('/media/browse');
    const region = moviesGridRegion(page);
    await expect(region.getByRole('link').first()).toBeVisible();
    await expect(page.getByText(`${MOVIES_TOTAL} titles`)).toBeVisible();

    // "The Matrix" (dolby vision) and "12 Monkeys" (hdr10) are the only two
    // HDR-tagged copies in the seed - everything else is NULL or 'sdr'.
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('combobox', { name: 'Dynamic range', exact: true }).click();
    await page.getByRole('option', { name: 'HDR only', exact: true }).click();
    await page.keyboard.press('Escape');

    await expect(page.getByText('2 titles')).toBeVisible();
    await expect(region.getByRole('link', { name: /The Matrix/ })).toBeVisible();
    await expect(region.getByRole('link', { name: /12 Monkeys/ })).toBeVisible();
  });

  test('minimum size filter narrows the grid to the oversized title', async ({ page }) => {
    // Min size (GB) is the last field in the filters popover - same overflow
    // as the library filter test above.
    await page.setViewportSize({ width: 1280, height: 1400 });
    await page.goto('/media/browse');
    const region = moviesGridRegion(page);
    await expect(region.getByRole('link').first()).toBeVisible();
    await expect(page.getByText(`${MOVIES_TOTAL} titles`)).toBeVisible();

    // "Hotel Filler 01" is seeded at 40GB; every other title is 2GB or
    // has no file size at all, so a 30GB floor leaves it alone.
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('spinbutton', { name: 'Min size (GB)' }).fill('30');
    await page.keyboard.press('Escape');

    await expect(page.getByText(/\b1 title\b/)).toBeVisible();
    await expect(region.getByRole('link', { name: /Hotel Filler 01/ })).toBeVisible();
  });
});

test.describe('Shows grid', () => {
  test('renders show cards', async ({ page }) => {
    await page.goto('/media/browse?type=shows');
    const region = page.getByRole('region', { name: 'Shows' });
    await expect(region.getByRole('link').first()).toBeVisible();
  });
});

test.describe('Media detail', () => {
  test('per-copy table lists both copies with quality, falls back for a missing library name', async ({
    page,
  }) => {
    await page.goto(`/media/${FIXTURE.twoCopyTitle.id}`);
    await expect(
      page.getByRole('heading', { name: FIXTURE.twoCopyTitle.title, level: 1 })
    ).toBeVisible();

    const table = page.getByRole('table', { name: 'Copies' });
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table.getByText('4k')).toBeVisible();
    await expect(table.getByText('1080p')).toBeVisible();
    // Seed data never populates a `libraries` row, so the library column
    // always falls back to the "unknown" label for both copies.
    await expect(table.getByText('Unknown library')).toHaveCount(2);
  });

  test('a title on both servers shows one copy row per server', async ({ page }) => {
    await page.goto(`/media/${FIXTURE.crossServerTitle.id}`);
    const table = page.getByRole('table', { name: 'Copies' });
    await expect(table.locator('tbody tr')).toHaveCount(2);
    await expect(table.getByText('E2E Plex')).toBeVisible();
    await expect(table.getByText('E2E Jellyfin')).toBeVisible();
  });

  test('removed-everywhere title shows the unavailable state', async ({ page }) => {
    await page.goto(`/media/${FIXTURE.removedEverywhereTitle.id}`);
    await expect(
      page.getByRole('heading', { name: FIXTURE.removedEverywhereTitle.title, level: 1 })
    ).toBeVisible();
    await expect(
      page.getByText('No longer available on any connected server').first()
    ).toBeVisible();
  });
});

test.describe('Watched markers', () => {
  test('watched-by-you and watched-by-others are distinguishable accessible names', async ({
    page,
  }) => {
    await page.goto('/media/browse');
    const region = moviesGridRegion(page);
    // Let the route's own mount-time filter reset settle before typing -
    // otherwise it can race the fill and clear it right back out.
    await expect(region.getByRole('link').first()).toBeVisible();
    await page.getByRole('textbox', { name: 'Search titles' }).fill('Watched By');

    await expect(
      region.getByRole('link', { name: /Watched By Admin.*Watched by you/ })
    ).toBeVisible();
    await expect(
      region.getByRole('link', { name: /Watched By Someone.*Watched by others/ })
    ).toBeVisible();
  });
});
