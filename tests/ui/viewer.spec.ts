import { test, expect } from '@playwright/test';

/**
 * Baseline screenshot tests for the magic-claude-mem viewer UI.
 *
 * These tests capture reference screenshots for light and dark themes
 * so that future visual regression tests can detect unintended changes.
 *
 * The viewer is served by the running Express worker at http://localhost:37777.
 * The `data-theme` attribute on <html> controls the active theme.
 */

const SCREENSHOT_DIR = 'tests/ui/__screenshots__';

/** Wait until the SSE connection is established and initial data has rendered. */
async function waitForViewerReady(page: import('@playwright/test').Page): Promise<void> {
  // The header element is always present once React has mounted
  await page.waitForSelector('.header', { state: 'visible', timeout: 15000 });

  // In normal mode, the two-panel layout renders; in filter mode, the feed renders
  await page.waitForSelector('[data-testid="two-panel"], .feed', { state: 'visible', timeout: 15000 });
}

/** Force the viewer into the given theme by directly setting `data-theme` on <html>. */
async function setTheme(
  page: import('@playwright/test').Page,
  theme: 'light' | 'dark',
): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
  }, theme);

  // Wait for the theme attribute to be applied and CSS to settle
  await page.waitForFunction(
    (t) => document.documentElement.getAttribute('data-theme') === t,
    theme,
  );
}

test.describe('Viewer UI — baseline screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('full page — light theme', async ({ page }) => {
    await setTheme(page, 'light');

    // Verify the data-theme attribute is set correctly
    const theme = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme'),
    );
    expect(theme).toBe('light');

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/full-page-light.png`,
      fullPage: true,
    });

    // Confirm the screenshot was taken without error by asserting the page title
    await expect(page).toHaveTitle(/magic-claude-mem/i);
  });

  test('full page — dark theme', async ({ page }) => {
    await setTheme(page, 'dark');

    const theme = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme'),
    );
    expect(theme).toBe('dark');

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/full-page-dark.png`,
      fullPage: true,
    });

    await expect(page).toHaveTitle(/magic-claude-mem/i);
  });

  test('header region — light theme', async ({ page }) => {
    await setTheme(page, 'light');

    const header = page.locator('.header');
    await expect(header).toBeVisible();

    await header.screenshot({
      path: `${SCREENSHOT_DIR}/header-light.png`,
    });

    // The header must contain the logo text
    await expect(header.locator('.logo-text')).toContainText('magic-claude-mem');
  });

  test('header region — dark theme', async ({ page }) => {
    await setTheme(page, 'dark');

    const header = page.locator('.header');
    await expect(header).toBeVisible();

    await header.screenshot({
      path: `${SCREENSHOT_DIR}/header-dark.png`,
    });

    await expect(header.locator('.logo-text')).toContainText('magic-claude-mem');
  });

  test('content area — light theme', async ({ page }) => {
    await setTheme(page, 'light');

    // In normal mode, the two-panel layout renders; in filter mode, the feed renders
    const contentArea = page.locator('[data-testid="two-panel"], .feed');
    await expect(contentArea.first()).toBeVisible();

    await contentArea.first().screenshot({
      path: `${SCREENSHOT_DIR}/content-area-light.png`,
    });
  });

  test('content area — dark theme', async ({ page }) => {
    await setTheme(page, 'dark');

    const contentArea = page.locator('[data-testid="two-panel"], .feed');
    await expect(contentArea.first()).toBeVisible();

    await contentArea.first().screenshot({
      path: `${SCREENSHOT_DIR}/content-area-dark.png`,
    });
  });
});
