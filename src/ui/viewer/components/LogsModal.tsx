import React, { useState, useEffect, useCallback, useRef } from 'react';

interface LogsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LogsDrawer({ isOpen, onClose }: LogsDrawerProps) {
  const [logs, setLogs] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [height, setHeight] = useState(300); // Default height
  const [isResizing, setIsResizing] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

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

  // Handle resize
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    startYRef.current = e.clientY;
    startHeightRef.current = height;
  }, [height]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = startYRef.current - e.clientY;
      const newHeight = Math.min(Math.max(150, startHeightRef.current + deltaY), window.innerHeight - 100);
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Fetch logs when drawer opens
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
    <div className="console-drawer" style={{ height: `${height}px` }}>
      <div
        className="console-resize-handle"
        onMouseDown={handleMouseDown}
      >
        <div className="console-resize-bar" />
      </div>

      <div className="console-header">
        <div className="console-tabs">
          <div className="console-tab active">Console</div>
        </div>
        <div className="console-controls">
          <label className="console-auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            Auto-refresh
          </label>
          <button
            className="console-control-btn"
            onClick={fetchLogs}
            disabled={isLoading}
            title="Refresh logs"
          >
            ↻
          </button>
          <button
            className="console-control-btn console-clear-btn"
            onClick={handleClearLogs}
            disabled={isLoading}
            title="Clear logs"
          >
            🗑
          </button>
          <button
            className="console-control-btn"
            onClick={onClose}
            title="Close console"
          >
            ✕
          </button>
        </div>
      </div>

      {error && (
        <div className="console-error">
          ⚠ {error}
        </div>
      )}

      <div className="console-content">
        <pre className="console-logs">
          {logs || 'No logs available'}
        </pre>
      </div>
    </div>
  );
}
