/**
 * Tests for SessionList component
 *
 * Since @testing-library/react is not installed (vitest runs without a browser),
 * we test:
 * 1. formatSessionTime - the pure time-formatting utility used by SessionList
 * 2. The component module can be imported without errors (smoke test)
 * 3. flattenGroups - pure function for virtual list flattening
 * 4. VIRTUAL_THRESHOLD - constant for virtualization cutoff
 * 5. Source-code-based checks for virtualization integration
 *
 * Visual / interaction behaviour (IntersectionObserver, click handlers, CSS) is
 * covered by the Playwright E2E suite (tests/ui/viewer.spec.ts).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

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

// ---------------------------------------------------------------------------
// VIRTUAL_THRESHOLD constant
// ---------------------------------------------------------------------------

describe('VIRTUAL_THRESHOLD', () => {
  it('exports VIRTUAL_THRESHOLD equal to 100', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );
    expect(mod.VIRTUAL_THRESHOLD).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// flattenGroups pure function
// ---------------------------------------------------------------------------

describe('flattenGroups', () => {
  it('returns empty array for empty groups', async () => {
    const { flattenGroups } = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );

    const result = flattenGroups([], null);
    expect(result).toEqual([]);
  });

  it('flattens a single group with its header and sessions', async () => {
    const { flattenGroups } = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );

    const groups = [
      {
        label: 'Today',
        dateKey: '2026-02-17',
        sessions: [
          { id: 1, session_id: 'abc', project: 'p', observationCount: 3, created_at_epoch: 1000, status: 'completed' as const },
          { id: 2, session_id: 'def', project: 'p', observationCount: 5, created_at_epoch: 2000, status: 'active' as const },
        ],
      },
    ];

    const result = flattenGroups(groups, null);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: 'header', label: 'Today', dateKey: '2026-02-17' });
    expect(result[1]).toMatchObject({ type: 'session', session: groups[0].sessions[0], isSelected: false });
    expect(result[2]).toMatchObject({ type: 'session', session: groups[0].sessions[1], isSelected: false });
  });

  it('flattens multiple groups preserving order', async () => {
    const { flattenGroups } = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );

    const groups = [
      {
        label: 'Today',
        dateKey: '2026-02-17',
        sessions: [
          { id: 1, session_id: 'a', project: 'p', observationCount: 1, created_at_epoch: 1000, status: 'completed' as const },
        ],
      },
      {
        label: 'Yesterday',
        dateKey: '2026-02-16',
        sessions: [
          { id: 2, session_id: 'b', project: 'p', observationCount: 2, created_at_epoch: 900, status: 'completed' as const },
          { id: 3, session_id: 'c', project: 'p', observationCount: 3, created_at_epoch: 800, status: 'completed' as const },
        ],
      },
    ];

    const result = flattenGroups(groups, null);

    expect(result).toHaveLength(5); // 2 headers + 3 sessions
    expect(result[0]).toMatchObject({ type: 'header', label: 'Today' });
    expect(result[1]).toMatchObject({ type: 'session', session: groups[0].sessions[0] });
    expect(result[2]).toMatchObject({ type: 'header', label: 'Yesterday' });
    expect(result[3]).toMatchObject({ type: 'session', session: groups[1].sessions[0] });
    expect(result[4]).toMatchObject({ type: 'session', session: groups[1].sessions[1] });
  });

  it('marks the selected session with isSelected true', async () => {
    const { flattenGroups } = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );

    const groups = [
      {
        label: 'Today',
        dateKey: '2026-02-17',
        sessions: [
          { id: 10, session_id: 'a', project: 'p', observationCount: 1, created_at_epoch: 1000, status: 'completed' as const },
          { id: 20, session_id: 'b', project: 'p', observationCount: 2, created_at_epoch: 2000, status: 'completed' as const },
        ],
      },
    ];

    const result = flattenGroups(groups, 20);

    expect(result[1]).toMatchObject({ type: 'session', isSelected: false }); // id 10
    expect(result[2]).toMatchObject({ type: 'session', isSelected: true });  // id 20
  });

  it('handles groups with no sessions (only header emitted)', async () => {
    const { flattenGroups } = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );

    const groups = [
      { label: 'Empty Day', dateKey: '2026-02-15', sessions: [] },
    ];

    const result = flattenGroups(groups, null);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'header', label: 'Empty Day' });
  });

  it('does not mutate the input groups array', async () => {
    const { flattenGroups } = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );

    const sessions = [
      { id: 1, session_id: 'a', project: 'p', observationCount: 1, created_at_epoch: 1000, status: 'completed' as const },
    ];
    const groups = [{ label: 'Today', dateKey: '2026-02-17', sessions }];
    const originalLength = groups.length;

    flattenGroups(groups, null);

    expect(groups.length).toBe(originalLength);
    expect(groups[0].sessions).toBe(sessions);
  });
});

// ---------------------------------------------------------------------------
// Source-code-based checks: virtualization integration
// ---------------------------------------------------------------------------

describe('SessionList source-code virtualization checks', () => {
  const sourceFile = join(
    import.meta.dirname ?? new URL('.', import.meta.url).pathname,
    '../../../src/ui/viewer/components/SessionList.tsx'
  );

  let source: string;
  try {
    source = readFileSync(sourceFile, 'utf8');
  } catch {
    source = '';
  }

  it('imports useVirtualizer from @tanstack/react-virtual', () => {
    expect(source).toMatch(/useVirtualizer/);
    expect(source).toMatch(/@tanstack\/react-virtual/);
  });

  it('uses measureElement for accurate item sizing', () => {
    expect(source).toMatch(/measureElement/);
  });

  it('checks total session count against VIRTUAL_THRESHOLD', () => {
    // The component should compare total sessions count to VIRTUAL_THRESHOLD
    expect(source).toMatch(/VIRTUAL_THRESHOLD/);
    expect(source).toMatch(/>\s*VIRTUAL_THRESHOLD|totalCount\s*>/);
  });

  it('uses position sticky for virtual day headers', () => {
    // The source or CSS should reference sticky positioning for headers
    // In the component source, the virtual header items should apply sticky style
    expect(source).toMatch(/sticky/);
  });
});
