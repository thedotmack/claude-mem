import React from 'react';
import { useI18n, interpolate } from '../../i18n';
import { CATEGORY_ORDER, labelForCategory } from '../utils/category';

interface CategoryFilterProps {
  categoryCounts: Record<string, number>;
  activeCategories: Set<string>;
  onToggle: (category: string) => void;
  filteredCount: number;
  totalCount: number;
  totalIsPartial: boolean;
}

export function CategoryFilter({
  categoryCounts,
  activeCategories,
  onToggle,
  filteredCount,
  totalCount,
  totalIsPartial,
}: CategoryFilterProps) {
  const { t } = useI18n();
  const presentCategories = CATEGORY_ORDER.filter(category => (categoryCounts[category] ?? 0) > 0 || activeCategories.has(category));

  if (presentCategories.length === 0) {
    return null;
  }

  return (
    <div className="category-filter-bar">
      <div className="console-filter-chips">
        {presentCategories.map(category => {
          const label = labelForCategory(category);
          const translatedLabel = t(label);
          return (
            <button
              key={category}
              className={`console-filter-chip ${activeCategories.has(category) ? 'active' : ''}`}
              onClick={() => onToggle(category)}
              title={interpolate(t('Filter to {category}'), { category: translatedLabel })}
              aria-pressed={activeCategories.has(category)}
            >
              {translatedLabel} ({categoryCounts[category] ?? 0})
            </button>
          );
        })}
      </div>
      <span className="category-filter-count">
        {interpolate(t('{filtered} of {total}{suffix}'), {
          filtered: filteredCount,
          total: totalCount,
          suffix: totalIsPartial ? '+' : '',
        })}
      </span>
    </div>
  );
}
