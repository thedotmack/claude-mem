/**
 * Tests for SessionList component
 *
 * Since @testing-library/react is not installed (vitest runs without a browser),
 * we test:
 * 1. formatSessionTime - the pure time-formatting utility used by SessionList
 * 2. The component module can be imported without errors (smoke test)
 *
 * Visual / interaction behaviour (IntersectionObserver, click handlers, CSS) is
 * covered by the Playwright E2E suite (tests/ui/viewer.spec.ts).
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pure helper: formatSessionTime
// ---------------------------------------------------------------------------

/**
 * The component exports a formatSessionTime function that converts an epoch
 * (milliseconds) to "HH:mm" using local time.  We import it once the
 * implementation exists.
 */

describe('formatSessionTime', () => {
  it('formats epoch to HH:mm', async () => {
    const { formatSessionTime } = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );

    // Use a fixed local timestamp.  We construct it from local Date parts so
    // the assertion is timezone-independent.
    const d = new Date(2026, 1, 17, 14, 30, 0); // Feb 17 2026 14:30 local
    const result = formatSessionTime(d.getTime());
    expect(result).toBe('14:30');
  });

  it('pads single-digit hours and minutes', async () => {
    const { formatSessionTime } = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );

    const d = new Date(2026, 1, 17, 9, 5, 0); // 09:05
    const result = formatSessionTime(d.getTime());
    expect(result).toBe('09:05');
  });

  it('handles midnight (00:00)', async () => {
    const { formatSessionTime } = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );

    const d = new Date(2026, 1, 17, 0, 0, 0);
    const result = formatSessionTime(d.getTime());
    expect(result).toBe('00:00');
  });

  it('handles end of day (23:59)', async () => {
    const { formatSessionTime } = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );

    const d = new Date(2026, 1, 17, 23, 59, 0);
    const result = formatSessionTime(d.getTime());
    expect(result).toBe('23:59');
  });
});

// ---------------------------------------------------------------------------
// Component import smoke test
// ---------------------------------------------------------------------------

describe('SessionList component module', () => {
  it('exports a SessionList function component', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );
    expect(typeof mod.SessionList).toBe('function');
  });

  it('exports formatSessionTime as a function', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );
    expect(typeof mod.formatSessionTime).toBe('function');
  });
});
