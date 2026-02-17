import { describe, it, expect } from 'vitest';
import { resolveKeyAction } from '../../../src/ui/viewer/hooks/useKeyboardNavigation.js';

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
// resolveKeyAction — happy path shortcuts
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — navigation shortcuts', () => {
  it('j key returns next when not in input', () => {
    expect(resolveKeyAction('j', false, makeState())).toBe('next');
  });

  it('k key returns prev when not in input', () => {
    expect(resolveKeyAction('k', false, makeState())).toBe('prev');
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
});

// ─────────────────────────────────────────────────────────
// resolveKeyAction — focus guard
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — focus guard', () => {
  it('j key returns null when input is focused', () => {
    expect(resolveKeyAction('j', true, makeState())).toBeNull();
  });

  it('k key returns null when input is focused', () => {
    expect(resolveKeyAction('k', true, makeState())).toBeNull();
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

  it('returns null for ArrowUp', () => {
    expect(resolveKeyAction('ArrowUp', false, makeState())).toBeNull();
  });

  it('returns null for empty string key', () => {
    expect(resolveKeyAction('', false, makeState())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
// isInputFocused derivation
// The hook derives isInputFocused from document.activeElement.
// Here we test the pure helper that determines whether a given
// tagName/contenteditable combination counts as "focused input".
// ─────────────────────────────────────────────────────────

describe('resolveKeyAction — all non-Esc shortcuts blocked when input focused', () => {
  const nonEscShortcuts = ['j', 'k', '/', 'f', '?'];

  for (const key of nonEscShortcuts) {
    it(`${key} returns null when isInputFocused is true`, () => {
      expect(resolveKeyAction(key, true, makeState())).toBeNull();
    });
  }
});

// ─────────────────────────────────────────────────────────
// isInputFocusedFromElement — exported helper for tag/contenteditable detection
// ─────────────────────────────────────────────────────────

describe('isInputFocusedFromElement', () => {
  // Import dynamically so this describe block still fails if the export is missing
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
