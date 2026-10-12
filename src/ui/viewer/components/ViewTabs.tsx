import React from 'react';

export type ViewTab = 'timeline' | 'sessions';

interface ViewTabsProps {
  active: ViewTab;
  onSelect: (tab: ViewTab) => void;
}

/** Switch between the chronological timeline and the per-session view. */
export function ViewTabs({ active, onSelect }: ViewTabsProps) {
  return (
    <nav className="view-tabs" aria-label="View">
      <button
        className={`view-tab${active === 'timeline' ? ' active' : ''}`}
        aria-pressed={active === 'timeline'}
        onClick={() => onSelect('timeline')}
      >
        Timeline
      </button>
      <button
        className={`view-tab${active === 'sessions' ? ' active' : ''}`}
        aria-pressed={active === 'sessions'}
        onClick={() => onSelect('sessions')}
      >
        Sessions
      </button>
    </nav>
  );
}
