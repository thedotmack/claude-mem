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
  onSave: (settings: Settings) => void;
  onClose: () => void;
  onRefreshStats: () => void;
}

export function Sidebar({ isOpen, settings, stats, isSaving, saveStatus, isConnected, onSave, onClose, onRefreshStats }: SidebarProps) {
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
