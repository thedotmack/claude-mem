import React from 'react';

interface SearchResultsBadgeProps {
  totalResults: number;
  query: string;
  hasActiveFilters: boolean;
  hasMore: boolean;
  onClear: () => void;
}

export function SearchResultsBadge({ totalResults, query, hasActiveFilters, hasMore, onClear }: SearchResultsBadgeProps) {
  if (!hasActiveFilters) return null;

  return (
    <div className="search-results-badge">
      <span className="search-results-badge-text">
        {totalResults}{hasMore ? '+' : ''} result{totalResults !== 1 ? 's' : ''}
        {query ? ` for "${query}"` : ''}
      </span>
      <button
        className="search-results-badge-clear"
        onClick={onClear}
        aria-label="Clear all filters"
      >
        Clear
      </button>
    </div>
  );
}
