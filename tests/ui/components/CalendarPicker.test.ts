/**
 * Tests for CalendarPicker component
 *
 * Tests the pure calendar utility functions and structural source-code checks.
 * No DOM/React needed — pure functions are tested directly.
 */

import { readFileSync } from 'fs';
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('getDaysInMonth', () => {
  it('returns 31 for January', async () => {
    const { getDaysInMonth } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    expect(getDaysInMonth(2026, 0)).toBe(31); // January
  });

  it('returns 28 for February in non-leap year', async () => {
    const { getDaysInMonth } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    expect(getDaysInMonth(2025, 1)).toBe(28);
  });

  it('returns 29 for February in leap year', async () => {
    const { getDaysInMonth } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    expect(getDaysInMonth(2024, 1)).toBe(29);
  });

  it('returns 30 for April', async () => {
    const { getDaysInMonth } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    expect(getDaysInMonth(2026, 3)).toBe(30); // April
  });

  it('returns 31 for December', async () => {
    const { getDaysInMonth } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    expect(getDaysInMonth(2026, 11)).toBe(31); // December
  });
});

describe('buildMonthGrid', () => {
  it('returns a 6-row grid', async () => {
    const { buildMonthGrid } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    const grid = buildMonthGrid(2026, 1); // February 2026
    expect(grid).toHaveLength(6);
  });

  it('each row has exactly 7 cells (Mon-Sun)', async () => {
    const { buildMonthGrid } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    const grid = buildMonthGrid(2026, 1); // February 2026
    for (const row of grid) {
      expect(row).toHaveLength(7);
    }
  });

  it('cells have date, dayOfMonth, and isCurrentMonth properties', async () => {
    const { buildMonthGrid } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    const grid = buildMonthGrid(2026, 1);
    const cell = grid[0][0];
    expect(cell).toHaveProperty('date');
    expect(cell).toHaveProperty('dayOfMonth');
    expect(cell).toHaveProperty('isCurrentMonth');
  });

  it('dates are in YYYY-MM-DD format', async () => {
    const { buildMonthGrid } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    const grid = buildMonthGrid(2026, 1);
    const cell = grid[0][0];
    expect(cell.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('February 2026 starts on Sunday — first row Monday is Jan 26', async () => {
    const { buildMonthGrid } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    // Feb 1 2026 is a Sunday. Mon-start grid means first cell is Mon Jan 26
    const grid = buildMonthGrid(2026, 1);
    expect(grid[0][0].date).toBe('2026-01-26');
    expect(grid[0][0].isCurrentMonth).toBe(false);
    // Sunday (index 6) should be Feb 1
    expect(grid[0][6].date).toBe('2026-02-01');
    expect(grid[0][6].isCurrentMonth).toBe(true);
  });

  it('all cells in the current month have isCurrentMonth true', async () => {
    const { buildMonthGrid } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    const grid = buildMonthGrid(2026, 1); // February 2026
    const allCells = grid.flat();
    const febCells = allCells.filter(c => c.date.startsWith('2026-02-'));
    expect(febCells.every(c => c.isCurrentMonth)).toBe(true);
    expect(febCells.length).toBe(28);
  });

  it('adjacent month cells have isCurrentMonth false', async () => {
    const { buildMonthGrid } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    const grid = buildMonthGrid(2026, 1);
    const allCells = grid.flat();
    const nonFebCells = allCells.filter(c => !c.date.startsWith('2026-02-'));
    expect(nonFebCells.every(c => !c.isCurrentMonth)).toBe(true);
  });

  it('handles January (adjacent December of previous year)', async () => {
    const { buildMonthGrid } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    const grid = buildMonthGrid(2026, 0); // January 2026
    const allCells = grid.flat();
    // Jan 1 2026 is a Thursday. Mon-start: first cell is Mon Dec 29 2025
    expect(grid[0][0].date).toBe('2025-12-29');
    expect(grid[0][0].isCurrentMonth).toBe(false);
  });

  it('handles December (adjacent January of next year)', async () => {
    const { buildMonthGrid } = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    const grid = buildMonthGrid(2025, 11); // December 2025
    const allCells = grid.flat();
    const janCells = allCells.filter(c => c.date.startsWith('2026-01-'));
    expect(janCells.length).toBeGreaterThan(0);
    expect(janCells.every(c => !c.isCurrentMonth)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Module smoke test
// ---------------------------------------------------------------------------

describe('CalendarPicker module', () => {
  it('exports CalendarPicker component', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    expect(mod.CalendarPicker).toBeDefined();
    expect(typeof mod.CalendarPicker).toBe('function');
  });

  it('exports getDaysInMonth', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    expect(typeof mod.getDaysInMonth).toBe('function');
  });

  it('exports buildMonthGrid', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/CalendarPicker.js'
    );
    expect(typeof mod.buildMonthGrid).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// CSS structural checks
// ---------------------------------------------------------------------------

describe('CalendarPicker CSS', () => {
  const cssSourceFile = new URL(
    '../../../src/ui/viewer-template.html',
    import.meta.url,
  ).pathname;

  let cssSource: string;
  try {
    cssSource = readFileSync(cssSourceFile, 'utf8');
  } catch {
    cssSource = '';
  }

  it('has .calendar-picker class in CSS', () => {
    expect(cssSource).toMatch(/\.calendar-picker\b/);
  });

  it('has .calendar-picker__header class in CSS', () => {
    expect(cssSource).toMatch(/\.calendar-picker__header/);
  });

  it('has .calendar-picker__grid class in CSS', () => {
    expect(cssSource).toMatch(/\.calendar-picker__grid/);
  });

  it('has .calendar-picker__day class in CSS', () => {
    expect(cssSource).toMatch(/\.calendar-picker__day\b/);
  });

  it('has .calendar-picker__day--active class in CSS', () => {
    expect(cssSource).toMatch(/\.calendar-picker__day--active/);
  });

  it('has .calendar-picker__day--today class in CSS', () => {
    expect(cssSource).toMatch(/\.calendar-picker__day--today/);
  });

  it('has .calendar-picker__day--selected class in CSS', () => {
    expect(cssSource).toMatch(/\.calendar-picker__day--selected/);
  });

  it('has .calendar-picker__day--disabled class in CSS', () => {
    expect(cssSource).toMatch(/\.calendar-picker__day--disabled/);
  });

  it('has .calendar-picker__day--other-month class in CSS', () => {
    expect(cssSource).toMatch(/\.calendar-picker__day--other-month/);
  });

  it('has .calendar-picker__dot class in CSS', () => {
    expect(cssSource).toMatch(/\.calendar-picker__dot/);
  });

  it('has .calendar-picker__reset class in CSS', () => {
    expect(cssSource).toMatch(/\.calendar-picker__reset/);
  });

  it('uses 7-column grid for the calendar', () => {
    const gridMatch = cssSource.match(/\.calendar-picker__grid\s*\{([^}]*)\}/s);
    expect(gridMatch).not.toBeNull();
    expect(gridMatch![1]).toMatch(/grid-template-columns.*repeat\(7/);
  });
});
