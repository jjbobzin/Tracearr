import { test, expect } from '@playwright/test';
import path from 'path';

test.use({ storageState: path.resolve(import.meta.dirname, '../.auth/user.json') });

test.describe('Page Navigation', () => {
  test('can navigate to history page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'History' }).click();
    await expect(page.getByRole('heading', { name: 'History', level: 1 })).toBeVisible();
  });

  test('can navigate to map page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Map' }).click();
    // Map page has no heading — verify the Leaflet map container rendered
    await expect(page.locator('.leaflet-container')).toBeVisible();
  });

  test('can navigate to users page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Users', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
  });

  test('can navigate to rules page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Rules' }).click();
    await expect(page.getByRole('heading', { name: 'Rules', level: 1 })).toBeVisible();
  });

  test('can navigate to violations page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Violations' }).click();
    await expect(page.getByRole('heading', { name: 'Violations', level: 1 })).toBeVisible();
  });

  test('can navigate to settings page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  });
});

test.describe('Stats Navigation', () => {
  test('can navigate to activity page', async ({ page }) => {
    await page.goto('/');
    const statsGroup = page.locator('li', { has: page.getByRole('button', { name: 'Stats' }) });
    await statsGroup.getByRole('button', { name: 'Stats' }).click();
    await statsGroup.getByRole('link', { name: 'Activity' }).click();
    await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  });

  test('can navigate to stats users page', async ({ page }) => {
    await page.goto('/');
    const statsGroup = page.locator('li', { has: page.getByRole('button', { name: 'Stats' }) });
    await statsGroup.getByRole('button', { name: 'Stats' }).click();
    await statsGroup.getByRole('link', { name: 'Users' }).click();
    // Stats > Users has no h1 — shows "Top 3" with data or "No activity yet" when empty
    await expect(
      page.getByRole('heading', { name: 'Top 3' }).or(page.getByText('No activity yet'))
    ).toBeVisible();
  });
});

test.describe('Media Navigation', () => {
  test('can navigate to the media overview page', async ({ page }) => {
    await page.goto('/');
    const mediaGroup = page.locator('li', { has: page.getByRole('button', { name: 'Media' }) });
    await mediaGroup.getByRole('button', { name: 'Media' }).click();
    await mediaGroup.getByRole('link', { name: 'Overview' }).click();
    await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
  });

  test('can navigate to the browse page', async ({ page }) => {
    await page.goto('/');
    const mediaGroup = page.locator('li', { has: page.getByRole('button', { name: 'Media' }) });
    await mediaGroup.getByRole('button', { name: 'Media' }).click();
    await mediaGroup.getByRole('link', { name: 'Browse' }).click();
    await expect(page).toHaveURL(/\/media\/browse$/);
  });

  test('can navigate to quality page', async ({ page }) => {
    await page.goto('/');
    const mediaGroup = page.locator('li', { has: page.getByRole('button', { name: 'Media' }) });
    await mediaGroup.getByRole('button', { name: 'Media' }).click();
    await mediaGroup.getByRole('link', { name: 'Quality' }).click();
    await expect(page.getByRole('heading', { name: 'Quality', level: 1 })).toBeVisible();
  });

  test('can navigate to storage page', async ({ page }) => {
    await page.goto('/');
    const mediaGroup = page.locator('li', { has: page.getByRole('button', { name: 'Media' }) });
    await mediaGroup.getByRole('button', { name: 'Media' }).click();
    await mediaGroup.getByRole('link', { name: 'Storage' }).click();
    await expect(page.getByRole('heading', { name: 'Storage', level: 1 })).toBeVisible();
  });

  test('can navigate to watch page', async ({ page }) => {
    await page.goto('/');
    const mediaGroup = page.locator('li', { has: page.getByRole('button', { name: 'Media' }) });
    await mediaGroup.getByRole('button', { name: 'Media' }).click();
    await mediaGroup.getByRole('link', { name: 'Watch' }).click();
    await expect(page.getByRole('heading', { name: 'Watch Analytics', level: 1 })).toBeVisible();
  });
});

test.describe('Performance Navigation', () => {
  test('can navigate to devices page', async ({ page }) => {
    await page.goto('/');
    const perfGroup = page.locator('li', {
      has: page.getByRole('button', { name: 'Performance' }),
    });
    await perfGroup.getByRole('button', { name: 'Performance' }).click();
    await perfGroup.getByRole('link', { name: 'Devices' }).click();
    await expect(
      page.getByRole('heading', { name: 'Device Compatibility', level: 1 })
    ).toBeVisible();
  });

  test('can navigate to bandwidth page', async ({ page }) => {
    await page.goto('/');
    const perfGroup = page.locator('li', {
      has: page.getByRole('button', { name: 'Performance' }),
    });
    await perfGroup.getByRole('button', { name: 'Performance' }).click();
    await perfGroup.getByRole('link', { name: 'Bandwidth' }).click();
    await expect(page.getByRole('heading', { name: 'Bandwidth', level: 1 })).toBeVisible();
  });
});
