import { test, expect } from '@playwright/test';

/**
 * Phase C Playwright tests for redesigned cards and header.
 *
 * Tests cover:
 * - ObservationCard: always-visible concepts, click-to-expand, left-border accents
 * - SummaryCard: independent section collapse, default states
 * - Header: simplified to 4-5 elements
 * - Theme toggle: accessible in ContextSettingsModal
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
  await expect(page.locator(`[data-theme="${theme}"]`)).toBeAttached();
}

/** Navigate to a session that contains observations with concepts. */
async function navigateToSessionWithObservations(page: import('@playwright/test').Page): Promise<boolean> {
  // Click sessions until we find one with observation cards
  const sessionRows = page.locator('[data-testid="session-row"]');
  const rowCount = await sessionRows.count();

  for (let i = 0; i < Math.min(rowCount, 10); i++) {
    await sessionRows.nth(i).click();
    // Wait for the detail panel to update after clicking a session row
    await page.locator('[data-testid="two-panel-right"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

    const obsCards = page.locator('[data-testid="obs-card"]');
    const obsCount = await obsCards.count();
    if (obsCount > 0) {
      return true;
    }
  }
  return false;
}

// ──────────────────────────────────────────────────
// ObservationCard tests
// ──────────────────────────────────────────────────

test.describe('ObservationCard — concepts always visible', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('concept chips are visible without expanding the card', async ({ page }) => {
    const hasObs = await navigateToSessionWithObservations(page);
    if (!hasObs) {
      test.skip();
      return;
    }

    // Find an observation card that has concepts
    const cardsWithConcepts = page.locator('[data-testid="obs-card"] .card__concepts');
    const count = await cardsWithConcepts.count();

    if (count > 0) {
      // The concepts section should be visible even when card is not expanded
      const firstCard = page.locator('[data-testid="obs-card"]').first();
      const isExpanded = await firstCard.getAttribute('aria-expanded');
      expect(isExpanded).toBe('false');

      const concepts = firstCard.locator('.card__concepts');
      if (await concepts.count() > 0) {
        await expect(concepts).toBeVisible();
      }
    }
  });

  test('concept chips contain text', async ({ page }) => {
    const hasObs = await navigateToSessionWithObservations(page);
    if (!hasObs) {
      test.skip();
      return;
    }

    const chips = page.locator('[data-testid="obs-card"] .observation-card__concept-chip');
    const chipCount = await chips.count();

    if (chipCount > 0) {
      const firstChipText = await chips.first().textContent();
      expect(firstChipText).toBeTruthy();
      expect(firstChipText!.trim().length).toBeGreaterThan(0);
    }
  });
});

test.describe('ObservationCard — click-to-expand facts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('card starts collapsed and expand hint shows', async ({ page }) => {
    const hasObs = await navigateToSessionWithObservations(page);
    if (!hasObs) {
      test.skip();
      return;
    }

    const expandableCard = page.locator('[data-testid="obs-card"] .expand-hint').first();
    if (await expandableCard.count() > 0) {
      const card = expandableCard.locator('xpath=ancestor::div[@data-testid="obs-card"]');
      const expanded = await card.getAttribute('aria-expanded');
      expect(expanded).toBe('false');
      await expect(expandableCard).toContainText('expand');
    }
  });

  test('clicking card expands facts section', async ({ page }) => {
    const hasObs = await navigateToSessionWithObservations(page);
    if (!hasObs) {
      test.skip();
      return;
    }

    // Find a card that has expandable content (has the expand hint)
    const expandHint = page.locator('[data-testid="obs-card"] .expand-hint').first();
    if (await expandHint.count() === 0) {
      test.skip();
      return;
    }

    const card = page.locator('[data-testid="obs-card"]').filter({ has: page.locator('.expand-hint') }).first();

    // Click to expand
    await card.click();

    // Wait for expanded state via auto-retrying assertion
    await expect(card).toHaveAttribute('aria-expanded', 'true');

    // Facts section should now be visible
    const facts = card.locator('[data-testid="obs-card-facts"]');
    await expect(facts).toBeVisible();
  });

  test('clicking expanded card collapses facts section', async ({ page }) => {
    const hasObs = await navigateToSessionWithObservations(page);
    if (!hasObs) {
      test.skip();
      return;
    }

    const card = page.locator('[data-testid="obs-card"]').filter({ has: page.locator('.expand-hint') }).first();
    if (await card.count() === 0) {
      test.skip();
      return;
    }

    // Expand
    await card.click();
    await expect(card).toHaveAttribute('aria-expanded', 'true');

    // Collapse
    await card.click();
    await expect(card).toHaveAttribute('aria-expanded', 'false');

    // Facts should be gone
    const facts = card.locator('[data-testid="obs-card-facts"]');
    await expect(facts).not.toBeVisible();
  });
});

