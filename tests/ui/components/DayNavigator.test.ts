/**
 * Tests for DayNavigator component and its pure utility functions.
 *
 * Since @testing-library/react is not installed, we test:
 * 1. Pure date calculation helpers exported from DayNavigator
 * 2. Pure display label helper exported from DayNavigator
 * 3. Component module can be imported without errors (smoke test)
 *
 * Visual / interaction behaviour is covered by the Playwright E2E suite.
 */

import { describe, it, expect } from 'vitest';

// ─────────────────────────────────────────────────────────
// navigateDay — date arithmetic (G.6)
// ─────────────────────────────────────────────────────────

describe('navigateDay — decrement by 1 day', () => {
  it('returns the previous day when direction is prev', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(navigateDay('2026-02-17', 'prev', '2026-02-18')).toBe('2026-02-16');
  });

  it('decrements across month boundaries', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(navigateDay('2026-03-01', 'prev', '2026-03-15')).toBe('2026-02-28');
  });

  it('decrements across year boundaries', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(navigateDay('2026-01-01', 'prev', '2026-01-15')).toBe('2025-12-31');
  });

  it('handles leap year correctly when going back from March 1', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(navigateDay('2024-03-01', 'prev', '2024-04-01')).toBe('2024-02-29');
  });
});

describe('navigateDay — increment by 1 day', () => {
  it('returns the next day when direction is next and not at today', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(navigateDay('2026-02-16', 'next', '2026-02-18')).toBe('2026-02-17');
  });

  it('increments across month boundaries', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(navigateDay('2026-01-31', 'next', '2026-03-01')).toBe('2026-02-01');
  });

  it('increments across year boundaries', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(navigateDay('2025-12-31', 'next', '2026-02-18')).toBe('2026-01-01');
  });
});

describe('navigateDay — cap at today (cannot go past today)', () => {
  it('returns today when current date equals today and direction is next', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    // today is the cap — cannot advance past it
    expect(navigateDay('2026-02-18', 'next', '2026-02-18')).toBe('2026-02-18');
  });

  it('does not advance past today', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    // Even if current is the day before today, next cannot exceed today
    const result = navigateDay('2026-02-17', 'next', '2026-02-18');
    expect(result <= '2026-02-18').toBe(true);
    expect(result).toBe('2026-02-18');
  });

  it('always allows going backward from today', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(navigateDay('2026-02-18', 'prev', '2026-02-18')).toBe('2026-02-17');
  });
});

describe('navigateDay — no active filter ("" date)', () => {
  it('sets date to today when no filter active and direction is next', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(navigateDay('', 'next', '2026-02-18')).toBe('2026-02-18');
  });

  it('sets date to yesterday when no filter active and direction is prev', async () => {
    const { navigateDay } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(navigateDay('', 'prev', '2026-02-18')).toBe('2026-02-17');
  });
});

// ─────────────────────────────────────────────────────────
// formatDayLabel — display label helpers (G.6)
// ─────────────────────────────────────────────────────────

describe('formatDayLabel — "All sessions" when no filter active', () => {
  it('returns "All sessions" when both dateStart and dateEnd are empty', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(formatDayLabel('', '', '2026-02-18')).toBe('All sessions');
  });

  it('returns "All sessions" when dateStart is empty and dateEnd is empty', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(formatDayLabel('', '', '2026-02-15')).toBe('All sessions');
  });
});

describe('formatDayLabel — "Today" when date matches today', () => {
  it('returns "Today" when dateStart equals today and dateEnd is empty', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(formatDayLabel('2026-02-18', '', '2026-02-18')).toBe('Today');
  });

  it('returns "Today" when both dateStart and dateEnd equal today', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(formatDayLabel('2026-02-18', '2026-02-18', '2026-02-18')).toBe('Today');
  });
});

