import React, { useState, useEffect, useCallback } from 'react';

interface LogsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LogsModal({ isOpen, onClose }: LogsModalProps) {
  const [logs, setLogs] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/logs');
      if (!response.ok) {
        throw new Error(`Failed to fetch logs: ${response.statusText}`);
      }
      const data = await response.json();
      setLogs(data.logs || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleClearLogs = useCallback(async () => {
    if (!confirm('Are you sure you want to clear all logs?')) {
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/logs/clear', { method: 'POST' });
      if (!response.ok) {
        throw new Error(`Failed to clear logs: ${response.statusText}`);
      }
      setLogs('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch logs when modal opens
  useEffect(() => {
    if (isOpen) {
      fetchLogs();
    }
  }, [isOpen, fetchLogs]);

  // Auto-refresh logs every 2 seconds if enabled
  useEffect(() => {
    if (!isOpen || !autoRefresh) {
      return;
    }

    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [isOpen, autoRefresh, fetchLogs]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content logs-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Worker Logs</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <div className="logs-controls">
            <div className="logs-controls-left">
              <label className="auto-refresh-label">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                />
                Auto-refresh (2s)
              </label>
            </div>
            <div className="logs-controls-right">
              <button
                className="logs-action-btn"
                onClick={fetchLogs}
                disabled={isLoading}
              >
                {isLoading ? 'Loading...' : 'Refresh'}
              </button>
              <button
                className="logs-action-btn logs-clear-btn"
                onClick={handleClearLogs}
                disabled={isLoading}
              >
                Clear Logs
              </button>
            </div>
          </div>

          {error && (
            <div className="logs-error">
              Error: {error}
            </div>
          )}

          <div className="logs-viewer">
            <pre className="logs-content">
              {logs || 'No logs available'}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
