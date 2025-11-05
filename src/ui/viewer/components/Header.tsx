import React from 'react';

interface HeaderProps {
  isConnected: boolean;
  projects: string[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  onSettingsToggle: () => void;
  sidebarOpen: boolean;
}

export function Header({
  isConnected,
  projects,
  currentFilter,
  onFilterChange,
  onSettingsToggle,
  sidebarOpen
}: HeaderProps) {
  return (
    <div className="header">
      <h1>
        <img src="claude-mem-logo-for-dark-mode.webp" alt="claude-mem" className="logo" />
        viewer
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
        <span className={`status-dot ${isConnected ? 'connected' : ''}`} />
        <span>{isConnected ? 'Connected' : 'Disconnected'}</span>
        <button
          className={`settings-btn ${sidebarOpen ? 'active' : ''}`}
          onClick={onSettingsToggle}
          title="Settings"
        >
          <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M12 1v6m0 6v6m0-6h6m-6 0H6m9.364-3.364l4.243-4.243M4.636 19.364l4.243-4.243m0-6.121L4.636 4.636m14.728 14.728l-4.243-4.243"></path>
          </svg>
        </button>
      </div>
    </div>
  );
}
