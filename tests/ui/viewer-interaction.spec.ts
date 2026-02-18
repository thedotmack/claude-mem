import { test, expect } from '@playwright/test';

/**
 * Phase D Playwright tests for interaction layer.
 *
 * Tests cover:
 * - CommandPalette: opens via filter button, closes via Escape/backdrop, search input, filter chips
 * - Keyboard navigation: j/k session navigation, / focus search, f palette toggle, ? help overlay
 * - KeyboardShortcutHelp: appears on ?, lists shortcuts, closes on Esc
 *
 * The viewer is served by the running Express worker at http://localhost:37777.
 */

const SCREENSHOT_DIR = 'tests/ui/__screenshots__';

/** Wait until the SSE connection is established and initial data has rendered. */
async function waitForViewerReady(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('.header', { state: 'visible', timeout: 15000 });
  await page.waitForSelector('[data-testid="two-panel"], .feed', { state: 'visible', timeout: 15000 });
}

/** Force the viewer into the given theme. */
async function setTheme(
  page: import('@playwright/test').Page,
  theme: 'light' | 'dark',
): Promise<void> {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.waitForTimeout(300);
}

// ─────────────────────────────────────────────────────────
// CommandPalette
// ─────────────────────────────────────────────────────────

test.describe('CommandPalette', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('opens when filter button is clicked', async ({ page }) => {
    await page.click('.filter-toggle-btn');
    const palette = page.locator('[data-testid="command-palette"]');
    await expect(palette).toBeVisible({ timeout: 3000 });
  });

  test('closes on Escape key', async ({ page }) => {
    await page.click('.filter-toggle-btn');
    const palette = page.locator('[data-testid="command-palette"]');
    await expect(palette).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible({ timeout: 3000 });
  });

  test('closes when backdrop is clicked', async ({ page }) => {
    await page.click('.filter-toggle-btn');
    const palette = page.locator('[data-testid="command-palette"]');
    await expect(palette).toBeVisible({ timeout: 3000 });

    // Click at the edge of the backdrop (outside the palette dialog)
    const backdrop = page.locator('[data-testid="command-palette-backdrop"]');
    await backdrop.click({ position: { x: 10, y: 10 }, force: true });
    await expect(palette).not.toBeVisible({ timeout: 3000 });
  });

  test('search input is auto-focused when opened', async ({ page }) => {
    await page.click('.filter-toggle-btn');
    const search = page.locator('[data-testid="command-palette-search"]');
    await expect(search).toBeFocused({ timeout: 3000 });
  });

  test('contains filter sections (Type, Concept, Show, Date)', async ({ page }) => {
    await page.click('.filter-toggle-btn');
    const palette = page.locator('[data-testid="command-palette"]');
    await expect(palette).toBeVisible({ timeout: 3000 });

    await expect(palette.locator('.filter-section-label', { hasText: 'Type' })).toBeVisible();
    await expect(palette.locator('.filter-section-label', { hasText: 'Concept' })).toBeVisible();
    await expect(palette.locator('.filter-section-label', { hasText: 'Show' })).toBeVisible();
    await expect(palette.locator('.filter-section-label', { hasText: 'Date' })).toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────
// Keyboard Navigation
// ─────────────────────────────────────────────────────────

test.describe('Keyboard navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
    // Click body to ensure no input is focused
    await page.click('body');
  });

  test('/ focuses the search input', async ({ page }) => {
    await page.keyboard.press('/');
    const searchInput = page.locator('.search-bar-input');
    await expect(searchInput).toBeFocused({ timeout: 3000 });
  });

  test('f toggles the command palette', async ({ page }) => {
    const palette = page.locator('[data-testid="command-palette"]');
    await expect(palette).not.toBeVisible();

    await page.keyboard.press('f');
    await expect(palette).toBeVisible({ timeout: 3000 });

    // Escape to close palette, then click body to unfocus
    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible({ timeout: 3000 });
  });

  test('? toggles the keyboard help overlay', async ({ page }) => {
    const help = page.locator('[data-testid="keyboard-help"]');
    await expect(help).not.toBeVisible();

    await page.keyboard.press('?');
    await expect(help).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
    await expect(help).not.toBeVisible({ timeout: 3000 });
  });

  test('j/k keys are silently ignored (no longer mapped)', async ({ page }) => {
    // Wait for sessions to load
    const sessionRows = page.locator('[data-testid="session-row"]');
    await expect(sessionRows.first()).toBeVisible({ timeout: 10000 });

    // Press j then k - these are no longer mapped (replaced by ArrowUp/ArrowDown in Phase G)
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.keyboard.press('j');
    await page.waitForTimeout(300);
    await page.keyboard.press('k');
    await page.waitForTimeout(300);

    // No JavaScript errors should have occurred
    expect(consoleErrors.filter(e => !e.includes('Failed to load'))).toHaveLength(0);
  });

  test('shortcuts are suppressed when input is focused', async ({ page }) => {
    // Focus the search input
    await page.click('.search-bar-input');

    // Press f while input focused - palette should NOT open
    await page.keyboard.press('f');
    const palette = page.locator('[data-testid="command-palette"]');
    await expect(palette).not.toBeVisible();
  });
});

