import React from 'react';

interface KeyboardShortcutHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: '↑ / ↓', description: 'Navigate sessions' },
  { keys: '← / →', description: 'Navigate days' },
  { keys: '/', description: 'Focus search' },
  { keys: 'f', description: 'Filter palette' },
  { keys: 'Esc', description: 'Clear / close' },
  { keys: '?', description: 'This help' },
];

export function KeyboardShortcutHelp({ isOpen, onClose }: KeyboardShortcutHelpProps) {
  if (!isOpen) return null;

  return (
    <div
      className="keyboard-help"
      data-testid="keyboard-help"
      role="dialog"
      aria-label="Keyboard shortcuts"
    >
      <div className="keyboard-help__header">
        <span className="keyboard-help__title">Keyboard shortcuts</span>
        <button
          className="keyboard-help__close"
          onClick={onClose}
          aria-label="Close keyboard shortcuts"
        >
          ×
        </button>
      </div>
      {SHORTCUTS.map(({ keys, description }) => (
        <div key={keys} className="keyboard-help__row">
          <kbd className="keyboard-help__key">{keys}</kbd>
          <span className="keyboard-help__desc">{description}</span>
        </div>
      ))}
    </div>
  );
}
