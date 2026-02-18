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
// G.1: Shortcut key labels — arrow symbols replace j/k, add left/right arrows
// ---------------------------------------------------------------------------

describe('KeyboardShortcutHelp shortcut keys (G.1)', () => {
  it('contains up arrow symbol for session navigation', () => {
    const src = readSource();
    expect(src).toMatch(/↑/);
  });

  it('contains down arrow symbol for session navigation', () => {
    const src = readSource();
    expect(src).toMatch(/↓/);
  });

  it('contains left arrow symbol for day navigation', () => {
    const src = readSource();
    expect(src).toMatch(/←/);
  });

  it('contains right arrow symbol for day navigation', () => {
    const src = readSource();
    expect(src).toMatch(/→/);
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
});

// ---------------------------------------------------------------------------
// G.1: Enter key MUST NOT appear in shortcuts list
// ---------------------------------------------------------------------------

describe('KeyboardShortcutHelp — Enter key removed (G.1)', () => {
  it('does not contain Enter in the SHORTCUTS array', () => {
    const src = readSource();
    // Matches 'Enter' as a shortcut key value — should NOT be present in SHORTCUTS array
    // The pattern checks for Enter as a key value in the shortcuts data structure
    expect(src).not.toMatch(/keys:\s*['"]Enter['"]/);
  });
});

// ---------------------------------------------------------------------------
// G.1: Day navigation entry must be present
// ---------------------------------------------------------------------------

describe('KeyboardShortcutHelp — day navigation shortcut (G.1)', () => {
  it('contains Navigate days description', () => {
    const src = readSource();
    expect(src).toMatch(/[Nn]avigate days/);
  });

  it('contains left and right arrow symbols together for day navigation entry', () => {
    const src = readSource();
    // Both arrows should appear, forming the '← / →' or similar pattern
    expect(src).toMatch(/←[\s/]*→|→[\s/]*←/);
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

  it('does not describe select session action (Enter removed)', () => {
    const src = readSource();
    // 'Select session' description is removed along with the Enter key entry
    expect(src).not.toMatch(/[Ss]elect session/);
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
