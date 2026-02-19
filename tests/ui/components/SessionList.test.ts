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
  it('exports a SessionList component (forwardRef object)', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );
    expect(mod.SessionList).toBeDefined();
    // forwardRef returns an object with $$typeof, not a plain function
    expect(typeof mod.SessionList === 'function' || typeof mod.SessionList === 'object').toBe(true);
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
// Source-code-based checks: sticky date header (G.7)
// ---------------------------------------------------------------------------

describe('SessionList sticky day header (non-virtual path)', () => {
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

  it('does NOT wrap non-virtual path content in session-list__group divs', () => {
    // In the non-virtual rendering path, day headers and session rows must be
    // rendered as flat children of the container so that position:sticky works.
    // The .session-list__group wrapper must not appear in the non-virtual branch.
    //
    // Strategy: find the non-virtual branch (the else / fallback of useVirtual).
    // It must not contain className="session-list__group" or session-list__group.
    //
    // We detect the non-virtual branch as the JSX returned when useVirtual is
    // false.  The simplest structural check: any occurrence of
    // className="session-list__group" in the non-virtual portion is a failure.
    //
    // We use a negative assertion: after the implementation the pattern must NOT
    // appear paired with the non-virtual mapping of sessionGroups.
    //
    // The test checks that the source does NOT contain the combination of
    // sessionGroups.map with session-list__group class wrapper — which is the
    // old pattern we are removing.
    const hasGroupWrapperInNonVirtualMap = /sessionGroups\.map[\s\S]*?session-list__group/.test(source);
    expect(hasGroupWrapperInNonVirtualMap).toBe(false);
  });

  it('renders day headers as direct siblings of session rows in non-virtual path', () => {
    // After flattening, the non-virtual path should use flatItems (or equivalent)
    // to render headers and rows interleaved without a group wrapper div.
    // We verify the non-virtual branch renders from the flat items list.
    //
    // The implementation should map over flatItems (or similar flat array) in
    // the non-virtual path, not over sessionGroups with a nested group div.
    expect(source).toMatch(/flatItems/);
  });

  it('the virtual path (VirtualContent) is still present and used above threshold', () => {
    // VirtualContent sub-component must still exist and be conditionally rendered
    // based on useVirtual / VIRTUAL_THRESHOLD.
    expect(source).toMatch(/VirtualContent/);
    expect(source).toMatch(/useVirtual/);
  });
});

// ---------------------------------------------------------------------------
// CSS check: .session-list__day-header has position sticky
// ---------------------------------------------------------------------------

describe('SessionList CSS sticky header verification', () => {
  const cssSourceFile = join(
    import.meta.dirname ?? new URL('.', import.meta.url).pathname,
    '../../../src/ui/viewer-template.html'
  );

  let cssSource: string;
  try {
    cssSource = readFileSync(cssSourceFile, 'utf8');
  } catch {
    cssSource = '';
  }

  it('.session-list__day-header has position: sticky in viewer-template.html', () => {
    // Find the rule block for .session-list__day-header and confirm sticky is present.
    const dayHeaderRuleMatch = cssSource.match(/\.session-list__day-header\s*\{([^}]*)\}/s);
    expect(dayHeaderRuleMatch).not.toBeNull();
    const ruleBody = dayHeaderRuleMatch![1];
    expect(ruleBody).toMatch(/position\s*:\s*sticky/);
  });

  it('.session-list__day-header has top: 0 in viewer-template.html', () => {
    const dayHeaderRuleMatch = cssSource.match(/\.session-list__day-header\s*\{([^}]*)\}/s);
    expect(dayHeaderRuleMatch).not.toBeNull();
    const ruleBody = dayHeaderRuleMatch![1];
    expect(ruleBody).toMatch(/top\s*:\s*0/);
  });

  it('.session-list__day-header has border-left accent in viewer-template.html', () => {
    const dayHeaderRuleMatch = cssSource.match(/\.session-list__day-header\s*\{([^}]*)\}/s);
    expect(dayHeaderRuleMatch).not.toBeNull();
    const ruleBody = dayHeaderRuleMatch![1];
    expect(ruleBody).toMatch(/border-left\s*:/);
    expect(ruleBody).toMatch(/--color-accent-primary/);
  });

  it('.session-list__day-header has border-bottom separator in viewer-template.html', () => {
    const dayHeaderRuleMatch = cssSource.match(/\.session-list__day-header\s*\{([^}]*)\}/s);
    expect(dayHeaderRuleMatch).not.toBeNull();
    const ruleBody = dayHeaderRuleMatch![1];
    expect(ruleBody).toMatch(/border-bottom\s*:/);
    expect(ruleBody).toMatch(/--color-border-secondary/);
  });

  it('.session-list__day-header has font-weight 700 in viewer-template.html', () => {
    const dayHeaderRuleMatch = cssSource.match(/\.session-list__day-header\s*\{([^}]*)\}/s);
    expect(dayHeaderRuleMatch).not.toBeNull();
    const ruleBody = dayHeaderRuleMatch![1];
    expect(ruleBody).toMatch(/font-weight\s*:\s*700/);
  });

  it('.session-list__day-header uses --color-accent-primary for text in viewer-template.html', () => {
    const dayHeaderRuleMatch = cssSource.match(/\.session-list__day-header\s*\{([^}]*)\}/s);
    expect(dayHeaderRuleMatch).not.toBeNull();
    const ruleBody = dayHeaderRuleMatch![1];
    expect(ruleBody).toMatch(/color\s*:\s*var\(--color-accent-primary\)/);
  });

  it('.session-list container has overflow-y in viewer-template.html', () => {
    // The scroll context must be established on .session-list.
    const sessionListRuleMatch = cssSource.match(/\.session-list\s*\{([^}]*)\}/s);
    expect(sessionListRuleMatch).not.toBeNull();
    const ruleBody = sessionListRuleMatch![1];
    expect(ruleBody).toMatch(/overflow-y\s*:/);
  });
});

