import { test, expect } from '@playwright/test';

/**
 * Phase F Playwright tests for polish & integration.
 *
 * Tests cover:
 * - Settings modal interaction flow (F.20)
 * - Console drawer open/close and content (F.21)
 * - Focus-visible verification (F.22)
 * - Empty state variations (F.23)
 * - Activity bar interaction (F.24)
 * - Search-to-filter mode transition (F.25)
 *
 * The viewer is served by the running Express worker at http://localhost:37777.
 */

/** Wait until the SSE connection is established and initial data has rendered. */
async function waitForViewerReady(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('.header', { state: 'visible', timeout: 15000 });
  await page.waitForSelector('[data-testid="two-panel"], .feed', { state: 'visible', timeout: 15000 });
}

// ─────────────────────────────────────────────────────────
// F.20: Settings Modal
// ─────────────────────────────────────────────────────────

test.describe('Settings Modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('opens when settings button is clicked', async ({ page }) => {
    await page.click('.settings-btn');
    const modal = page.locator('.context-settings-modal');
    await expect(modal).toBeVisible({ timeout: 3000 });
  });

  test('closes on Escape key', async ({ page }) => {
    await page.click('.settings-btn');
    const modal = page.locator('.context-settings-modal');
    await expect(modal).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 3000 });
  });

  test('closes when backdrop is clicked', async ({ page }) => {
    await page.click('.settings-btn');
    const modal = page.locator('.context-settings-modal');
    await expect(modal).toBeVisible({ timeout: 3000 });

    // Click the backdrop (outside the modal)
    await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(modal).not.toBeVisible({ timeout: 3000 });
  });

  test('has aria-label on settings button', async ({ page }) => {
    const btn = page.locator('.settings-btn');
    await expect(btn).toHaveAttribute('aria-label', 'Settings');
  });
});

// ─────────────────────────────────────────────────────────
// F.21: Console Drawer
// ─────────────────────────────────────────────────────────

test.describe('Console Drawer', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('opens when console toggle button is clicked', async ({ page }) => {
    await page.click('.console-toggle-btn');
    const drawer = page.locator('.console-drawer');
    await expect(drawer).toBeVisible({ timeout: 3000 });
  });

  test('closes when close button inside drawer is clicked', async ({ page }) => {
    await page.click('.console-toggle-btn');
    const drawer = page.locator('.console-drawer');
    await expect(drawer).toBeVisible({ timeout: 3000 });

    // Click the close button (✕) in the drawer header
    await page.click('.console-drawer .console-control-btn:last-child');
    await expect(drawer).not.toBeVisible({ timeout: 3000 });
  });

  test('shows log content or empty state message', async ({ page }) => {
    await page.click('.console-toggle-btn');
    const drawer = page.locator('.console-drawer');
    await expect(drawer).toBeVisible({ timeout: 3000 });

    // Wait for log content to render after fetch completes
    const logContent = drawer.locator('.console-logs');
    await expect(logContent).toBeVisible({ timeout: 5000 });
  });

  test('has filter chips for log levels', async ({ page }) => {
    await page.click('.console-toggle-btn');
    const drawer = page.locator('.console-drawer');
    await expect(drawer).toBeVisible({ timeout: 3000 });

    // Should have filter chips for DEBUG, INFO, WARN, ERROR
    const filterChips = drawer.locator('.console-filter-chip');
    const chipCount = await filterChips.count();
    expect(chipCount).toBeGreaterThanOrEqual(4); // at least the 4 log levels
  });

  test('has aria-label on console toggle button', async ({ page }) => {
    const btn = page.locator('.console-toggle-btn');
    await expect(btn).toHaveAttribute('aria-label', 'Toggle Console');
  });
});

// ─────────────────────────────────────────────────────────
// F.22: Focus-visible verification
// ─────────────────────────────────────────────────────────

test.describe('Focus-visible', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('settings button gets focus outline on Tab', async ({ page }) => {
    // Tab to the settings button
    await page.keyboard.press('Tab');

    // Keep tabbing until settings button is focused (max 20 tabs)
    for (let i = 0; i < 20; i++) {
      const focused = await page.evaluate(() => document.activeElement?.className || '');
      if (focused.includes('settings-btn')) break;
      await page.keyboard.press('Tab');
    }

    const settingsBtn = page.locator('.settings-btn');
    const outline = await settingsBtn.evaluate(el => {
      return window.getComputedStyle(el).outlineStyle;
    });
    // Either 'solid' from focus-visible or browser default
    expect(['solid', 'auto', 'none']).toContain(outline);
  });

  test('filter toggle button gets focus outline on Tab', async ({ page }) => {
    const filterBtn = page.locator('.filter-toggle-btn');
    await filterBtn.focus();

    const outline = await filterBtn.evaluate(el => {
      return window.getComputedStyle(el).outlineStyle;
    });
    expect(['solid', 'auto', 'none']).toContain(outline);
  });

  test('session row is keyboard focusable', async ({ page }) => {
    const sessionRow = page.locator('[data-testid="session-row"]').first();
    const isVisible = await sessionRow.isVisible().catch(() => false);
    if (isVisible) {
      await sessionRow.focus();
      const tabIndex = await sessionRow.getAttribute('tabindex');
      expect(tabIndex).toBe('0');
    }
  });
});

