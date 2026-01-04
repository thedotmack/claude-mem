import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';

// Log levels and components matching the logger.ts definitions
type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
type LogComponent = 'HOOK' | 'WORKER' | 'SDK' | 'PARSER' | 'DB' | 'SYSTEM' | 'HTTP' | 'SESSION' | 'CHROMA';

interface ParsedLogLine {
  raw: string;
  timestamp?: string;
  level?: LogLevel;
  component?: LogComponent;
  correlationId?: string;
  message?: string;
  isSpecial?: 'dataIn' | 'dataOut' | 'success' | 'failure' | 'timing' | 'happyPath';
}

// Configuration for log levels
const LOG_LEVELS: { key: LogLevel; label: string; icon: string; color: string }[] = [
  { key: 'DEBUG', label: 'Debug', icon: '🔍', color: '#8b8b8b' },
  { key: 'INFO', label: 'Info', icon: 'ℹ️', color: '#58a6ff' },
  { key: 'WARN', label: 'Warn', icon: '⚠️', color: '#d29922' },
  { key: 'ERROR', label: 'Error', icon: '❌', color: '#f85149' },
];

// Configuration for log components
const LOG_COMPONENTS: { key: LogComponent; label: string; icon: string; color: string }[] = [
  { key: 'HOOK', label: 'Hook', icon: '🪝', color: '#a371f7' },
  { key: 'WORKER', label: 'Worker', icon: '⚙️', color: '#58a6ff' },
  { key: 'SDK', label: 'SDK', icon: '📦', color: '#3fb950' },
  { key: 'PARSER', label: 'Parser', icon: '📄', color: '#79c0ff' },
  { key: 'DB', label: 'DB', icon: '🗄️', color: '#f0883e' },
  { key: 'SYSTEM', label: 'System', icon: '💻', color: '#8b949e' },
  { key: 'HTTP', label: 'HTTP', icon: '🌐', color: '#39d353' },
  { key: 'SESSION', label: 'Session', icon: '📋', color: '#db61a2' },
  { key: 'CHROMA', label: 'Chroma', icon: '🔮', color: '#a855f7' },
];

// Parse a single log line into structured data
function parseLogLine(line: string): ParsedLogLine {
  // Pattern: [timestamp] [LEVEL] [COMPONENT] [correlation?] message
  // Example: [2025-01-02 14:30:45.123] [INFO ] [WORKER] [session-123] → message
  const pattern = /^\[([^\]]+)\]\s+\[(\w+)\s*\]\s+\[(\w+)\s*\]\s+(?:\[([^\]]+)\]\s+)?(.*)$/;
  const match = line.match(pattern);

  if (!match) {
    return { raw: line };
  }

  const [, timestamp, level, component, correlationId, message] = match;

  // Detect special message types
  let isSpecial: ParsedLogLine['isSpecial'] = undefined;
  if (message.startsWith('→')) isSpecial = 'dataIn';
  else if (message.startsWith('←')) isSpecial = 'dataOut';
  else if (message.startsWith('✓')) isSpecial = 'success';
  else if (message.startsWith('✗')) isSpecial = 'failure';
  else if (message.startsWith('⏱')) isSpecial = 'timing';
  else if (message.includes('[HAPPY-PATH]')) isSpecial = 'happyPath';

  return {
    raw: line,
    timestamp,
    level: level?.trim() as LogLevel,
    component: component?.trim() as LogComponent,
    correlationId: correlationId || undefined,
    message,
    isSpecial,
  };
}

interface LogsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LogsDrawer({ isOpen, onClose }: LogsDrawerProps) {
  const [logs, setLogs] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [height, setHeight] = useState(350);
  const [isResizing, setIsResizing] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  // Filter state
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(
    new Set(['DEBUG', 'INFO', 'WARN', 'ERROR'])
  );
  const [activeComponents, setActiveComponents] = useState<Set<LogComponent>>(
    new Set(['HOOK', 'WORKER', 'SDK', 'PARSER', 'DB', 'SYSTEM', 'HTTP', 'SESSION', 'CHROMA'])
  );
  const [alignmentOnly, setAlignmentOnly] = useState(false);

  // Parse and filter log lines
  const parsedLines = useMemo(() => {
    if (!logs) return [];
    return logs.split('\n').map(parseLogLine);
  }, [logs]);

  const filteredLines = useMemo(() => {
    return parsedLines.filter(line => {
      // Alignment filter - if enabled, only show [ALIGNMENT] lines
      if (alignmentOnly) {
        return line.raw.includes('[ALIGNMENT]');
      }
      // Always show unparsed lines
      if (!line.level || !line.component) return true;
      return activeLevels.has(line.level) && activeComponents.has(line.component);
    });
  }, [parsedLines, activeLevels, activeComponents, alignmentOnly]);

