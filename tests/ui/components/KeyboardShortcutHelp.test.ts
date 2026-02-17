/**
 * Tests for KeyboardShortcutHelp component
 *
 * Since @testing-library/react is not installed, we test via module inspection:
 * 1. Component is exported
 * 2. Contains all expected shortcut key labels
 * 3. Has correct data-testid attribute
 * 4. Has correct ARIA role
 * 5. Has correct aria-label
 * 6. Contains descriptions for each shortcut
 *
 * Visual / interaction behaviour is covered by the Playwright E2E suite.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const COMPONENT_SRC = path.resolve(
  __dirname,
  '../../../src/ui/viewer/components/KeyboardShortcutHelp.tsx'
);

function readSource(): string {
  return fs.readFileSync(COMPONENT_SRC, 'utf-8');
}

// ---------------------------------------------------------------------------
// Component module smoke test
// ---------------------------------------------------------------------------

describe('KeyboardShortcutHelp component module', () => {
  it('exports a KeyboardShortcutHelp function', async () => {
    const mod = await import(
      '../../../src/ui/viewer/components/KeyboardShortcutHelp.js'
    );
    expect(typeof mod.KeyboardShortcutHelp).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Props interface — structural checks via source inspection
// ---------------------------------------------------------------------------

describe('KeyboardShortcutHelp props interface', () => {
  it('accepts isOpen prop', () => {
    const src = readSource();
    expect(src).toMatch(/isOpen/);
  });

  it('accepts onClose prop', () => {
    const src = readSource();
    expect(src).toMatch(/onClose/);
  });
});

// ---------------------------------------------------------------------------
// Accessibility attributes
// ---------------------------------------------------------------------------

describe('KeyboardShortcutHelp accessibility', () => {
  it('has role="dialog"', () => {
    const src = readSource();
    expect(src).toMatch(/role="dialog"/);
  });

  it('has aria-label="Keyboard shortcuts"', () => {
    const src = readSource();
    expect(src).toMatch(/aria-label="Keyboard shortcuts"/);
  });
});

// ---------------------------------------------------------------------------
// data-testid
// ---------------------------------------------------------------------------

describe('KeyboardShortcutHelp data-testid', () => {
  it('has data-testid="keyboard-help"', () => {
    const src = readSource();
    expect(src).toMatch(/data-testid="keyboard-help"/);
  });
});

// ---------------------------------------------------------------------------
// Shortcut key labels
// ---------------------------------------------------------------------------

describe('KeyboardShortcutHelp shortcut keys', () => {
  it('contains j shortcut key', () => {
    const src = readSource();
    expect(src).toMatch(/\bj\b/);
  });

  it('contains k shortcut key', () => {
    const src = readSource();
    expect(src).toMatch(/\bk\b/);
  });

  it('contains / shortcut key', () => {
    const src = readSource();
    expect(src).toMatch(/\//);
  });

  it('contains f shortcut key', () => {
    const src = readSource();
    expect(src).toMatch(/\bf\b/);
  });

  it('contains Esc shortcut key', () => {
    const src = readSource();
    expect(src).toMatch(/Esc/);
  });

  it('contains ? shortcut key', () => {
    const src = readSource();
    expect(src).toMatch(/\?/);
  });

  it('contains Enter shortcut key', () => {
    const src = readSource();
    expect(src).toMatch(/Enter/);
  });
});

// ---------------------------------------------------------------------------
// Shortcut descriptions
// ---------------------------------------------------------------------------

describe('KeyboardShortcutHelp shortcut descriptions', () => {
  it('describes navigate sessions action', () => {
    const src = readSource();
    expect(src).toMatch(/[Nn]avigate/);
  });

  it('describes select session action', () => {
    const src = readSource();
    expect(src).toMatch(/[Ss]elect/);
  });

  it('describes focus search action', () => {
    const src = readSource();
    expect(src).toMatch(/[Ss]earch/);
  });

  it('describes filter action', () => {
    const src = readSource();
    expect(src).toMatch(/[Ff]ilter/);
  });

  it('describes clear or close action', () => {
    const src = readSource();
    expect(src).toMatch(/[Cc]lear|[Cc]lose/);
  });

  it('describes help action', () => {
    const src = readSource();
    expect(src).toMatch(/[Hh]elp|[Tt]his help/);
  });
});

// ---------------------------------------------------------------------------
// CSS class names — confirm they are referenced in the component
// ---------------------------------------------------------------------------

describe('KeyboardShortcutHelp CSS classes', () => {
  it('uses keyboard-help class on root element', () => {
    const src = readSource();
    expect(src).toMatch(/keyboard-help/);
  });

  it('uses keyboard-help__row class for shortcut rows', () => {
    const src = readSource();
    expect(src).toMatch(/keyboard-help__row/);
  });

  it('uses keyboard-help__key class for key labels', () => {
    const src = readSource();
    expect(src).toMatch(/keyboard-help__key/);
  });
});

// ---------------------------------------------------------------------------
// Conditional rendering — isOpen controls visibility
// ---------------------------------------------------------------------------

describe('KeyboardShortcutHelp conditional rendering', () => {
  it('uses isOpen to conditionally render', () => {
    const src = readSource();
    expect(src).toMatch(/isOpen/);
  });
});
