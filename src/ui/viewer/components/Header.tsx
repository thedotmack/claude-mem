import React from 'react';
import { ThemeToggle } from './ThemeToggle';
import { ThemePreference } from '../hooks/useTheme';
import { SearchInput } from './SearchInput';
import { OBSERVATION_TYPES, TYPE_METADATA } from '../types';

type ViewMode = 'feed' | 'graph';

interface HeaderProps {
  isConnected: boolean;
  projects: string[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  selectedTypes: string[];
  onTypeToggle: (type: string) => void;
  onSelectAllTypes: () => void;
  onDeselectAllTypes: () => void;
  isProcessing: boolean;
  queueDepth: number;
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onContextPreviewToggle: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  isSearching: boolean;
  viewMode: ViewMode;
  onViewModeToggle: () => void;
}

export function Header({
  isConnected,
  projects,
  currentFilter,
  onFilterChange,
  selectedTypes,
  onTypeToggle,
  onSelectAllTypes,
  onDeselectAllTypes,
  isProcessing,
  queueDepth,
  themePreference,
  onThemeChange,
  onContextPreviewToggle,
  searchQuery,
  onSearchChange,
  isSearching,
  viewMode,
  onViewModeToggle
}: HeaderProps) {
  const allTypesSelected = selectedTypes.length === OBSERVATION_TYPES.length;

  return (
    <div className="header">
      <h1>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <img src="claude-mem-logomark.webp" alt="" className={`logomark ${isProcessing ? 'spinning' : ''}`} />
          {queueDepth > 0 && (
            <div className="queue-bubble">
              {queueDepth}
            </div>
          )}
        </div>
        <span className="logo-text">claude-mem</span>
      </h1>
      <div className="status">
        <select
          value={currentFilter}
          onChange={e => onFilterChange(e.target.value)}
        >
          <option value="">All Projects</option>
          {projects.map(project => (
            <option key={project} value={project}>{project}</option>
          ))}
        </select>
        <button
          className={`view-mode-btn ${viewMode === 'graph' ? 'active' : ''}`}
          onClick={onViewModeToggle}
          title={viewMode === 'feed' ? 'Switch to Graph view' : 'Switch to Feed view'}
        >
          {viewMode === 'feed' ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
              <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
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

      {/* Search Row */}
      <div className="search-row">
        <SearchInput
          value={searchQuery}
          onChange={onSearchChange}
          isLoading={isSearching}
          placeholder="Search observations semantically..."
        />
        {searchQuery && (
          <span className="search-mode-indicator">
            Semantic search mode
          </span>
        )}
      </div>

      {/* Type Filter Row */}
      <div className="type-filter-row">
        <span className="type-filter-label">Types:</span>
        <div className="type-filter-buttons">
          {OBSERVATION_TYPES.map(type => {
            const meta = TYPE_METADATA[type];
            const isSelected = selectedTypes.includes(type);
            return (
              <button
                key={type}
                className={`type-filter-btn ${isSelected ? 'active' : ''}`}
                onClick={() => onTypeToggle(type)}
                title={`${isSelected ? 'Hide' : 'Show'} ${meta.label} observations`}
                style={{
                  '--type-color': meta.color,
                  '--type-bg': isSelected ? `${meta.color}20` : 'transparent'
                } as React.CSSProperties}
              >
                <span className="type-emoji">{meta.emoji}</span>
                <span className="type-label">{meta.label}</span>
              </button>
            );
          })}
          <div className="type-filter-actions">
            <button
              className={`type-action-btn ${allTypesSelected ? 'active' : ''}`}
              onClick={onSelectAllTypes}
              title="Show all types"
            >
              All
            </button>
            <button
              className={`type-action-btn ${selectedTypes.length === 1 ? 'active' : ''}`}
              onClick={onDeselectAllTypes}
              title="Show only one type"
            >
              One
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
