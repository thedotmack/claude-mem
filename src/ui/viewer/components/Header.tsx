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
          <svg className="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"></path>
          </svg>
        </button>
      </div>
    </div>
  );
}
