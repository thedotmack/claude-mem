import React from 'react';
import { FilterChip } from './FilterChip';
import { OBSERVATION_TYPES, OBSERVATION_CONCEPTS, ITEM_KINDS, ITEM_KIND_LABELS } from '../constants/filters';
import type { FilterState } from '../types';

interface FilterBarProps {
  filters: FilterState;
  onToggleObsType: (type: string) => void;
  onToggleConcept: (concept: string) => void;
  onToggleItemKind: (kind: 'observations' | 'sessions' | 'prompts') => void;
  onDateRangeChange: (start: string, end: string) => void;
  onClearAll: () => void;
  hasActiveFilters: boolean;
  isOpen: boolean;
}

export function FilterBar({
  filters,
  onToggleObsType,
  onToggleConcept,
  onToggleItemKind,
  onDateRangeChange,
  onClearAll,
  hasActiveFilters,
  isOpen,
}: FilterBarProps) {
  return (
    <div className={`filter-bar ${isOpen ? 'expanded' : 'collapsed'}`} role="toolbar" aria-label="Filters">
      <div className="filter-bar-inner">
        <div className="filter-section" data-group="type">
          <span className="filter-section-label">Type</span>
          <div className="filter-chips">
            {OBSERVATION_TYPES.map(type => (
              <FilterChip
                key={type}
                label={type}
                isSelected={filters.obsTypes.includes(type)}
                onToggle={() => { onToggleObsType(type); }}
              />
            ))}
          </div>
        </div>

        <div className="filter-section" data-group="concept">
          <span className="filter-section-label">Concept</span>
          <div className="filter-chips">
            {OBSERVATION_CONCEPTS.map(concept => (
              <FilterChip
                key={concept}
                label={concept}
                isSelected={filters.concepts.includes(concept)}
                onToggle={() => { onToggleConcept(concept); }}
              />
            ))}
          </div>
        </div>

        <div className="filter-section" data-group="show">
          <span className="filter-section-label">Show</span>
          <div className="filter-chips">
            {ITEM_KINDS.map(kind => (
              <FilterChip
                key={kind}
                label={ITEM_KIND_LABELS[kind]}
                isSelected={filters.itemKinds.includes(kind)}
                onToggle={() => { onToggleItemKind(kind); }}
              />
            ))}
          </div>
        </div>

        <div className="filter-section" data-group="date">
          <span className="filter-section-label">Date</span>
          <div className="filter-date-inputs">
            <input
              type="date"
              className="filter-date-input"
              value={filters.dateStart}
              onChange={e => { onDateRangeChange(e.target.value, filters.dateEnd); }}
              aria-label="Start date"
            />
            <span className="filter-date-separator">to</span>
            <input
              type="date"
              className="filter-date-input"
              value={filters.dateEnd}
              onChange={e => { onDateRangeChange(filters.dateStart, e.target.value); }}
              aria-label="End date"
            />
          </div>
        </div>

        {hasActiveFilters && (
          <button className="filter-clear-btn" onClick={onClearAll}>
            Clear All
          </button>
        )}
      </div>

    </div>
  );
}
