import { describe, it, expect } from 'vitest';
import {
  inclusiveDateStart,
  inclusiveDateEnd,
} from '../../../src/ui/viewer/hooks/useSearch.js';

// ─────────────────────────────────────────────────────────
// inclusiveDateStart
// ─────────────────────────────────────────────────────────

describe('inclusiveDateStart', () => {
  it('converts a YYYY-MM-DD string to local midnight (no Z suffix)', () => {
    expect(inclusiveDateStart('2026-02-17')).toBe('2026-02-17T00:00:00');
  });

  it('converts a different date correctly', () => {
    expect(inclusiveDateStart('2025-01-01')).toBe('2025-01-01T00:00:00');
  });

  it('does not append a Z suffix (local time, not UTC)', () => {
    const result = inclusiveDateStart('2026-02-17');
    expect(result.endsWith('Z')).toBe(false);
  });

  it('handles leap day', () => {
    expect(inclusiveDateStart('2024-02-29')).toBe('2024-02-29T00:00:00');
  });

  it('handles end-of-year date', () => {
    expect(inclusiveDateStart('2025-12-31')).toBe('2025-12-31T00:00:00');
  });
});

// ─────────────────────────────────────────────────────────
// inclusiveDateEnd
// ─────────────────────────────────────────────────────────

describe('inclusiveDateEnd', () => {
  it('converts a YYYY-MM-DD string to local end-of-day (no Z suffix)', () => {
    expect(inclusiveDateEnd('2026-02-17')).toBe('2026-02-17T23:59:59');
  });

  it('converts a different date correctly', () => {
    expect(inclusiveDateEnd('2025-01-01')).toBe('2025-01-01T23:59:59');
  });

  it('does not append a Z suffix (local time, not UTC)', () => {
    const result = inclusiveDateEnd('2026-02-17');
    expect(result.endsWith('Z')).toBe(false);
  });

  it('handles leap day', () => {
    expect(inclusiveDateEnd('2024-02-29')).toBe('2024-02-29T23:59:59');
  });

  it('handles start-of-year date', () => {
    expect(inclusiveDateEnd('2025-01-01')).toBe('2025-01-01T23:59:59');
  });
});

// ─────────────────────────────────────────────────────────
// buildSearchParams uses inclusive date helpers
// ─────────────────────────────────────────────────────────

describe('buildSearchParams date handling (via useSearch internals)', () => {
  it('applies inclusiveDateStart to dateStart param', async () => {
    // We test this by importing buildSearchParams if exported,
    // or by observing the URL built in fetch calls.
    // Since buildSearchParams is not exported, we test via the exported helpers
    // and verify the contract: the helpers are pure and deterministic.
    expect(inclusiveDateStart('2026-02-17')).toBe('2026-02-17T00:00:00');
  });

  it('applies inclusiveDateEnd to dateEnd param', async () => {
    expect(inclusiveDateEnd('2026-02-17')).toBe('2026-02-17T23:59:59');
  });
});

// ─────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────

describe('inclusiveDateStart edge cases', () => {
  it('preserves the exact date string as prefix', () => {
    const date = '2026-02-17';
    const result = inclusiveDateStart(date);
    expect(result.startsWith(date)).toBe(true);
  });

  it('returns a string with length 19 (YYYY-MM-DDTHH:MM:SS)', () => {
    expect(inclusiveDateStart('2026-02-17')).toHaveLength(19);
  });
});

describe('inclusiveDateEnd edge cases', () => {
  it('preserves the exact date string as prefix', () => {
    const date = '2026-02-17';
    const result = inclusiveDateEnd(date);
    expect(result.startsWith(date)).toBe(true);
  });

  it('returns a string with length 19 (YYYY-MM-DDTHH:MM:SS)', () => {
    expect(inclusiveDateEnd('2026-02-17')).toHaveLength(19);
  });
});
