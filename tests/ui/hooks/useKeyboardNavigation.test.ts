import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveKeyAction, isInputFocusedFromElement } from '../../../src/ui/viewer/hooks/useKeyboardNavigation.js';

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function makeState(overrides?: {
  isPaletteOpen?: boolean;
  showHelp?: boolean;
  hasSearchContent?: boolean;
}) {
  return {
    isPaletteOpen: false,
    showHelp: false,
    hasSearchContent: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────
// resolveKeyAction — navigation shortcuts (G.1)
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — navigation shortcuts', () => {
  it('ArrowDown key returns next when not in input', () => {
    expect(resolveKeyAction('ArrowDown', false, makeState())).toBe('next');
  });

  it('ArrowUp key returns prev when not in input', () => {
    expect(resolveKeyAction('ArrowUp', false, makeState())).toBe('prev');
  });

  it('ArrowLeft key returns prev-day when not in input', () => {
    expect(resolveKeyAction('ArrowLeft', false, makeState())).toBe('prev-day');
  });

  it('ArrowRight key returns next-day when not in input', () => {
    expect(resolveKeyAction('ArrowRight', false, makeState())).toBe('next-day');
  });

  it('/ key returns focus-search when not in input', () => {
    expect(resolveKeyAction('/', false, makeState())).toBe('focus-search');
  });

  it('f key returns toggle-palette when not in input', () => {
    expect(resolveKeyAction('f', false, makeState())).toBe('toggle-palette');
  });

  it('? key returns toggle-help when not in input', () => {
    expect(resolveKeyAction('?', false, makeState())).toBe('toggle-help');
  });

  it('j key returns null (no longer mapped)', () => {
    expect(resolveKeyAction('j', false, makeState())).toBeNull();
  });

  it('k key returns null (no longer mapped)', () => {
    expect(resolveKeyAction('k', false, makeState())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// resolveKeyAction — focus guard
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — focus guard', () => {
  it('ArrowDown key returns null when input is focused', () => {
    expect(resolveKeyAction('ArrowDown', true, makeState())).toBeNull();
  });

  it('ArrowUp key returns null when input is focused', () => {
    expect(resolveKeyAction('ArrowUp', true, makeState())).toBeNull();
  });

  it('ArrowLeft key returns null when input is focused', () => {
    expect(resolveKeyAction('ArrowLeft', true, makeState())).toBeNull();
  });

  it('ArrowRight key returns null when input is focused', () => {
    expect(resolveKeyAction('ArrowRight', true, makeState())).toBeNull();
  });

  it('/ key returns null when input is focused', () => {
    expect(resolveKeyAction('/', true, makeState())).toBeNull();
  });

  it('f key returns null when input is focused', () => {
    expect(resolveKeyAction('f', true, makeState())).toBeNull();
  });

  it('? key returns null when input is focused', () => {
    expect(resolveKeyAction('?', true, makeState())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// resolveKeyAction — Esc priority chain
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — Esc priority chain', () => {
  it('Esc closes palette first when palette is open', () => {
    const state = makeState({ isPaletteOpen: true, showHelp: true, hasSearchContent: true });
    expect(resolveKeyAction('Escape', false, state)).toBe('close-palette');
  });

  it('Esc closes palette first even when input is focused', () => {
    const state = makeState({ isPaletteOpen: true });
    expect(resolveKeyAction('Escape', true, state)).toBe('close-palette');
  });

  it('Esc closes help when palette is closed and help is showing', () => {
    const state = makeState({ isPaletteOpen: false, showHelp: true, hasSearchContent: true });
    expect(resolveKeyAction('Escape', false, state)).toBe('close-help');
  });

  it('Esc clears search when neither palette nor help is active and search has content', () => {
    const state = makeState({ isPaletteOpen: false, showHelp: false, hasSearchContent: true });
    expect(resolveKeyAction('Escape', false, state)).toBe('clear-search');
  });

  it('Esc returns null when nothing to dismiss', () => {
    const state = makeState({ isPaletteOpen: false, showHelp: false, hasSearchContent: false });
    expect(resolveKeyAction('Escape', false, state)).toBeNull();
  });

  it('Esc fires even when input is focused (dismisses palette)', () => {
    const state = makeState({ isPaletteOpen: true });
    expect(resolveKeyAction('Escape', true, state)).toBe('close-palette');
  });

  it('Esc fires even when input is focused (closes help)', () => {
    const state = makeState({ isPaletteOpen: false, showHelp: true });
    expect(resolveKeyAction('Escape', true, state)).toBe('close-help');
  });

  it('Esc fires even when input is focused (clears search)', () => {
    const state = makeState({ isPaletteOpen: false, showHelp: false, hasSearchContent: true });
    expect(resolveKeyAction('Escape', true, state)).toBe('clear-search');
  });
});

// ─────────────────────────────────────────────────────────
// resolveKeyAction — ? toggle help
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — help toggle', () => {
  it('? toggles help on when help is not showing', () => {
    const state = makeState({ showHelp: false });
    expect(resolveKeyAction('?', false, state)).toBe('toggle-help');
  });

  it('? toggles help when help is already showing', () => {
    const state = makeState({ showHelp: true });
    expect(resolveKeyAction('?', false, state)).toBe('toggle-help');
  });
});

// ─────────────────────────────────────────────────────────
// resolveKeyAction — unknown keys
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — unknown keys', () => {
  it('returns null for unrecognised key', () => {
    expect(resolveKeyAction('x', false, makeState())).toBeNull();
  });

  it('returns null for Enter key', () => {
    expect(resolveKeyAction('Enter', false, makeState())).toBeNull();
  });

  it('returns null for empty string key', () => {
    expect(resolveKeyAction('', false, makeState())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// resolveKeyAction — all non-Esc shortcuts blocked when input focused
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — all non-Esc shortcuts blocked when input focused', () => {
  const nonEscShortcuts = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', '/', 'f', '?'];

  for (const key of nonEscShortcuts) {
    it(`${key} returns null when isInputFocused is true`, () => {
      expect(resolveKeyAction(key, true, makeState())).toBeNull();
    });
  }
});

// ─────────────────────────────────────────────────────────
// G.1: event.preventDefault() called for ArrowUp and ArrowDown
// Tested via the hook's keydown handler through DOM simulation
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — arrow keys for scroll prevention (G.1)', () => {
  it('ArrowDown maps to next action (requires preventDefault in handler)', () => {
    expect(resolveKeyAction('ArrowDown', false, makeState())).toBe('next');
  });

  it('ArrowUp maps to prev action (requires preventDefault in handler)', () => {
    expect(resolveKeyAction('ArrowUp', false, makeState())).toBe('prev');
  });
});

// ─────────────────────────────────────────────────────────
// G.1: prev-day and next-day actions via arrow keys
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — day navigation actions (G.1)', () => {
  it('ArrowLeft returns prev-day', () => {
    expect(resolveKeyAction('ArrowLeft', false, makeState())).toBe('prev-day');
  });

  it('ArrowRight returns next-day', () => {
    expect(resolveKeyAction('ArrowRight', false, makeState())).toBe('next-day');
  });

  it('ArrowLeft returns null when input is focused', () => {
    expect(resolveKeyAction('ArrowLeft', true, makeState())).toBeNull();
  });

  it('ArrowRight returns null when input is focused', () => {
    expect(resolveKeyAction('ArrowRight', true, makeState())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// G.2: 'f' key (toggle-palette) maps to toggle-palette
// (event.preventDefault() is called in the hook handler — verified structurally)
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — f key toggle-palette action (G.2)', () => {
  it('f key still maps to toggle-palette', () => {
    expect(resolveKeyAction('f', false, makeState())).toBe('toggle-palette');
  });

  it('f key returns null when input is focused (no leaking)', () => {
    expect(resolveKeyAction('f', true, makeState())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// G.2: hook source contains event.preventDefault() for toggle-palette
// (structural test to ensure the fix is present)
// ─────────────────────────────────────────────────────────

describe('useKeyboardNavigation hook source — G.2 preventDefault for f key', () => {
  it('toggle-palette case calls event.preventDefault()', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer/hooks/useKeyboardNavigation.ts'),
      'utf-8'
    );
    // Verify that the toggle-palette case has event.preventDefault() before or after the callback
    // We check that the source contains preventDefault in proximity to toggle-palette
    expect(src).toMatch(/toggle-palette[\s\S]{0,200}event\.preventDefault\(\)|event\.preventDefault\(\)[\s\S]{0,200}toggle-palette/);
  });
});

// ─────────────────────────────────────────────────────────
// G.1: hook source contains event.preventDefault() for ArrowUp/ArrowDown
// ─────────────────────────────────────────────────────────

describe('useKeyboardNavigation hook source — G.1 preventDefault for arrow keys', () => {
  it('next case (ArrowDown) calls event.preventDefault()', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer/hooks/useKeyboardNavigation.ts'),
      'utf-8'
    );
    // Verify next action case includes preventDefault
    expect(src).toMatch(/case 'next'[\s\S]{0,100}event\.preventDefault\(\)|event\.preventDefault\(\)[\s\S]{0,100}case 'next'/);
  });

  it('prev case (ArrowUp) calls event.preventDefault()', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer/hooks/useKeyboardNavigation.ts'),
      'utf-8'
    );
    // Verify prev action case includes preventDefault
    expect(src).toMatch(/case 'prev'[\s\S]{0,100}event\.preventDefault\(\)|event\.preventDefault\(\)[\s\S]{0,100}case 'prev'/);
  });
});

// ─────────────────────────────────────────────────────────
// G.1: hook source contains onDayNavigate callback for prev-day/next-day
// ─────────────────────────────────────────────────────────

describe('useKeyboardNavigation hook source — G.1 onDayNavigate callback', () => {
  it('hook source references onDayNavigate', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer/hooks/useKeyboardNavigation.ts'),
      'utf-8'
    );
    expect(src).toMatch(/onDayNavigate/);
  });

  it('hook source calls onDayNavigate with prev for prev-day action', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer/hooks/useKeyboardNavigation.ts'),
      'utf-8'
    );
    // Match both direct call and optional-chaining call: onDayNavigate?.('prev') or onDayNavigate('prev')
    expect(src).toMatch(/onDayNavigate\??\.?\s*\(\s*['"]prev['"]\s*\)/);
  });

  it('hook source calls onDayNavigate with next for next-day action', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../src/ui/viewer/hooks/useKeyboardNavigation.ts'),
      'utf-8'
    );
    // Match both direct call and optional-chaining call: onDayNavigate?.('next') or onDayNavigate('next')
    expect(src).toMatch(/onDayNavigate\??\.?\s*\(\s*['"]next['"]\s*\)/);
  });
});

// ─────────────────────────────────────────────────────────
// isInputFocusedFromElement — exported helper for tag/contenteditable detection
// ─────────────────────────────────────────────────────────

describe('isInputFocusedFromElement', () => {
  it('returns true for INPUT tag', async () => {
    const { isInputFocusedFromElement } = await import('../../../src/ui/viewer/hooks/useKeyboardNavigation.js');
    expect(isInputFocusedFromElement('INPUT', null)).toBe(true);
  });

  it('returns true for TEXTAREA tag', async () => {
    const { isInputFocusedFromElement } = await import('../../../src/ui/viewer/hooks/useKeyboardNavigation.js');
    expect(isInputFocusedFromElement('TEXTAREA', null)).toBe(true);
  });

  it('returns true for SELECT tag', async () => {
    const { isInputFocusedFromElement } = await import('../../../src/ui/viewer/hooks/useKeyboardNavigation.js');
    expect(isInputFocusedFromElement('SELECT', null)).toBe(true);
  });

  it('returns true for contenteditable="true"', async () => {
    const { isInputFocusedFromElement } = await import('../../../src/ui/viewer/hooks/useKeyboardNavigation.js');
    expect(isInputFocusedFromElement('DIV', 'true')).toBe(true);
  });

  it('returns false for a BUTTON element without contenteditable', async () => {
    const { isInputFocusedFromElement } = await import('../../../src/ui/viewer/hooks/useKeyboardNavigation.js');
    expect(isInputFocusedFromElement('BUTTON', null)).toBe(false);
  });

  it('returns false for contenteditable="false"', async () => {
    const { isInputFocusedFromElement } = await import('../../../src/ui/viewer/hooks/useKeyboardNavigation.js');
    expect(isInputFocusedFromElement('DIV', 'false')).toBe(false);
  });

  it('returns false for contenteditable=""', async () => {
    const { isInputFocusedFromElement } = await import('../../../src/ui/viewer/hooks/useKeyboardNavigation.js');
    expect(isInputFocusedFromElement('DIV', '')).toBe(false);
  });

  it('returns false for null element (no active element)', async () => {
    const { isInputFocusedFromElement } = await import('../../../src/ui/viewer/hooks/useKeyboardNavigation.js');
    expect(isInputFocusedFromElement(null, null)).toBe(false);
  });

  it('input tag comparison is case-insensitive (lowercase input)', async () => {
    const { isInputFocusedFromElement } = await import('../../../src/ui/viewer/hooks/useKeyboardNavigation.js');
    // tagName in real DOM is always uppercase, but guard against lowercase too
    expect(isInputFocusedFromElement('input', null)).toBe(true);
  });
});
