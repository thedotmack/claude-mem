import React, { useState } from 'react';
import { Settings, Stats } from '../types';

interface SidebarProps {
  isOpen: boolean;
  settings: Settings;
  stats: Stats;
  isSaving: boolean;
  saveStatus: string;
  onSave: (settings: Settings) => void;
  onClose: () => void;
}

export function Sidebar({ isOpen, settings, stats, isSaving, saveStatus, onSave, onClose }: SidebarProps) {
  const [model, setModel] = useState(settings.CLAUDE_MEM_MODEL || 'claude-haiku-4-5');
  const [contextObs, setContextObs] = useState(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50');
  const [workerPort, setWorkerPort] = useState(settings.CLAUDE_MEM_WORKER_PORT || '37777');

  // Update local state when settings change
  React.useEffect(() => {
    setModel(settings.CLAUDE_MEM_MODEL || 'claude-haiku-4-5');
    setContextObs(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50');
    setWorkerPort(settings.CLAUDE_MEM_WORKER_PORT || '37777');
  }, [settings]);

  const handleSave = () => {
    onSave({
      CLAUDE_MEM_MODEL: model,
      CLAUDE_MEM_CONTEXT_OBSERVATIONS: contextObs,
      CLAUDE_MEM_WORKER_PORT: workerPort
    });
  };

  const formatUptime = (seconds?: number) => {
    if (!seconds) return '-';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes) return '-';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  return (
    <div className={`sidebar ${isOpen ? 'open' : ''}`}>
      <div className="header">
        <h1>Settings</h1>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
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
