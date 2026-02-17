import React, { useEffect, useRef } from 'react';
// NOTE: Escape key handling is centralized in useKeyboardNavigation hook.
// CommandPalette only handles auto-focus and backdrop click via onClose prop.
import { FilterChip } from './FilterChip';
import {
  OBSERVATION_TYPES,
  OBSERVATION_CONCEPTS,
  ITEM_KINDS,
  ITEM_KIND_LABELS,
} from '../constants/filters';
import type { FilterState } from '../types';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  filters: FilterState;
  onQueryChange: (query: string) => void;
  onToggleObsType: (type: string) => void;
  onToggleConcept: (concept: string) => void;
  onToggleItemKind: (kind: 'observations' | 'sessions' | 'prompts') => void;
  onDateRangeChange: (start: string, end: string) => void;
  onClearAll: () => void;
  hasActiveFilters: boolean;
  isSearching: boolean;
}

export function CommandPalette({
  isOpen,
  onClose,
  filters,
  onQueryChange,
  onToggleObsType,
  onToggleConcept,
  onToggleItemKind,
  onDateRangeChange,
  onClearAll,
  hasActiveFilters,
  isSearching,
}: CommandPaletteProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <>
      <div
        className="command-palette-backdrop"
        data-testid="command-palette-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="command-palette"
        data-testid="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="command-palette-search-row">
          <input
            ref={searchInputRef}
            className="command-palette-search"
            data-testid="command-palette-search"
            type="text"
            placeholder="Search memory..."
            value={filters.query}
            onChange={e => { onQueryChange(e.target.value); }}
            aria-label="Search"
          />
          {isSearching && (
            <span className="command-palette-searching" aria-live="polite">
              Searching...
            </span>
          )}
        </div>

        {hasActiveFilters && (
          <div className="command-palette-active-filters">
            {filters.obsTypes.map(type => (
              <FilterChip
                key={`active-type-${type}`}
                label={type}
                isSelected={true}
                onToggle={() => { onToggleObsType(type); }}
              />
            ))}
            {filters.concepts.map(concept => (
              <FilterChip
                key={`active-concept-${concept}`}
                label={concept}
                isSelected={true}
                onToggle={() => { onToggleConcept(concept); }}
              />
            ))}
            {filters.itemKinds.map(kind => (
              <FilterChip
                key={`active-kind-${kind}`}
                label={ITEM_KIND_LABELS[kind]}
                isSelected={true}
                onToggle={() => { onToggleItemKind(kind); }}
              />
            ))}
            <button className="filter-clear-btn" onClick={onClearAll}>
              Clear All
            </button>
          </div>
        )}

        <div className="command-palette-filters">
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
        </div>
      </div>
    </>
  );
}