// ─────────────────────────────────────────────────────────
// KeyboardShortcutHelp
// ─────────────────────────────────────────────────────────

test.describe('KeyboardShortcutHelp', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
    await page.click('body');
  });

  test('displays all 6 shortcuts', async ({ page }) => {
    await page.keyboard.press('?');
    const help = page.locator('[data-testid="keyboard-help"]');
    await expect(help).toBeVisible({ timeout: 3000 });

    // Check for all shortcut keys (Phase G: arrows replaced j/k, Enter removed, day nav added)
    await expect(help.locator('.keyboard-help__key', { hasText: '↑ / ↓' })).toBeVisible();
    await expect(help.locator('.keyboard-help__key', { hasText: '← / →' })).toBeVisible();
    await expect(help.getByText('/', { exact: true })).toBeVisible();
    await expect(help.getByText('f', { exact: true })).toBeVisible();
    await expect(help.locator('.keyboard-help__key', { hasText: 'Esc' })).toBeVisible();
    await expect(help.getByText('?', { exact: true })).toBeVisible();
  });

  test('closes via the close button', async ({ page }) => {
    await page.keyboard.press('?');
    const help = page.locator('[data-testid="keyboard-help"]');
    await expect(help).toBeVisible({ timeout: 3000 });

    await help.locator('.keyboard-help__close').click();
    await expect(help).not.toBeVisible({ timeout: 3000 });
  });
});

// ─────────────────────────────────────────────────────────
// Phase D Screenshots
// ─────────────────────────────────────────────────────────

test.describe('Phase D screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('command palette open (light)', async ({ page }) => {
    await setTheme(page, 'light');
    await page.click('.filter-toggle-btn');
    await page.locator('[data-testid="command-palette"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/phase-d-command-palette-light.png`, fullPage: false });
  });

  test('command palette open (dark)', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.click('.filter-toggle-btn');
    await page.locator('[data-testid="command-palette"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/phase-d-command-palette-dark.png`, fullPage: false });
  });

  test('keyboard help overlay (light)', async ({ page }) => {
    await setTheme(page, 'light');
    await page.click('body');
    await page.keyboard.press('?');
    await page.locator('[data-testid="keyboard-help"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/phase-d-keyboard-help-light.png`, fullPage: false });
  });

  test('keyboard help overlay (dark)', async ({ page }) => {
    await setTheme(page, 'dark');
    await page.click('body');
    await page.keyboard.press('?');
    await page.locator('[data-testid="keyboard-help"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/phase-d-keyboard-help-dark.png`, fullPage: false });
  });
});
