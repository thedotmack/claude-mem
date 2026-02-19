import React from 'react';
import { SearchBar } from './SearchBar';
import { AnalyticsBar } from './AnalyticsBar';
import { useSpinningFavicon } from '../hooks/useSpinningFavicon';

interface HeaderProps {
  projects: string[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  isProcessing: boolean;
  queueDepth: number;
  onContextPreviewToggle: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  isSearching: boolean;
  resultCount: string | null;
  filterCount: number;
  onFilterToggle: () => void;
  version?: string;
  project: string;
}

export function Header({
  projects,
  currentFilter,
  onFilterChange,
  isProcessing,
  queueDepth,
  onContextPreviewToggle,
  query,
  onQueryChange,
  isSearching,
  resultCount,
  filterCount,
  onFilterToggle,
  version,
  project,
}: HeaderProps) {
  useSpinningFavicon(isProcessing);

  return (
      <header className="header" role="banner">
        <h1>
          <div className="header__logo-wrapper">
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
          {version && <span className="version-badge">v{version}</span>}
        </h1>
        <AnalyticsBar project={project} />
        <div className="status">
          <SearchBar
            query={query}
            onQueryChange={onQueryChange}
            isSearching={isSearching}
            resultCount={resultCount}
          />
          <select
            value={currentFilter}
            onChange={e => { onFilterChange(e.target.value); }}
            aria-label="Filter by project"
          >
            <option value="">All Projects</option>
            {projects.map(proj => (
              <option key={proj} value={proj}>{proj}</option>
            ))}
          </select>
          <button
            className="filter-toggle-btn"
            onClick={onFilterToggle}
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
          <button
            className="settings-btn"
            onClick={onContextPreviewToggle}
            title="Settings"
            aria-label="Settings"
          >
            <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </button>
        </div>
      </header>
  );
}
