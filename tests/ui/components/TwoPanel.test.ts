/**
 * Tests for TwoPanel layout component
 *
 * Since @testing-library/react is not installed, we test:
 * 1. findSessionById — the pure lookup utility used by TwoPanel
 * 2. Component module can be imported without errors (smoke test)
 *
 * Visual / interaction behaviour (panel widths, responsive collapse,
 * session selection flow) is covered by the Playwright E2E suite.
 */

import { describe, it, expect } from 'vitest';
import type { SessionGroup } from '../../../src/ui/viewer/types';

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeGroup(dateKey: string, sessions: Array<{ id: number; session_id: string }>): SessionGroup {
  return {
    label: dateKey === '2026-02-17' ? 'Today' : dateKey,
    dateKey,
    sessions: sessions.map(s => ({
      id: s.id,
      session_id: s.session_id,
      project: 'test-project',
      request: `Session ${s.id}`,
      observationCount: 3,
      created_at_epoch: Date.now(),
      status: 'completed' as const,
    })),
  };
}

// ---------------------------------------------------------------------------
// Pure helper: findSessionById
// ---------------------------------------------------------------------------

describe('findSessionById', () => {
  it('returns the matching session from groups', async () => {
    const { findSessionById } = await import(
      '../../../src/ui/viewer/components/TwoPanel.js'
    );

    const groups: SessionGroup[] = [
      makeGroup('2026-02-17', [
        { id: 1, session_id: 'sess-aaa' },
        { id: 2, session_id: 'sess-bbb' },
      ]),
      makeGroup('2026-02-16', [
        { id: 3, session_id: 'sess-ccc' },
      ]),
    ];

    const result = findSessionById(groups, 2);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(2);
    expect(result!.session_id).toBe('sess-bbb');
  });

  it('returns null when id is null', async () => {
    const { findSessionById } = await import(
      '../../../src/ui/viewer/components/TwoPanel.js'
    );

    const groups: SessionGroup[] = [
      makeGroup('2026-02-17', [{ id: 1, session_id: 'sess-aaa' }]),
    ];

    expect(findSessionById(groups, null)).toBeNull();
  });

  it('returns null when id is not found', async () => {
    const { findSessionById } = await import(
      '../../../src/ui/viewer/components/TwoPanel.js'
    );

    const groups: SessionGroup[] = [
      makeGroup('2026-02-17', [{ id: 1, session_id: 'sess-aaa' }]),
    ];

    expect(findSessionById(groups, 999)).toBeNull();
  });

  it('returns null for empty groups', async () => {
    const { findSessionById } = await import(
      '../../../src/ui/viewer/components/TwoPanel.js'
    );

    expect(findSessionById([], 1)).toBeNull();
  });

  it('finds session in last group when multiple groups exist', async () => {
    const { findSessionById } = await import(
      '../../../src/ui/viewer/components/TwoPanel.js'
    );

    const groups: SessionGroup[] = [
      makeGroup('2026-02-17', [{ id: 1, session_id: 'sess-aaa' }]),
      makeGroup('2026-02-16', [{ id: 2, session_id: 'sess-bbb' }]),
      makeGroup('2026-02-15', [{ id: 3, session_id: 'sess-ccc' }]),
    ];

    const result = findSessionById(groups, 3);
    expect(result).not.toBeNull();
    expect(result!.session_id).toBe('sess-ccc');
  });
});

// ---------------------------------------------------------------------------
// Component import smoke test
// ---------------------------------------------------------------------------

describe('TwoPanel component module', () => {
  it('exports a TwoPanel component (forwardRef)', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TwoPanel.js'
    );
    // forwardRef wraps the component as an object with $$typeof and render
    expect(mod.TwoPanel).toBeDefined();
    expect(typeof mod.TwoPanel === 'function' || typeof mod.TwoPanel === 'object').toBe(true);
  });

  it('exports findSessionById as a function', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/TwoPanel.js'
    );
    expect(typeof mod.findSessionById).toBe('function');
  });
});