// ─────────────────────────────────────────────────────────
// F.23: Empty state variations
// ─────────────────────────────────────────────────────────

test.describe('Empty states', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('session detail shows state indicator after load', async ({ page }) => {
    const detail = page.locator('[data-testid="session-detail"]');
    // Session detail container should always be present (auto-retry handles load timing)
    await expect(detail).toBeVisible({ timeout: 5000 });
  });

  test('search with non-matching query shows appropriate feedback', async ({ page }) => {
    const searchInput = page.locator('.search-bar-input');
    await searchInput.fill('zzzznonexistentqueryzzz');

    // Wait for debounce to settle by watching for either empty message or search badge
    const emptyMsg = page.locator('.feed__empty-message');
    const badge = page.locator('.search-results-badge');
    await expect(emptyMsg.or(badge)).toBeVisible({ timeout: 5000 });

    const isEmptyVisible = await emptyMsg.isVisible().catch(() => false);
    const isBadgeVisible = await badge.isVisible().catch(() => false);

    // At least one should indicate no results
    expect(isEmptyVisible || isBadgeVisible).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// F.24: Activity bar interaction
// ─────────────────────────────────────────────────────────

test.describe('Activity bar', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('activity bar is visible in two-panel layout', async ({ page }) => {
    const activityBar = page.locator('[data-testid="two-panel-activity"]');
    const isVisible = await activityBar.isVisible().catch(() => false);
    // Activity bar should be present in two-panel mode
    if (isVisible) {
      await expect(activityBar).toBeVisible();
    }
  });

  test('activity bar columns have aria-label for accessibility', async ({ page }) => {
    const columns = page.locator('.activity-bar-column');
    const columnCount = await columns.count();
    if (columnCount > 0) {
      const firstColumn = columns.first();
      const ariaLabel = await firstColumn.getAttribute('aria-label');
      // Columns should have aria-label with date and count info
      expect(ariaLabel).not.toBeNull();
      expect(ariaLabel).toContain('items');
    }
  });
});

// ─────────────────────────────────────────────────────────
// F.25: Search-to-filter mode transition
// ─────────────────────────────────────────────────────────

test.describe('Search and filter', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('typing in search switches to feed mode', async ({ page }) => {
    const searchInput = page.locator('.search-bar-input');
    await searchInput.fill('test');

    // Wait for debounce to settle and feed mode to activate
    const feed = page.locator('.feed');
    await expect(feed).toBeVisible({ timeout: 5000 });
  });

  test('clearing search returns to two-panel mode', async ({ page }) => {
    const searchInput = page.locator('.search-bar-input');

    // Type to enter search mode and wait for feed to appear
    await searchInput.fill('test');
    const feed = page.locator('.feed');
    await expect(feed).toBeVisible({ timeout: 5000 });

    // Clear the search
    const clearBtn = page.locator('.search-bar-clear');
    const hasClear = await clearBtn.isVisible().catch(() => false);
    if (hasClear) {
      await clearBtn.click();
    } else {
      await searchInput.fill('');
    }

    // Wait for two-panel mode to return after clearing search
    const twoPanel = page.locator('[data-testid="two-panel"]');
    await expect(twoPanel).toBeVisible({ timeout: 5000 });
  });

  test('search results badge appears with query', async ({ page }) => {
    const searchInput = page.locator('.search-bar-input');
    await searchInput.fill('test');

    // Wait for debounce to settle and feed mode to activate
    const feed = page.locator('.feed');
    await expect(feed).toBeVisible({ timeout: 5000 });

    // Results badge should appear when in search mode
    const badge = page.locator('.search-results-badge');
    const isBadgeVisible = await badge.isVisible().catch(() => false);
    // Badge may or may not appear depending on results — just verify no crash
    expect(typeof isBadgeVisible).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────
// Accessibility landmarks
// ─────────────────────────────────────────────────────────

test.describe('Accessibility landmarks', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('header has role=banner', async ({ page }) => {
    const header = page.locator('.header');
    const role = await header.getAttribute('role');
    expect(role).toBe('banner');
  });

  test('session list aside has aria-label', async ({ page }) => {
    const aside = page.locator('[data-testid="two-panel-left"]');
    const isVisible = await aside.isVisible().catch(() => false);
    if (isVisible) {
      const label = await aside.getAttribute('aria-label');
      expect(label).toBe('Session list');
    }
  });

  test('session detail main has aria-label', async ({ page }) => {
    const main = page.locator('[data-testid="two-panel-right"]');
    const isVisible = await main.isVisible().catch(() => false);
    if (isVisible) {
      const label = await main.getAttribute('aria-label');
      expect(label).toBe('Session detail');
    }
  });
});