test.describe('ObservationCard — left-border accent by type', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('observation cards have data-obs-type attribute', async ({ page }) => {
    const hasObs = await navigateToSessionWithObservations(page);
    if (!hasObs) {
      test.skip();
      return;
    }

    const cards = page.locator('[data-testid="obs-card"]');
    const count = await cards.count();

    if (count > 0) {
      const firstCard = cards.first();
      const obsType = await firstCard.getAttribute('data-obs-type');
      expect(obsType).toBeTruthy();
    }
  });

  test('observation cards have a left border', async ({ page }) => {
    const hasObs = await navigateToSessionWithObservations(page);
    if (!hasObs) {
      test.skip();
      return;
    }

    const firstCard = page.locator('[data-testid="obs-card"]').first();
    const borderLeft = await firstCard.evaluate(
      (el) => window.getComputedStyle(el).borderLeftWidth,
    );
    // Should have a 3px left border (the accent)
    expect(parseFloat(borderLeft)).toBeGreaterThanOrEqual(2);
  });
});

// ──────────────────────────────────────────────────
// SummaryCard tests
// ──────────────────────────────────────────────────

test.describe('SummaryCard — independent section collapse', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('summary card sections have data-section-key attributes', async ({ page }) => {
    // Navigate to a session that has a summary card
    const sessionRows = page.locator('[data-testid="session-row"]');
    const rowCount = await sessionRows.count();

    let foundSummary = false;
    for (let i = 0; i < Math.min(rowCount, 10); i++) {
      await sessionRows.nth(i).click();
      // Wait for the detail panel to update after clicking a session row
      await page.locator('[data-testid="two-panel-right"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

      const summaryCards = page.locator('[data-testid="summary-card"]');
      if (await summaryCards.count() > 0) {
        foundSummary = true;
        break;
      }
    }

    if (!foundSummary) {
      test.skip();
      return;
    }

    const sections = page.locator('[data-testid="summary-section"]');
    const sectionCount = await sections.count();
    expect(sectionCount).toBeGreaterThan(0);

    // Each section should have a data-section-key
    for (let i = 0; i < sectionCount; i++) {
      const key = await sections.nth(i).getAttribute('data-section-key');
      expect(key).toBeTruthy();
      expect(['investigated', 'learned', 'completed', 'next_steps']).toContain(key);
    }
  });

  test('default expand/collapse states are correct', async ({ page }) => {
    const sessionRows = page.locator('[data-testid="session-row"]');
    const rowCount = await sessionRows.count();

    let foundSummary = false;
    for (let i = 0; i < Math.min(rowCount, 10); i++) {
      await sessionRows.nth(i).click();
      // Wait for the detail panel to update after clicking a session row
      await page.locator('[data-testid="two-panel-right"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

      if (await page.locator('[data-testid="summary-card"]').count() > 0) {
        foundSummary = true;
        break;
      }
    }

    if (!foundSummary) {
      test.skip();
      return;
    }

    // Check default states: completed and next_steps expanded, investigated and learned collapsed
    const completedSection = page.locator('[data-testid="summary-section"][data-section-key="completed"]');
    const nextStepsSection = page.locator('[data-testid="summary-section"][data-section-key="next_steps"]');
    const investigatedSection = page.locator('[data-testid="summary-section"][data-section-key="investigated"]');
    const learnedSection = page.locator('[data-testid="summary-section"][data-section-key="learned"]');

    if (await completedSection.count() > 0) {
      expect(await completedSection.getAttribute('aria-expanded')).toBe('true');
    }
    if (await nextStepsSection.count() > 0) {
      expect(await nextStepsSection.getAttribute('aria-expanded')).toBe('true');
    }
    if (await investigatedSection.count() > 0) {
      expect(await investigatedSection.getAttribute('aria-expanded')).toBe('false');
    }
    if (await learnedSection.count() > 0) {
      expect(await learnedSection.getAttribute('aria-expanded')).toBe('false');
    }
  });

  test('clicking a section header toggles its expand state', async ({ page }) => {
    const sessionRows = page.locator('[data-testid="session-row"]');
    const rowCount = await sessionRows.count();

    let foundSummary = false;
    for (let i = 0; i < Math.min(rowCount, 10); i++) {
      await sessionRows.nth(i).click();
      // Wait for the detail panel to update after clicking a session row
      await page.locator('[data-testid="two-panel-right"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

      if (await page.locator('[data-testid="summary-card"]').count() > 0) {
        foundSummary = true;
        break;
      }
    }

    if (!foundSummary) {
      test.skip();
      return;
    }

    // Find a section that is expanded by default (completed)
    const completedSection = page.locator('[data-testid="summary-section"][data-section-key="completed"]');
    if (await completedSection.count() === 0) {
      test.skip();
      return;
    }

    expect(await completedSection.getAttribute('aria-expanded')).toBe('true');

    // Click the header to collapse
    const header = completedSection.locator('[data-testid="summary-section-header"]');
    await header.click();
    await expect(completedSection).toHaveAttribute('aria-expanded', 'false');

    // Click again to re-expand
    await header.click();
    await expect(completedSection).toHaveAttribute('aria-expanded', 'true');
  });

  test('sections collapse independently of each other', async ({ page }) => {
    const sessionRows = page.locator('[data-testid="session-row"]');
    const rowCount = await sessionRows.count();

    let foundSummary = false;
    for (let i = 0; i < Math.min(rowCount, 10); i++) {
      await sessionRows.nth(i).click();
      // Wait for the detail panel to update after clicking a session row
      await page.locator('[data-testid="two-panel-right"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

      if (await page.locator('[data-testid="summary-card"]').count() > 0) {
        foundSummary = true;
        break;
      }
    }

    if (!foundSummary) {
      test.skip();
      return;
    }

    const sections = page.locator('[data-testid="summary-section"]');
    const sectionCount = await sections.count();
    if (sectionCount < 2) {
      test.skip();
      return;
    }

    // Record initial states
    const initialStates: Record<string, string> = {};
    for (let i = 0; i < sectionCount; i++) {
      const key = await sections.nth(i).getAttribute('data-section-key');
      const expanded = await sections.nth(i).getAttribute('aria-expanded');
      initialStates[key!] = expanded!;
    }

    // Toggle the first section
    const firstSection = sections.first();
    const firstHeader = firstSection.locator('[data-testid="summary-section-header"]');
    const firstInitialState = initialStates[await firstSection.getAttribute('data-section-key') as string];
    const expectedFirstState = firstInitialState === 'true' ? 'false' : 'true';
    await firstHeader.click();
    // Wait for the toggled section to reflect its new state
    await expect(firstSection).toHaveAttribute('aria-expanded', expectedFirstState);

    // All OTHER sections should retain their initial state
    for (let i = 1; i < sectionCount; i++) {
      const key = await sections.nth(i).getAttribute('data-section-key');
      const expanded = await sections.nth(i).getAttribute('aria-expanded');
      expect(expanded).toBe(initialStates[key!]);
    }
  });
});

// ──────────────────────────────────────────────────
// Header tests
// ──────────────────────────────────────────────────

test.describe('Header — simplified layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('header contains logo, search, project selector, filter button, and settings', async ({ page }) => {
    const header = page.locator('.header');
    await expect(header).toBeVisible();

    // Logo
    const logo = header.locator('.logo-text');
    await expect(logo).toBeVisible();
    await expect(logo).toContainText('magic-claude-mem');

    // Search bar
    const searchInput = header.locator('input[type="search"], input[placeholder*="earch"]');
    await expect(searchInput).toBeVisible();

    // Project selector
    const projectSelect = header.locator('select');
    await expect(projectSelect).toBeVisible();

    // Settings button
    const settingsBtn = header.locator('.settings-btn');
    await expect(settingsBtn).toBeVisible();

    // Filter toggle button
    const filterBtn = header.locator('.filter-toggle-btn');
    await expect(filterBtn).toBeVisible();
  });

  test('header does NOT contain docs link', async ({ page }) => {
    const header = page.locator('.header');
    const docsLink = header.locator('a[href*="docs.magic-claude-mem"]');
    await expect(docsLink).toHaveCount(0);
  });

  test('header does NOT contain GitHub stars button', async ({ page }) => {
    const header = page.locator('.header');
    // GitHubStarsButton had the class .github-stars-btn
    const githubBtn = header.locator('.github-stars-btn');
    await expect(githubBtn).toHaveCount(0);
  });

  test('header does NOT contain standalone theme toggle', async ({ page }) => {
    const header = page.locator('.header');
    // ThemeToggle had the class .theme-toggle
    const themeToggle = header.locator('.theme-toggle');
    await expect(themeToggle).toHaveCount(0);
  });
});

