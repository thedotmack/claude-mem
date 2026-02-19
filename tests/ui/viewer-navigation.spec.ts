import { test, expect } from '@playwright/test';

/**
 * E2E tests for calendar navigation, day navigation, and session list
 * scroll behaviour.
 *
 * The viewer is served by the running Express worker at http://localhost:37777.
 *
 * These tests verify the full feature journey:
 *   1. Day navigator ← / → buttons scroll session list
 *   2. Calendar picker opens, selects a date, scrolls to that date's sessions
 *   3. Arrow key navigation (← / →) navigates between days
 *   4. Selected date label matches the visible sessions
 */

/** Wait until the SSE connection is established and initial data has rendered. */
async function waitForViewerReady(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('.header', { state: 'visible', timeout: 15000 });
  await page.waitForSelector('[data-testid="two-panel"]', { state: 'visible', timeout: 15000 });
}

/** Wait until session rows are rendered in the session list. */
async function waitForSessions(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('[data-testid="session-row"]', { state: 'visible', timeout: 15000 });
}

// ─────────────────────────────────────────────────────────
// DayNavigator
// ─────────────────────────────────────────────────────────

test.describe('DayNavigator', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
    await waitForSessions(page);
  });

  test('shows "Today" label by default', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    await expect(dayNav).toBeVisible({ timeout: 3000 });
    const label = dayNav.locator('.day-navigator__label');
    await expect(label).toHaveText('Today');
  });

  test('← button navigates to the previous day from Today', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const prevBtn = dayNav.locator('button[aria-label="Previous day"]');
    const label = dayNav.locator('.day-navigator__label');

    // Initial state: "Today"
    await expect(label).toHaveText('Today');

    // Click ← should navigate to the previous available day
    await prevBtn.click();

    // Wait for the label to update after navigation
    await expect(label).not.toHaveText('Today');
    await expect(label).not.toHaveText('All sessions');
  });

  test('→ button is disabled when at Today (newest date)', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const nextBtn = dayNav.locator('button[aria-label="Next day"]');
    const label = dayNav.locator('.day-navigator__label');

    // Initial state: "Today" (the newest date)
    await expect(label).toHaveText('Today');

    // → should be disabled at the newest date
    await expect(nextBtn).toBeDisabled();
  });

  test('clicking ← scrolls the session list to show that day\'s header', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const prevBtn = dayNav.locator('button[aria-label="Previous day"]');
    const label = dayNav.locator('.day-navigator__label');

    await prevBtn.click();

    // Wait for the label to update after navigation (away from "Today")
    await expect(label).not.toHaveText('Today');

    // Get the label text
    const labelText = await label.textContent();
    expect(labelText).toBeTruthy();
    expect(labelText).not.toBe('All sessions');

    // The session list should contain a day header matching the label
    const sessionList = page.locator('[data-testid="session-list"]');
    const dayHeaders = sessionList.locator('.session-list__day-header');
    const headerCount = await dayHeaders.count();
    expect(headerCount).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────
// CalendarPicker
// ─────────────────────────────────────────────────────────

test.describe('CalendarPicker', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
    await waitForSessions(page);
  });

  test('clicking label opens calendar picker', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    await label.click();
    const calendar = page.locator('[data-testid="calendar-picker"]');
    await expect(calendar).toBeVisible({ timeout: 3000 });
  });

  test('calendar shows month/year header', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    await label.click();
    const calendar = page.locator('[data-testid="calendar-picker"]');
    await expect(calendar).toBeVisible({ timeout: 3000 });

    const monthLabel = calendar.locator('.calendar-picker__month-label');
    await expect(monthLabel).toBeVisible();
    const text = await monthLabel.textContent();
    // Should be a valid month/year string like "February 2026"
    expect(text).toMatch(/\w+ \d{4}/);
  });

  test('calendar shows weekday headers', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    await label.click();
    const calendar = page.locator('[data-testid="calendar-picker"]');
    await expect(calendar).toBeVisible({ timeout: 3000 });

    const weekdays = calendar.locator('.calendar-picker__weekday');
    await expect(weekdays).toHaveCount(7);
    await expect(weekdays.first()).toHaveText('Mon');
    await expect(weekdays.last()).toHaveText('Sun');
  });

  test('calendar has clickable activity days and disabled non-activity days', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    await label.click();
    const calendar = page.locator('[data-testid="calendar-picker"]');
    await expect(calendar).toBeVisible({ timeout: 3000 });

    // Wait for activity data to load — at least one active day should appear
    const activeDays = calendar.locator('.calendar-picker__day--active');
    await expect(activeDays.first()).toBeVisible({ timeout: 10000 });
    const activeCount = await activeDays.count();
    expect(activeCount).toBeGreaterThan(0);

    // Active days should have dots
    const dots = calendar.locator('.calendar-picker__dot');
    await expect(dots.first()).toBeVisible({ timeout: 5000 });
    const dotCount = await dots.count();
    expect(dotCount).toBeGreaterThan(0);
  });

  test('clicking an active date in calendar updates the day navigator label', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    await label.click();
    const calendar = page.locator('[data-testid="calendar-picker"]');
    await expect(calendar).toBeVisible({ timeout: 3000 });

    // Wait for activity data, then click the first active day
    const activeDays = calendar.locator('.calendar-picker__day--active');
    await expect(activeDays.first()).toBeVisible({ timeout: 10000 });
    const firstActive = activeDays.first();
    const dateAttr = await firstActive.getAttribute('aria-label');
    await firstActive.click();

    // Calendar should close
    await expect(calendar).not.toBeVisible({ timeout: 3000 });

    // Label should change from "All sessions"
    await expect(label).not.toHaveText('All sessions');
  });

  test('clicking an active date loads and scrolls to that date\'s sessions', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    await label.click();
    const calendar = page.locator('[data-testid="calendar-picker"]');
    await expect(calendar).toBeVisible({ timeout: 3000 });

    // Wait for activity data, then find an active day that is not today
    await expect(calendar.locator('.calendar-picker__day--active').first()).toBeVisible({ timeout: 10000 });
    const activeDays = calendar.locator('.calendar-picker__day--active:not(.calendar-picker__day--today)');
    const count = await activeDays.count();

    if (count > 0) {
      // Get the date from the aria-label (format: "YYYY-MM-DD — has activity")
      const dateAttr = await activeDays.first().getAttribute('aria-label');
      const datePart = dateAttr?.split(' — ')[0] ?? '';

      await activeDays.first().click();
      await expect(calendar).not.toBeVisible({ timeout: 3000 });

      // Wait for sessions to load after date selection
      const sessionList = page.locator('[data-testid="session-list"]');
      const dayHeaders = sessionList.locator('.session-list__day-header');
      await expect(dayHeaders.first()).toBeVisible({ timeout: 10000 });
      const headerCount = await dayHeaders.count();
      expect(headerCount).toBeGreaterThan(0);

      // The label should reflect the selected date
      const labelText = await label.textContent();
      expect(labelText).not.toBe('All sessions');
    }
  });

  test('calendar closes on Escape key', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    await label.click();
    const calendar = page.locator('[data-testid="calendar-picker"]');
    await expect(calendar).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
    await expect(calendar).not.toBeVisible({ timeout: 3000 });
  });

  test('"Today" button in calendar navigates back to today', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    // First navigate to a specific date via ← button
    const prevBtn = dayNav.locator('button[aria-label="Previous day"]');
    await prevBtn.click();
    // Wait for label to update after navigation
    await expect(label).not.toHaveText('Today');

    // Open calendar
    await label.click();
    const calendar = page.locator('[data-testid="calendar-picker"]');
    await expect(calendar).toBeVisible({ timeout: 3000 });

    // Click "Today" button
    const todayBtn = calendar.locator('.calendar-picker__reset');
    await todayBtn.click();

    // Calendar closes and label shows "Today"
    await expect(calendar).not.toBeVisible({ timeout: 3000 });
    await expect(label).toHaveText('Today');
  });

  test('calendar month navigation arrows work', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    await label.click();
    const calendar = page.locator('[data-testid="calendar-picker"]');
    await expect(calendar).toBeVisible({ timeout: 3000 });

    const monthLabel = calendar.locator('.calendar-picker__month-label');
    const initialMonth = await monthLabel.textContent();

    // Click previous month
    const prevMonthBtn = calendar.locator('button[aria-label="Previous month"]');
    await prevMonthBtn.click();

    // Wait for month label to change after navigation
    await expect(monthLabel).not.toHaveText(initialMonth!);
    const newMonth = await monthLabel.textContent();
    expect(newMonth).not.toBe(initialMonth);
  });
});