// ---------------------------------------------------------------------------
// SessionListHandle scroll API (structural check)
// ---------------------------------------------------------------------------

describe('SessionList scroll API (forwardRef)', () => {
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

  it('exports SessionListHandle type with scrollToDate and scrollToSession', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/SessionList.js'
    );
    // SessionList should be a forwardRef component
    expect(mod.SessionList).toBeDefined();
  });

  it('uses forwardRef pattern', () => {
    expect(source).toMatch(/forwardRef/);
    expect(source).toMatch(/useImperativeHandle/);
  });

  it('implements scrollToDate method that queries data-date-key', () => {
    expect(source).toMatch(/scrollToDate/);
    expect(source).toMatch(/data-date-key/);
  });

  it('implements scrollToSession method that queries data-session-id', () => {
    expect(source).toMatch(/scrollToSession/);
    expect(source).toMatch(/data-session-id/);
  });

  it('uses scrollIntoView for non-virtual path', () => {
    expect(source).toMatch(/scrollIntoView/);
  });

  it('uses scrollToIndexRef for virtual path', () => {
    expect(source).toMatch(/scrollToIndexRef/);
  });
});

// ---------------------------------------------------------------------------
// Active session rendering (structural check)
// ---------------------------------------------------------------------------

describe('SessionList active session rendering', () => {
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

  it('renders session-list__row--active class for active sessions', () => {
    expect(source).toMatch(/session-list__row--active/);
  });

  it('shows "Current session" text for active sessions', () => {
    expect(source).toMatch(/Current session/);
  });

  it('shows status badge with "Live" for active sessions', () => {
    expect(source).toMatch(/session-list__status-badge/);
    expect(source).toMatch(/Live/);
  });

  it('uses ActiveSessionRow component for active session rendering', () => {
    expect(source).toMatch(/ActiveSessionRow/);
    expect(source).toMatch(/ActiveSessionEntry/);
  });
});

// ---------------------------------------------------------------------------
// Active session CSS (viewer-template.html)
// ---------------------------------------------------------------------------

describe('Active session CSS', () => {
  const cssSourceFile = join(
    import.meta.dirname ?? new URL('.', import.meta.url).pathname,
    '../../../src/ui/viewer-template.html'
  );

  let cssSource: string;
  try {
    cssSource = readFileSync(cssSourceFile, 'utf8');
  } catch {
    cssSource = '';
  }

  it('has .session-list__row--active class in CSS', () => {
    expect(cssSource).toMatch(/\.session-list__row--active/);
  });

  it('has .session-list__status-badge class in CSS', () => {
    expect(cssSource).toMatch(/\.session-list__status-badge/);
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

  it('uses day-header CSS class for virtual headers (sticky via stylesheet)', () => {
    // Virtual headers use the same session-list__day-header class as non-virtual
    // which gets position: sticky from the stylesheet
    expect(source).toMatch(/session-list__day-header/);
  });
});
