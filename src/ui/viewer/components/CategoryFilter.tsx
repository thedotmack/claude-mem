import React from 'react';
import { useI18n, interpolate } from '../../i18n';
import type { Category } from '../utils/category';
import { kindsByCount } from '../utils/feed-display';
import { formatCount } from '../utils/formatters';
import { CheckIcon } from './icons';
import { useRowOverflow } from '../hooks/useRowOverflow';

/** The word on each kind chip, in the reader's language. Literal t() keys, so tests/ui-i18n.test.ts sees each one. */
export const KIND_CHIP_WORDS: Record<Category, (t: (english: string) => string) => string> = {
  prompt: t => t('Prompt'),
  summary: t => t('Summary'),
  discovery: t => t('Discovery'),
  decision: t => t('Decision'),
  bugfix: t => t('Bugfix'),
  feature: t => t('Feature'),
  refactor: t => t('Refactor'),
  change: t => t('Change'),
  security_alert: t => t('Security Alert'),
  security_note: t => t('Security Note'),
  sensitive: t => t('Sensitive'),
  other: t => t('Other'),
};

interface CategoryFilterProps {
  categoryCounts: Partial<Record<Category, number>>;
  activeCategories: Set<Category>;
  onToggle: (category: Category) => void;
  /** Turns every kind back on ("All" and "Clear"); without it each active kind is toggled off. */
  onClear?: () => void;
  filteredCount: number;
  totalCount: number;
  totalIsPartial: boolean;
}

/**
 * Kind chips with counts: "All <n>" is chosen while no kind is, a chosen chip has
 * a blue edge, blue text and a check, chips run from the most rows to the fewest,
 * and "Clear" shows while a kind is chosen.
 */
export function CategoryFilter({
  categoryCounts,
  activeCategories,
  onToggle,
  onClear,
  filteredCount,
  totalCount,
  totalIsPartial,
}: CategoryFilterProps) {
  const { t } = useI18n();
  const presentCategories = kindsByCount(categoryCounts, activeCategories);
  // On a phone the chips are one scrolling row; its cut edge fades out to show there are more to swipe to.
  const { rowRef, className: overflowClass } = useRowOverflow();

  if (presentCategories.length === 0) {
    return null;
  }

  const clear = onClear ?? (() => { for (const category of activeCategories) onToggle(category); });
  const total = Object.values(categoryCounts).reduce((sum, count) => sum + (count ?? 0), 0);
  const allChosen = activeCategories.size === 0;

  return (
    <div className="category-filter-bar">
      <div ref={rowRef} className={`kind-chips${overflowClass}`} role="group" aria-label={t('Show kinds')}>
        <button
          type="button"
          className={`kind-chip${allChosen ? ' active' : ''}`}
          onClick={clear}
          aria-pressed={allChosen}
          title={t('Show every kind')}
        >
          {allChosen && <CheckIcon size={14} />}
          {t('All')} <span className="kind-chip-count">{formatCount(total)}</span>
        </button>
        {presentCategories.map(category => {
          const label = KIND_CHIP_WORDS[category](t);
          const chosen = activeCategories.has(category);
          return (
            <button
              type="button"
              key={category}
              className={`kind-chip${chosen ? ' active' : ''}`}
              onClick={() => onToggle(category)}
              title={interpolate(t('Filter to {category}'), { category: label })}
              aria-pressed={chosen}
            >
              {chosen && <CheckIcon size={14} />}
              {label} <span className="kind-chip-count">{formatCount(categoryCounts[category] ?? 0)}</span>
            </button>
          );
        })}
      </div>
      <span className="category-filter-count">
        {interpolate(t('{filtered} of {total}{suffix}'), {
          filtered: formatCount(filteredCount),
          total: formatCount(totalCount),
          suffix: totalIsPartial ? '+' : '',
        })}
      </span>
      {!allChosen && <button type="button" className="link-button" onClick={clear}>{t('Clear')}</button>}
    </div>
  );
}
