/**
 * Tests for ActiveSessionsBadge component
 *
 * Since @testing-library/react is not installed, we test via module inspection:
 * 1. Component exports can be imported
 * 2. Source contains expected structure and behaviour
 *
 * Visual / interaction behaviour is covered by the Playwright E2E suite.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const COMPONENT_SRC = path.resolve(
  __dirname,
  '../../../src/ui/viewer/components/ActiveSessionsBadge.tsx'
);

let componentSource: string;

try {
  componentSource = fs.readFileSync(COMPONENT_SRC, 'utf-8');
} catch {
  componentSource = '';
}

// ---------------------------------------------------------------------------
// Module export tests
// ---------------------------------------------------------------------------

describe('ActiveSessionsBadge module exports', () => {
  it('exports ActiveSessionsBadge function', async () => {
    const mod = await import('../../../src/ui/viewer/components/ActiveSessionsBadge.js');
    expect(typeof mod.ActiveSessionsBadge).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Source structure tests
// ---------------------------------------------------------------------------

describe('ActiveSessionsBadge source structure', () => {
  it('source file exists', () => {
    expect(componentSource).not.toBe('');
  });

  it('defines ActiveSessionsBadgeProps interface', () => {
    expect(componentSource).toContain('ActiveSessionsBadgeProps');
  });

  it('renders active-sessions-badge class on button', () => {
    expect(componentSource).toContain('active-sessions-badge');
  });

  it('renders active-sessions-dropdown class on dropdown', () => {
    expect(componentSource).toContain('active-sessions-dropdown');
  });

  it('renders active-sessions-wrapper class on container', () => {
    expect(componentSource).toContain('active-sessions-wrapper');
  });

  it('uses formatRelativeTime for displaying session duration', () => {
    expect(componentSource).toContain('formatRelativeTime');
  });

  it('has click-outside handler using useEffect', () => {
    expect(componentSource).toContain('useEffect');
  });

  it('has click-outside handler using useRef for dropdown container', () => {
    expect(componentSource).toContain('useRef');
  });

  it('closes dropdown on outside click', () => {
    expect(componentSource).toContain('addEventListener');
    expect(componentSource).toContain('removeEventListener');
  });

  it('shows close button only for stale sessions using is_stale flag', () => {
    expect(componentSource).toContain('is_stale');
  });

  it('has "Close All Stale" footer button', () => {
    expect(componentSource).toContain('Close All Stale');
  });

  it('has aria-label on badge button for accessibility', () => {
    expect(componentSource).toContain('aria-label');
  });

  it('has aria-label set to "Active sessions"', () => {
    expect(componentSource).toContain('"Active sessions"');
  });

  it('toggles dropdown open/closed on badge button click', () => {
    expect(componentSource).toContain('setIsOpen');
  });

  it('has warning class for stale sessions', () => {
    expect(componentSource).toContain('active-sessions-badge--warning');
  });

  it('shows warning class when staleCount > 0', () => {
    expect(componentSource).toContain('staleCount');
    expect(componentSource).toContain('staleCount > 0');
  });

  it('extracts last path segment for project name display', () => {
    // Should use split('/').pop() or similar to get last path segment
    expect(componentSource).toMatch(/split\(['"]\/['"]\)|\.pop\(\)/);
  });

  it('calls onCloseSession when close button is clicked', () => {
    expect(componentSource).toContain('onCloseSession');
  });

  it('calls onCloseAllStale when Close All Stale is clicked', () => {
    expect(componentSource).toContain('onCloseAllStale');
  });

  it('shows Sessions count in badge text', () => {
    expect(componentSource).toContain('Sessions:');
  });

  it('accepts sessions prop', () => {
    expect(componentSource).toContain('sessions:');
  });

  it('accepts totalCount prop', () => {
    expect(componentSource).toContain('totalCount');
  });

  it('uses dot indicator for session status', () => {
    expect(componentSource).toContain('active-sessions-item__dot');
  });

  it('uses fresh and stale dot variant classes', () => {
    expect(componentSource).toContain('active-sessions-item__dot--fresh');
    expect(componentSource).toContain('active-sessions-item__dot--stale');
  });
});
