import { useState, useEffect, useRef } from 'react';

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface UseKeyboardNavigationOptions {
  /** Callback to navigate to next session (ArrowDown key) */
  onNextSession: () => void;
  /** Callback to navigate to previous session (ArrowUp key) */
  onPrevSession: () => void;
  /** Callback to focus the search input (/ key) */
  onFocusSearch: () => void;
  /** Callback to toggle the command palette (f key) */
  onTogglePalette: () => void;
  /** Whether the command palette is currently open */
  isPaletteOpen: boolean;
  /** Callback to close the command palette (Esc when palette open) */
  onClosePalette: () => void;
  /** Callback to clear search (Esc when search has content) */
  onClearSearch: () => void;
  /** Whether search input has content */
  hasSearchContent: boolean;
  /** Optional callback for day navigation (ArrowLeft/ArrowRight keys) */
  onDayNavigate?: (direction: 'prev' | 'next') => void;
}

export interface UseKeyboardNavigationResult {
  /** Whether the keyboard shortcut help overlay should be shown */
  showHelp: boolean;
  /** Setter for help overlay visibility */
  setShowHelp: (show: boolean) => void;
}

type KeyAction =
  | 'next'
  | 'prev'
  | 'prev-day'
  | 'next-day'
  | 'focus-search'
  | 'toggle-palette'
  | 'toggle-help'
  | 'close-palette'
  | 'close-help'
  | 'clear-search'
  | null;

// ─────────────────────────────────────────────────────────
// Pure helpers — exported for testability
// ─────────────────────────────────────────────────────────

/**
 * Determines whether the given element should block shortcut keys.
 *
 * @param tagName - The uppercase tagName of the active element, or null if none.
 * @param contentEditable - The contenteditable attribute value, or null if absent.
 * @returns true when keyboard shortcuts should be suppressed.
 */
export function isInputFocusedFromElement(
  tagName: string | null,
  contentEditable: string | null
): boolean {
  if (tagName === null) return false;
  const upper = tagName.toUpperCase();
  if (upper === 'INPUT' || upper === 'TEXTAREA' || upper === 'SELECT') return true;
  if (contentEditable === 'true') return true;
  return false;
}

/**
 * Pure function that maps a keyboard event key to a named action.
 * All state decisions happen here — no side effects.
 *
 * @param key - The KeyboardEvent.key value.
 * @param isInputFocused - Whether a text-input element currently has focus.
 * @param state - Current UI state relevant to keyboard handling.
 * @returns The action to dispatch, or null if the key should be ignored.
 */
export function resolveKeyAction(
  key: string,
  isInputFocused: boolean,
  state: { isPaletteOpen: boolean; showHelp: boolean; hasSearchContent: boolean }
): KeyAction {
  // Esc is always processed regardless of input focus.
  if (key === 'Escape') {
    if (state.isPaletteOpen) return 'close-palette';
    if (state.showHelp) return 'close-help';
    if (state.hasSearchContent) return 'clear-search';
    return null;
  }

  // All other shortcuts are blocked when a text input has focus.
  if (isInputFocused) return null;

  switch (key) {
    case 'ArrowDown': return 'next';
    case 'ArrowUp': return 'prev';
    case 'ArrowLeft': return 'prev-day';
    case 'ArrowRight': return 'next-day';
    case '/': return 'focus-search';
    case 'f': return 'toggle-palette';
    case '?': return 'toggle-help';
    default: return null;
  }
}

// ─────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────

/**
 * Wires global keyboard shortcuts to viewer UI callbacks.
 * Uses the pure `resolveKeyAction` function internally so the
 * decision logic remains fully unit-testable without a DOM.
 */
export function useKeyboardNavigation(
  options: UseKeyboardNavigationOptions
): UseKeyboardNavigationResult {
  const {
    isPaletteOpen,
    hasSearchContent,
  } = options;

  // Store callbacks in a ref so the keydown listener doesn't need to be
  // re-registered when callback identity changes (avoids listener churn).
  const callbacksRef = useRef(options);
  useEffect(() => { callbacksRef.current = options; });

  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const active = document.activeElement;
      const tagName = active?.tagName ?? null;
      const contentEditable = active?.getAttribute('contenteditable') ?? null;
      const isInputFocused = isInputFocusedFromElement(tagName, contentEditable);

      const action = resolveKeyAction(event.key, isInputFocused, {
        isPaletteOpen,
        showHelp,
        hasSearchContent,
      });

      const cbs = callbacksRef.current;
      switch (action) {
        case 'next':
          event.preventDefault();
          cbs.onNextSession();
          break;
        case 'prev':
          event.preventDefault();
          cbs.onPrevSession();
          break;
        case 'prev-day':
          event.preventDefault();
          cbs.onDayNavigate?.('prev');
          break;
        case 'next-day':
          event.preventDefault();
          cbs.onDayNavigate?.('next');
          break;
        case 'focus-search':
          event.preventDefault();
          cbs.onFocusSearch();
          break;
        case 'toggle-palette':
          event.preventDefault();
          cbs.onTogglePalette();
          break;
        case 'toggle-help':
          setShowHelp(prev => !prev);
          break;
        case 'close-palette':
          cbs.onClosePalette();
          break;
        case 'close-help':
          setShowHelp(false);
          break;
        case 'clear-search':
          cbs.onClearSearch();
          break;
        case null:
          break;
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showHelp, isPaletteOpen, hasSearchContent]);

  return { showHelp, setShowHelp };
}
