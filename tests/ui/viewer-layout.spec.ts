import { test, expect } from '@playwright/test';

/**
 * Layout tests for the two-panel viewer redesign.
 *
 * These tests verify the session-centric layout with left panel
 * (SessionList + ActivityBar) and right panel (SessionDetail).
 *
 * The viewer is served by the running Express worker at http://localhost:37777.
 */

const SCREENSHOT_DIR = 'tests/ui/__screenshots__';

/** Wait until the SSE connection is established and initial data has rendered. */
async function waitForViewerReady(page: import('@playwright/test').Page): Promise<void> {
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
  await page.waitForTimeout(300);
}

test.describe('Two-panel layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('renders two-panel layout in normal mode', async ({ page }) => {
    const twoPanel = page.locator('[data-testid="two-panel"]');
    await expect(twoPanel).toBeVisible();

    const leftPanel = page.locator('[data-testid="two-panel-left"]');
    const rightPanel = page.locator('[data-testid="two-panel-right"]');
    await expect(leftPanel).toBeVisible();
    await expect(rightPanel).toBeVisible();
  });

  test('left panel has correct width (260px)', async ({ page }) => {
    const leftPanel = page.locator('[data-testid="two-panel-left"]');
    const box = await leftPanel.boundingBox();
    expect(box).not.toBeNull();
    // Allow ±2px tolerance for sub-pixel rounding
    expect(box!.width).toBeGreaterThanOrEqual(258);
    expect(box!.width).toBeLessThanOrEqual(262);
  });

  test('session list shows sessions grouped by day', async ({ page }) => {
    const sessionList = page.locator('[data-testid="session-list"]');
    await expect(sessionList).toBeVisible();

    // Check for day group headers
    const groups = page.locator('[data-testid="session-group"]');
    // There should be at least one group if data exists
    const groupCount = await groups.count();
    // If no sessions exist, the empty state should be shown
    if (groupCount === 0) {
      await expect(sessionList.locator('.session-list__empty')).toBeVisible();
    } else {
      expect(groupCount).toBeGreaterThan(0);
    }
  });

  test('clicking a session shows its detail in right panel', async ({ page }) => {
    const sessionRows = page.locator('[data-testid="session-row"]');
    const rowCount = await sessionRows.count();

    if (rowCount >= 2) {
      // Click the second session (first might already be selected)
      await sessionRows.nth(1).click();

      // The clicked session should now be selected (aria-selected)
      const selected = page.locator('[data-testid="session-row"][aria-selected="true"]');
      await expect(selected).toBeVisible();

      // The right panel should show content (not the empty state)
      const detail = page.locator('[data-testid="session-detail"]');
      await expect(detail).toBeVisible();
    }
  });

  test('most recent session is selected by default', async ({ page }) => {
    const sessionRows = page.locator('[data-testid="session-row"]');
    const rowCount = await sessionRows.count();

    if (rowCount > 0) {
      // The first session row should be selected by default (aria-selected)
      const selected = page.locator('[data-testid="session-row"][aria-selected="true"]');
      await expect(selected).toBeVisible();

      // It should be the first item in the first group
      const firstGroup = page.locator('[data-testid="session-group"]').first();
      const firstSelectedInGroup = firstGroup.locator('[data-testid="session-row"][aria-selected="true"]');
      await expect(firstSelectedInGroup).toBeVisible();
    }
  });

  test('activity bar is in left panel', async ({ page }) => {
    const activityInLeftPanel = page.locator('[data-testid="two-panel-activity"]');
    await expect(activityInLeftPanel).toBeVisible();

    // Activity bar should be inside the left panel
    const leftPanel = page.locator('[data-testid="two-panel-left"]');
    await expect(leftPanel.locator('[data-testid="two-panel-activity"]')).toBeVisible();
  });
});

test.describe('Two-panel responsive behavior', () => {
  test('collapses to stacked layout below 768px', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto('/');
    await waitForViewerReady(page);

    const twoPanel = page.locator('[data-testid="two-panel"]');
    await expect(twoPanel).toBeVisible();

    // In mobile layout, left panel should have constrained height
    const leftPanel = page.locator('[data-testid="two-panel-left"]');
    const box = await leftPanel.boundingBox();
    expect(box).not.toBeNull();
    // Left panel should be full width in mobile, not 260px
    expect(box!.width).toBeGreaterThan(262);
  });
});

test.describe('Search/filter mode uses feed', () => {
  test('entering a search query switches to feed layout', async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);

    // Type in the search bar to enter filter mode
    const searchInput = page.locator('input[type="search"], input[placeholder*="earch"]');
    if (await searchInput.isVisible()) {
      await searchInput.fill('test query');
      // Wait a moment for the mode transition
      await page.waitForTimeout(500);

      // In filter mode, the feed should be visible (not the two-panel)
      const feed = page.locator('.feed');
      const twoPanel = page.locator('[data-testid="two-panel"]');

      // Either feed is visible or two-panel is hidden
      const feedVisible = await feed.isVisible();
      const twoPanelVisible = await twoPanel.isVisible();

      // At least one should hold true: feed visible or two-panel hidden
      expect(feedVisible || !twoPanelVisible).toBe(true);
    }
  });
});

test.describe('Two-panel — screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('two-panel — light theme', async ({ page }) => {
    await setTheme(page, 'light');
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/two-panel-light.png`,
      fullPage: true,
    });
  });

  test('two-panel — dark theme', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/two-panel-dark.png`,
      fullPage: true,
    });
  });

  test('session list panel — light', async ({ page }) => {
    await setTheme(page, 'light');
    const leftPanel = page.locator('[data-testid="two-panel-left"]');
    await leftPanel.screenshot({
      path: `${SCREENSHOT_DIR}/session-list-light.png`,
    });
  });

  test('session detail panel — light', async ({ page }) => {
    await setTheme(page, 'light');
    const rightPanel = page.locator('[data-testid="two-panel-right"]');
    await rightPanel.screenshot({
      path: `${SCREENSHOT_DIR}/session-detail-light.png`,
    });
  });
});