// ──────────────────────────────────────────────────
// Theme toggle in settings modal
// ──────────────────────────────────────────────────

test.describe('Theme toggle — accessible in settings modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('opening settings modal shows Appearance section with theme options', async ({ page }) => {
    // Click settings button
    const settingsBtn = page.locator('.settings-btn');
    await settingsBtn.click();

    // Wait for the modal to become visible after click
    const modal = page.locator('.context-settings-modal');
    await expect(modal).toBeVisible();

    // Look for the Appearance section title
    const appearanceSection = modal.locator('.section-title', { hasText: 'Appearance' });
    await expect(appearanceSection).toBeVisible();

    // Should have theme option buttons (System, Light, Dark)
    const themeButtons = modal.locator('.theme-option-btn');
    const count = await themeButtons.count();
    expect(count).toBe(3);
  });

  test('clicking a theme option changes the active theme', async ({ page }) => {
    // Open settings
    const settingsBtn = page.locator('.settings-btn');
    await settingsBtn.click();

    // Wait for the modal to become visible after click
    const modal = page.locator('.context-settings-modal');
    await expect(modal).toBeVisible();

    // Find "Light" theme button and click it
    const lightBtn = modal.locator('.theme-option-btn').filter({ hasText: 'Light' });
    if (await lightBtn.count() > 0) {
      await lightBtn.click();

      // Wait for the button to reflect the selected state
      await expect(lightBtn).toHaveAttribute('aria-pressed', 'true');

      // Verify the theme attribute changed
      await expect(page.locator('html[data-theme="light"]')).toBeAttached();
    }

    // Switch to Dark
    const darkBtn = modal.locator('.theme-option-btn').filter({ hasText: 'Dark' });
    if (await darkBtn.count() > 0) {
      await darkBtn.click();

      // Wait for the button to reflect the selected state
      await expect(darkBtn).toHaveAttribute('aria-pressed', 'true');

      // Verify the theme attribute changed
      await expect(page.locator('html[data-theme="dark"]')).toBeAttached();
    }
  });
});

