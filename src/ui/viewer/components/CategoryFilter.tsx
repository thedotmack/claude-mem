import React from 'react';
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
  const presentCategories = CATEGORY_ORDER.filter(category => (categoryCounts[category] ?? 0) > 0);

  if (presentCategories.length === 0) {
    return null;
  }

  return (
    <div className="category-filter-bar">
      <div className="console-filter-chips">
        {presentCategories.map(category => (
          <button
            key={category}
            className={`console-filter-chip ${activeCategories.has(category) ? 'active' : ''}`}
            onClick={() => onToggle(category)}
            title={`Filter to ${labelForCategory(category)}`}
          >
            {labelForCategory(category)} ({categoryCounts[category]})
          </button>
        ))}
      </div>
      <span className="category-filter-count">
        {filteredCount} of {totalCount}{totalIsPartial ? '+' : ''}
      </span>
    </div>
  );
}
