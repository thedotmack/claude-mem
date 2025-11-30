import React, { useState, useEffect } from 'react';
import { Settings, Stats } from '../types';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { formatUptime, formatBytes } from '../utils/formatters';

interface SidebarProps {
  isOpen: boolean;
  settings: Settings;
  stats: Stats;
  isSaving: boolean;
  saveStatus: string;
  isConnected: boolean;
  projects: string[];
  currentFilter: string;
  onFilterChange: (filter: string) => void;
  onSave: (settings: Settings) => void;
  onClose: () => void;
  onRefreshStats: () => void;
}

export function Sidebar({ isOpen, settings, stats, isSaving, saveStatus, isConnected, projects, currentFilter, onFilterChange, onSave, onClose, onRefreshStats }: SidebarProps) {
  // Settings form state
  const [model, setModel] = useState(settings.CLAUDE_MEM_MODEL || DEFAULT_SETTINGS.CLAUDE_MEM_MODEL);
  const [contextObs, setContextObs] = useState(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS || DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_OBSERVATIONS);
  const [workerPort, setWorkerPort] = useState(settings.CLAUDE_MEM_WORKER_PORT || DEFAULT_SETTINGS.CLAUDE_MEM_WORKER_PORT);

  // MCP toggle state (separate from settings)
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [mcpToggling, setMcpToggling] = useState(false);
  const [mcpStatus, setMcpStatus] = useState('');

  // Update settings form state when settings change
  useEffect(() => {
    setModel(settings.CLAUDE_MEM_MODEL || DEFAULT_SETTINGS.CLAUDE_MEM_MODEL);
    setContextObs(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS || DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_OBSERVATIONS);
    setWorkerPort(settings.CLAUDE_MEM_WORKER_PORT || DEFAULT_SETTINGS.CLAUDE_MEM_WORKER_PORT);
  }, [settings]);

  // Fetch MCP status on mount
  useEffect(() => {
    fetch('/api/mcp/status')
      .then(res => res.json())
      .then(data => setMcpEnabled(data.enabled))
      .catch(error => console.error('Failed to load MCP status:', error));
  }, []);

  // Refresh stats when sidebar opens
  useEffect(() => {
    if (isOpen) {
      onRefreshStats();
    }
  }, [isOpen, onRefreshStats]);

  const handleSave = () => {
    onSave({
      CLAUDE_MEM_MODEL: model,
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: contextObs,
      CLAUDE_MEM_WORKER_PORT: workerPort
    });
  };

  const handleMcpToggle = async (enabled: boolean) => {
    setMcpToggling(true);
    setMcpStatus('Toggling...');

    try {
      const response = await fetch('/api/mcp/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });

      const result = await response.json();

      if (result.success) {
        setMcpEnabled(result.enabled);
        setMcpStatus('✓ Updated (restart Claude Code to apply)');
        setTimeout(() => setMcpStatus(''), 3000);
      } else {
        setMcpStatus(`✗ Error: ${result.error}`);
        setTimeout(() => setMcpStatus(''), 3000);
      }
    } catch (error) {
      setMcpStatus(`✗ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      setTimeout(() => setMcpStatus(''), 3000);
    } finally {
      setMcpToggling(false);
    }
  };

  return (
    <div className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="sidebar-header">
        <h1>Settings</h1>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span className={`status-dot ${isConnected ? 'connected' : ''}`} />
            <span style={{ fontSize: '11px', opacity: 0.5, fontWeight: 300 }}>{isConnected ? 'Connected' : 'Disconnected'}</span>
          </div>
          <button onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={onClose}
            title="Close settings"
            style={{
              background: 'transparent',
              border: '1px solid #404040',
              padding: '8px',
              width: '36px',
              height: '36px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      <a
        href="https://discord.gg/J4wttp9vDu"
        target="_blank"
        rel="noopener noreferrer"
        className="sidebar-community-btn"
        title="Join our Discord community"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: '6px' }}>
          <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
        </svg>
        <span>Community</span>
      </a>
      <div className="sidebar-social-links">
        <a
          href="https://docs.claude-mem.ai"
          target="_blank"
          rel="noopener noreferrer"
          title="Documentation"
          className="icon-link"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
          </svg>
        </a>
        <a
          href="https://github.com/thedotmack/claude-mem/"
          target="_blank"
          rel="noopener noreferrer"
          title="GitHub"
          className="icon-link"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
        </a>
        <a
          href="https://x.com/Claude_Memory"
          target="_blank"
          rel="noopener noreferrer"
          title="X (Twitter)"
          className="icon-link"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
          </svg>
        </a>
      </div>
      <div className="sidebar-project-filter">
        <label htmlFor="sidebar-project-select">Filter by Project</label>
        <select
          id="sidebar-project-select"
          value={currentFilter}
          onChange={e => onFilterChange(e.target.value)}
        >
          <option value="">All Projects</option>
          {projects.map(project => (
            <option key={project} value={project}>{project}</option>
          ))}
        </select>
      </div>
      <div className="stats-scroll">

        <div className="settings-section">
          <h3>Environment Variables</h3>
          <div className="form-group">
            <label htmlFor="model">CLAUDE_MEM_MODEL</label>
            <div className="setting-description">
              Model used for AI compression of tool observations. Haiku is fast and cheap, Sonnet offers better quality, Opus is most capable but expensive.
            </div>
            <select
              id="model"
              value={model}
              onChange={e => setModel(e.target.value)}
            >
              <option value="claude-haiku-4-5">claude-haiku-4-5</option>
              <option value="claude-sonnet-4-5">claude-sonnet-4-5</option>
              <option value="claude-opus-4">claude-opus-4</option>
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="contextObs">CLAUDE_MEM_CONTEXT_OBSERVATIONS</label>
            <div className="setting-description">
              Number of recent observations to inject at session start. Higher values provide more context but increase token usage. Default: 50
            </div>
            <input
              type="number"
              id="contextObs"
              min="1"
              max="200"
              value={contextObs}
              onChange={e => setContextObs(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="workerPort">CLAUDE_MEM_WORKER_PORT</label>
            <div className="setting-description">
              Port number for the background worker service. Change only if port 37777 conflicts with another service.
            </div>
            <input
              type="number"
              id="workerPort"
              min="1024"
              max="65535"
              value={workerPort}
              onChange={e => setWorkerPort(e.target.value)}
            />
          </div>
          {saveStatus && (
            <div className="save-status">{saveStatus}</div>
          )}
        </div>

        <div className="settings-section">
          <h3>MCP Search Server</h3>
          <div className="form-group">
            <label htmlFor="mcpEnabled" style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                id="mcpEnabled"
                checked={mcpEnabled}
                onChange={e => handleMcpToggle(e.target.checked)}
                disabled={mcpToggling}
                style={{ cursor: mcpToggling ? 'not-allowed' : 'pointer' }}
              />
              Enable MCP Search Server
            </label>
            <div className="setting-description">
              claude-mem suggests using skill-based search (saves ~2,500 tokens at session start), but some users prefer MCP. Disable to only use skill-based search. Requires Claude Code restart to apply changes.
            </div>
            {mcpStatus && (
              <div className="save-status">{mcpStatus}</div>
            )}
          </div>
        </div>

        <div className="settings-section">
          <h3>Worker Stats</h3>
          <div className="stats-grid">
            <div className="stat">
              <div className="stat-label">Version</div>
              <div className="stat-value">{stats.worker?.version || '-'}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Uptime</div>
              <div className="stat-value">{formatUptime(stats.worker?.uptime)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Active Sessions</div>
              <div className="stat-value">{stats.worker?.activeSessions || '0'}</div>
            </div>
            <div className="stat">
              <div className="stat-label">SSE Clients</div>
              <div className="stat-value">{stats.worker?.sseClients || '0'}</div>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3>Database Stats</h3>
          <div className="stats-grid">
            <div className="stat">
              <div className="stat-label">DB Size</div>
              <div className="stat-value">{formatBytes(stats.database?.size)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Observations</div>
              <div className="stat-value">{stats.database?.observations || '0'}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Sessions</div>
              <div className="stat-value">{stats.database?.sessions || '0'}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Summaries</div>
              <div className="stat-value">{stats.database?.summaries || '0'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