// ──────────────────────────────────────────────────
// Phase C screenshots
// ──────────────────────────────────────────────────

test.describe('Phase C — screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
  });

  test('cards in session detail — light theme', async ({ page }) => {
    await setTheme(page, 'light');
    await navigateToSessionWithObservations(page);

    const rightPanel = page.locator('[data-testid="two-panel-right"]');
    if (await rightPanel.count() > 0) {
      await rightPanel.screenshot({
        path: `${SCREENSHOT_DIR}/session-detail-cards-light.png`,
      });
    }
  });

  test('cards in session detail — dark theme', async ({ page }) => {
    await setTheme(page, 'dark');
    await navigateToSessionWithObservations(page);

    const rightPanel = page.locator('[data-testid="two-panel-right"]');
    if (await rightPanel.count() > 0) {
      await rightPanel.screenshot({
        path: `${SCREENSHOT_DIR}/session-detail-cards-dark.png`,
      });
    }
  });

  test('header simplified — light', async ({ page }) => {
    await setTheme(page, 'light');
    const header = page.locator('.header');
    await header.screenshot({
      path: `${SCREENSHOT_DIR}/header-simplified-light.png`,
    });
  });

  test('header simplified — dark', async ({ page }) => {
    await setTheme(page, 'dark');
    const header = page.locator('.header');
    await header.screenshot({
      path: `${SCREENSHOT_DIR}/header-simplified-dark.png`,
    });
  });

  test('settings modal with theme toggle', async ({ page }) => {
    await setTheme(page, 'light');
    const settingsBtn = page.locator('.settings-btn');
    await settingsBtn.click();

    // Wait for the modal to become visible before taking screenshot
    const modal = page.locator('.context-settings-modal');
    await expect(modal).toBeVisible();
    if (await modal.count() > 0) {
      await modal.screenshot({
        path: `${SCREENSHOT_DIR}/settings-modal-theme.png`,
      });
    }
  });
});
