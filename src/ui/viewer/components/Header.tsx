import React, { useState } from 'react';
import { ThemeToggle } from './ThemeToggle';
import { SearchBar } from './SearchBar';
import { FilterBar } from './FilterBar';
import type { ThemePreference } from '../hooks/useTheme';
import type { FilterState, ActivityDay } from '../types';
import { GitHubStarsButton } from './GitHubStarsButton';
import { useSpinningFavicon } from '../hooks/useSpinningFavicon';

interface HeaderProps {
  isConnected: boolean;
  projects: string[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  isProcessing: boolean;
  queueDepth: number;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onContextPreviewToggle: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  isSearching: boolean;
  resultCount: string | null;
  filterCount: number;
  filters: FilterState;
  onToggleObsType: (type: string) => void;
  onToggleConcept: (concept: string) => void;
  onToggleItemKind: (kind: 'observations' | 'sessions' | 'prompts') => void;
  onDateRangeChange: (start: string, end: string) => void;
  onClearAllFilters: () => void;
  hasActiveFilters: boolean;
  isFilterMode: boolean;
  activityDays: ActivityDay[];
  activityLoading: boolean;
}

export function Header({
  isConnected: _isConnected,
  projects,
  currentFilter,
  onFilterChange,
  isProcessing,
  queueDepth,
  themePreference,
  onThemeChange,
  onContextPreviewToggle,
  query,
  onQueryChange,
  isSearching,
  resultCount,
  filterCount,
  filters,
  onToggleObsType,
  onToggleConcept,
  onToggleItemKind,
  onDateRangeChange,
  onClearAllFilters,
  hasActiveFilters,
  isFilterMode: _isFilterMode,
  activityDays,
  activityLoading,
}: HeaderProps) {
  useSpinningFavicon(isProcessing);
  const [filterBarOpen, setFilterBarOpen] = useState(false);

  return (
    <>
      <div className="header">
        <h1>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <img
              src={isProcessing ? 'magic-brain.webp' : 'magic-brain-still.webp'}
              alt=""
              className={`logomark ${isProcessing ? 'processing' : ''}`}
            />
            {queueDepth > 0 && (
              <div className="queue-bubble">
                {queueDepth}
              </div>
            )}
          </div>
          <span className="logo-text">magic-claude-mem</span>
        </h1>
        <div className="status">
          <SearchBar
            query={query}
            onQueryChange={onQueryChange}
            isSearching={isSearching}
            resultCount={resultCount}
          />
          <a
            href="https://docs.magic-claude-mem.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="icon-link"
            title="Documentation"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
            </svg>
          </a>
          <GitHubStarsButton username="doublefx" repo="magic-claude-mem" />
          <select
            value={currentFilter}
            onChange={e => { onFilterChange(e.target.value); }}
          >
            <option value="">All Projects</option>
            {projects.map(project => (
              <option key={project} value={project}>{project}</option>
            ))}
          </select>
          <button
            className={`filter-toggle-btn ${filterBarOpen ? 'active' : ''}`}
            onClick={() => { setFilterBarOpen(prev => !prev); }}
            title="Toggle filters"
            aria-label="Toggle filters"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
            </svg>
            {filterCount > 0 && (
              <span className="filter-toggle-badge">{filterCount}</span>
            )}
          </button>
          <ThemeToggle
            preference={themePreference}
            onThemeChange={onThemeChange}
          />
          <button
            className="settings-btn"
            onClick={onContextPreviewToggle}
            title="Settings"
          >
            <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </button>
        </div>
      </div>
      <FilterBar
        filters={filters}
        onToggleObsType={onToggleObsType}
        onToggleConcept={onToggleConcept}
        onToggleItemKind={onToggleItemKind}
        onDateRangeChange={onDateRangeChange}
        onClearAll={onClearAllFilters}
        hasActiveFilters={hasActiveFilters}
        isOpen={filterBarOpen}
        activityDays={activityDays}
        activityLoading={activityLoading}
      />
    </>
  );
}