  // Check if user is at bottom before updating
  const checkIfAtBottom = useCallback(() => {
    if (!contentRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    if (contentRef.current && wasAtBottomRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    // Save scroll position before fetch
    wasAtBottomRef.current = checkIfAtBottom();

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
  }, [checkIfAtBottom]);

  // Scroll to bottom after logs update
  useEffect(() => {
    scrollToBottom();
  }, [logs, scrollToBottom]);

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
      wasAtBottomRef.current = true; // Start at bottom on open
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

  // Toggle level filter
  const toggleLevel = useCallback((level: LogLevel) => {
    setActiveLevels(prev => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  }, []);

  // Toggle component filter
  const toggleComponent = useCallback((component: LogComponent) => {
    setActiveComponents(prev => {
      const next = new Set(prev);
      if (next.has(component)) {
        next.delete(component);
      } else {
        next.add(component);
      }
      return next;
    });
  }, []);

  // Select all / none for levels
  const setAllLevels = useCallback((enabled: boolean) => {
    if (enabled) {
      setActiveLevels(new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']));
    } else {
      setActiveLevels(new Set());
    }
  }, []);

  // Select all / none for components
  const setAllComponents = useCallback((enabled: boolean) => {
    if (enabled) {
      setActiveComponents(new Set(['HOOK', 'WORKER', 'SDK', 'PARSER', 'DB', 'SYSTEM', 'HTTP', 'SESSION', 'CHROMA']));
    } else {
      setActiveComponents(new Set());
    }
  }, []);

  if (!isOpen) {
    return null;
  }

  // Get style for a parsed log line
  const getLineStyle = (line: ParsedLogLine): React.CSSProperties => {
    const levelConfig = LOG_LEVELS.find(l => l.key === line.level);
    const componentConfig = LOG_COMPONENTS.find(c => c.key === line.component);

    let color = 'var(--color-text-primary)';
    let fontWeight = 'normal';
    let backgroundColor = 'transparent';

    if (line.level === 'ERROR') {
      color = '#f85149';
      backgroundColor = 'rgba(248, 81, 73, 0.1)';
    } else if (line.level === 'WARN') {
      color = '#d29922';
      backgroundColor = 'rgba(210, 153, 34, 0.05)';
    } else if (line.isSpecial === 'success') {
      color = '#3fb950';
    } else if (line.isSpecial === 'failure') {
      color = '#f85149';
    } else if (line.isSpecial === 'happyPath') {
      color = '#d29922';
    } else if (levelConfig) {
      color = levelConfig.color;
    }

    return { color, fontWeight, backgroundColor, padding: '1px 0', borderRadius: '2px' };
  };

  // Render a single log line with syntax highlighting
  const renderLogLine = (line: ParsedLogLine, index: number) => {
    if (!line.timestamp) {
      // Unparsed line - render as-is
      return (
        <div key={index} className="log-line log-line-raw">
          {line.raw}
        </div>
      );
    }

    const levelConfig = LOG_LEVELS.find(l => l.key === line.level);
    const componentConfig = LOG_COMPONENTS.find(c => c.key === line.component);

    return (
      <div key={index} className="log-line" style={getLineStyle(line)}>
        <span className="log-timestamp">[{line.timestamp}]</span>
        {' '}
        <span className="log-level" style={{ color: levelConfig?.color }} title={line.level}>
          [{levelConfig?.icon || ''} {line.level?.padEnd(5)}]
        </span>
        {' '}
        <span className="log-component" style={{ color: componentConfig?.color }} title={line.component}>
          [{componentConfig?.icon || ''} {line.component?.padEnd(7)}]
        </span>
        {' '}
        {line.correlationId && (
          <>
            <span className="log-correlation">[{line.correlationId}]</span>
            {' '}
          </>
        )}
        <span className="log-message">{line.message}</span>
      </div>
    );
  };

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
            className="console-control-btn"
            onClick={() => {
              wasAtBottomRef.current = true;
              scrollToBottom();
            }}
            title="Scroll to bottom"
          >
            ⬇
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

      {/* Filter Bar */}
      <div className="console-filters">
        <div className="console-filter-section">
          <span className="console-filter-label">Quick:</span>
          <div className="console-filter-chips">
            <button
              className={`console-filter-chip ${alignmentOnly ? 'active' : ''}`}
              onClick={() => setAlignmentOnly(!alignmentOnly)}
              style={{
                '--chip-color': '#f0883e',
              } as React.CSSProperties}
              title="Show only session alignment logs"
            >
              🔗 Alignment
            </button>
          </div>
        </div>
        <div className="console-filter-section">
          <span className="console-filter-label">Levels:</span>
          <div className="console-filter-chips">
            {LOG_LEVELS.map(level => (
              <button
                key={level.key}
                className={`console-filter-chip ${activeLevels.has(level.key) ? 'active' : ''}`}
                onClick={() => toggleLevel(level.key)}
                style={{
                  '--chip-color': level.color,
                } as React.CSSProperties}
                title={level.label}
              >
                {level.icon} {level.label}
              </button>
            ))}
            <button
              className="console-filter-action"
              onClick={() => setAllLevels(activeLevels.size === 0)}
              title={activeLevels.size === LOG_LEVELS.length ? 'Select none' : 'Select all'}
            >
              {activeLevels.size === LOG_LEVELS.length ? '○' : '●'}
            </button>
          </div>
        </div>
        <div className="console-filter-section">
          <span className="console-filter-label">Components:</span>
          <div className="console-filter-chips">
            {LOG_COMPONENTS.map(comp => (
              <button
                key={comp.key}
                className={`console-filter-chip ${activeComponents.has(comp.key) ? 'active' : ''}`}
                onClick={() => toggleComponent(comp.key)}
                style={{
                  '--chip-color': comp.color,
                } as React.CSSProperties}
                title={comp.label}
              >
                {comp.icon} {comp.label}
              </button>
            ))}
            <button
              className="console-filter-action"
              onClick={() => setAllComponents(activeComponents.size === 0)}
              title={activeComponents.size === LOG_COMPONENTS.length ? 'Select none' : 'Select all'}
            >
              {activeComponents.size === LOG_COMPONENTS.length ? '○' : '●'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="console-error">
          ⚠ {error}
        </div>
      )}

      <div className="console-content" ref={contentRef}>
        <div className="console-logs">
          {filteredLines.length === 0 ? (
            <div className="log-line log-line-empty">No logs available</div>
          ) : (
            filteredLines.map((line, index) => renderLogLine(line, index))
          )}
        </div>
      </div>
    </div>
  );
}