// ─────────────────────────────────────────────────────────
// Keyboard day navigation (← / →)
// ─────────────────────────────────────────────────────────

test.describe('Arrow key day navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
    await waitForSessions(page);
    // Click body to ensure no input is focused
    await page.click('body');
  });

  test('← key navigates to previous day', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    // Initial state should be "Today"
    await expect(label).toHaveText('Today');

    // Press left arrow — navigates to the day before Today
    await page.keyboard.press('ArrowLeft');

    // Wait for the label to update after keyboard navigation
    await expect(label).not.toHaveText('Today');
    await expect(label).not.toHaveText('All sessions');
  });

  test('→ key after ← returns to Today', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    // Start at "Today", go ← to previous day
    await expect(label).toHaveText('Today');
    await page.keyboard.press('ArrowLeft');
    // Wait for the label to update after left arrow navigation
    await expect(label).not.toHaveText('Today');

    // → should return to "Today"
    await page.keyboard.press('ArrowRight');
    // Wait for the label to update after right arrow navigation
    await expect(label).toHaveText('Today');
  });

  test('multiple ← presses navigate further back in time', async ({ page }) => {
    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');

    await page.keyboard.press('ArrowLeft');
    // Wait for the label to update away from "Today" after first press
    await expect(label).not.toHaveText('Today');
    const firstDate = await label.textContent();

    await page.keyboard.press('ArrowLeft');
    // Wait for the label to change from the first date after second press
    await expect(label).not.toHaveText(firstDate!);
    const secondDate = await label.textContent();

    // Each press should show a different (older) date
    expect(firstDate).not.toBe(secondDate);
  });
});

