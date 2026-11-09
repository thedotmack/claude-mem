import React from 'react';
import { useI18n } from '../../i18n';

export type ViewTab = 'timeline' | 'sessions' | 'wire';

interface ViewTabsProps {
  active: ViewTab;
  onSelect: (tab: ViewTab) => void;
}

/** Switch between the chronological timeline, the per-session view and the Wire page. */
export function ViewTabs({ active, onSelect }: ViewTabsProps) {
  const { t } = useI18n();
  return (
    <nav className="view-tabs" aria-label={t('View')}>
      <button
        className={`view-tab${active === 'timeline' ? ' active' : ''}`}
        aria-pressed={active === 'timeline'}
        onClick={() => onSelect('timeline')}
      >
        {t('Timeline')}
      </button>
      <button
        className={`view-tab${active === 'sessions' ? ' active' : ''}`}
        aria-pressed={active === 'sessions'}
        onClick={() => onSelect('sessions')}
      >
        {t('Sessions')}
      </button>
      <button
        className={`view-tab${active === 'wire' ? ' active' : ''}`}
        aria-pressed={active === 'wire'}
        onClick={() => onSelect('wire')}
      >
        Wire
      </button>
    </nav>
  );
}