describe('formatDayLabel — formatted date for non-today single day', () => {
  it('returns "Feb 17" for 2026-02-17 when today is 2026-02-18', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(formatDayLabel('2026-02-17', '', '2026-02-18')).toBe('Feb 17');
  });

  it('returns "Jan 1" for 2026-01-01 when today is 2026-02-18', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(formatDayLabel('2026-01-01', '', '2026-02-18')).toBe('Jan 1');
  });

  it('returns short month and day with no leading zero on day', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    // March 5 should be "Mar 5" not "Mar 05"
    expect(formatDayLabel('2026-03-05', '', '2026-04-01')).toBe('Mar 5');
  });

  it('returns "Dec 31" for end-of-year date', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(formatDayLabel('2025-12-31', '', '2026-02-18')).toBe('Dec 31');
  });
});

describe('formatDayLabel — range format "Feb 15 – Feb 17" for date ranges', () => {
  it('returns "Feb 15 – Feb 17" for a 3-day range', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(formatDayLabel('2026-02-15', '2026-02-17', '2026-02-18')).toBe('Feb 15 – Feb 17');
  });

  it('returns range with em dash separator', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    const result = formatDayLabel('2026-02-01', '2026-02-10', '2026-02-18');
    expect(result).toContain('–');
    expect(result).toBe('Feb 1 – Feb 10');
  });

  it('returns range spanning months', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(formatDayLabel('2026-01-29', '2026-02-02', '2026-02-18')).toBe('Jan 29 – Feb 2');
  });

  it('returns range with today at end', async () => {
    const { formatDayLabel } = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    // When dateEnd is today, shows range (not just "Today")
    expect(formatDayLabel('2026-02-15', '2026-02-18', '2026-02-18')).toBe('Feb 15 – Today');
  });
});

// ─────────────────────────────────────────────────────────
// Module smoke tests
// ─────────────────────────────────────────────────────────

describe('DayNavigator module', () => {
  it('exports navigateDay as a function', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(typeof mod.navigateDay).toBe('function');
  });

  it('exports formatDayLabel as a function', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(typeof mod.formatDayLabel).toBe('function');
  });

  it('exports a DayNavigator component', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/DayNavigator.js'
    );
    expect(mod.DayNavigator).toBeDefined();
    expect(typeof mod.DayNavigator === 'function' || typeof mod.DayNavigator === 'object').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// TwoPanel integration — DayNavigator wired via scroll-based navigation
// ─────────────────────────────────────────────────────────

describe('TwoPanel — DayNavigator integration (structural test)', () => {
  it('TwoPanel module imports DayNavigator', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer/components/TwoPanel.tsx'),
      'utf-8'
    );
    expect(src).toMatch(/DayNavigator/);
  });

  it('TwoPanel passes scroll-based props to DayNavigator', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer/components/TwoPanel.tsx'),
      'utf-8'
    );
    // DayNavigator receives scroll-based props (not filter-based)
    expect(src).toMatch(/availableDateKeys/);
    expect(src).toMatch(/activeDateKey/);
  });

  it('TwoPanel uses SessionListHandle ref for scrolling', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer/components/TwoPanel.tsx'),
      'utf-8'
    );
    expect(src).toMatch(/SessionListHandle/);
    expect(src).toMatch(/scrollToDate/);
  });

  it('App.tsx passes onDayNavigate prop to useKeyboardNavigation', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const appSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer/App.tsx'),
      'utf-8'
    );
    expect(appSrc).toMatch(/onDayNavigate/);
  });
});

// ─────────────────────────────────────────────────────────
// CSS structural test — day-navigator classes in viewer-template.html
// ─────────────────────────────────────────────────────────

describe('DayNavigator CSS — viewer-template.html contains required classes', () => {
  it('contains .day-navigator class', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const html = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer-template.html'),
      'utf-8'
    );
    expect(html).toMatch(/\.day-navigator\b/);
  });

  it('contains .day-navigator__btn class', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const html = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer-template.html'),
      'utf-8'
    );
    expect(html).toMatch(/\.day-navigator__btn\b/);
  });

  it('contains .day-navigator__label class', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const html = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer-template.html'),
      'utf-8'
    );
    expect(html).toMatch(/\.day-navigator__label\b/);
  });
});