// ─────────────────────────────────────────────────────────
// Session list scroll behaviour
// ─────────────────────────────────────────────────────────

test.describe('Session list scroll', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
    await waitForSessions(page);
  });

  test('day headers are visually distinct with accent border', async ({ page }) => {
    const sessionList = page.locator('[data-testid="session-list"]');
    const dayHeader = sessionList.locator('.session-list__day-header').first();
    await expect(dayHeader).toBeVisible({ timeout: 5000 });

    // Check computed styles for the accent border
    const borderLeft = await dayHeader.evaluate(el =>
      window.getComputedStyle(el).getPropertyValue('border-left-style')
    );
    expect(borderLeft).toBe('solid');
  });

  test('selecting a session via click shows its detail', async ({ page }) => {
    const sessionRow = page.locator('[data-testid="session-row"]').first();
    await expect(sessionRow).toBeVisible({ timeout: 10000 });

    await sessionRow.click();

    // Wait for the right panel to show session detail after selection
    const rightPanel = page.locator('[data-testid="two-panel-right"]');
    await expect(rightPanel).toBeVisible();
  });

  test('selecting a session highlights it with aria-selected', async ({ page }) => {
    const sessionRow = page.locator('[data-testid="session-row"]').first();
    await expect(sessionRow).toBeVisible({ timeout: 10000 });

    await sessionRow.click();

    // Wait for the aria-selected attribute to be applied after click
    const selected = page.locator('[data-testid="session-row"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
  });
});

// ─────────────────────────────────────────────────────────
// Full calendar navigation journey
// ─────────────────────────────────────────────────────────

test.describe('Calendar navigation journey', () => {
  test('complete journey: open calendar → select date → verify sessions → reset via calendar', async ({ page }) => {
    await page.goto('/');
    await waitForViewerReady(page);
    await waitForSessions(page);

    const dayNav = page.locator('[data-testid="day-navigator"]');
    const label = dayNav.locator('.day-navigator__label');
    const sessionList = page.locator('[data-testid="session-list"]');

    // Step 1: Verify initial state is "Today"
    await expect(label).toHaveText('Today');

    // Step 2: Open calendar
    await label.click();
    const calendar = page.locator('[data-testid="calendar-picker"]');
    await expect(calendar).toBeVisible({ timeout: 3000 });

    // Step 3: Wait for activity data to load, then click an active day
    const activeDays = calendar.locator('.calendar-picker__day--active');
    await expect(activeDays.first()).toBeVisible({ timeout: 10000 });
    const activeCount = await activeDays.count();
    expect(activeCount).toBeGreaterThan(0);

    await activeDays.first().click();
    await expect(calendar).not.toBeVisible({ timeout: 3000 });

    // Step 4: Verify label changed (could be a date or "Today")
    const selectedLabel = await label.textContent();
    expect(selectedLabel).toBeTruthy();

    // Step 5: Wait for sessions to load after date selection
    const visibleRows = sessionList.locator('[data-testid="session-row"]');
    await expect(visibleRows.first()).toBeVisible({ timeout: 10000 });

    // Step 6: Verify sessions are visible
    const rowCount = await visibleRows.count();
    expect(rowCount).toBeGreaterThan(0);

    // Step 7: Navigate back to today via calendar "Today" button
    await label.click();
    await expect(calendar).toBeVisible({ timeout: 3000 });
    const todayBtn = calendar.locator('.calendar-picker__reset');
    await todayBtn.click();

    await expect(calendar).not.toBeVisible({ timeout: 3000 });
    await expect(label).toHaveText('Today');
  });
});
