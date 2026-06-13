import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { authFetch } from '../utils/api';

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

const LOG_LEVELS: { key: LogLevel; label: string; icon: string; color: string }[] = [
  { key: 'DEBUG', label: 'Debug', icon: '🔍', color: '#8b8b8b' },
  { key: 'INFO', label: 'Info', icon: 'ℹ️', color: '#58a6ff' },
  { key: 'WARN', label: 'Warn', icon: '⚠️', color: '#d29922' },
  { key: 'ERROR', label: 'Error', icon: '❌', color: '#f85149' },
];

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

function parseLogLine(line: string): ParsedLogLine {
  const pattern = /^\[([^\]]+)\]\s+\[(\w+)\s*\]\s+\[(\w+)\s*\]\s+(?:\[([^\]]+)\]\s+)?(.*)$/;
  const match = line.match(pattern);

  if (!match) {
    return { raw: line };
  }

  const [, timestamp, level, component, correlationId, message] = match;

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

const CONSOLE_STYLES = `
.console-drawer {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 120;
  display: flex; flex-direction: column;
  background: var(--surface);
  border-top: 1px solid var(--border);
  box-shadow: var(--shadow-lg);
  font-family: var(--font-sans);
  color: var(--fg);
}
.console-resize-handle {
  position: relative; height: 10px; flex: 0 0 auto;
  display: grid; place-items: center; cursor: ns-resize;
  background: var(--surface-sunken); border-bottom: 1px solid var(--border-soft);
}
.console-resize-bar { width: 44px; height: 4px; border-radius: var(--r-pill); background: var(--border); }
.console-resize-handle:hover .console-resize-bar { background: var(--coral-300); }
.console-header {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-soft);
  background: var(--surface);
}
.console-tabs { display: flex; gap: var(--space-2); }
.console-tab {
  font-family: var(--font-display); font-weight: 600; font-size: 0.9375rem;
  color: var(--fg-3); padding: var(--space-1) var(--space-2);
  border-radius: var(--r-sm);
}
.console-tab.active { color: var(--fg); }
.console-controls { display: flex; align-items: center; gap: var(--space-2); }
.console-auto-refresh {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 0.8125rem; font-weight: 600; color: var(--fg-2); cursor: pointer;
}
.console-auto-refresh input { accent-color: var(--coral-500); }
.console-control-btn {
  display: grid; place-items: center; width: 30px; height: 30px;
  border-radius: var(--r-sm); border: 1px solid var(--border-soft);
  background: var(--surface); color: var(--fg-2); font-size: 0.95rem;
  transition: border-color var(--dur-fast, 140ms) var(--ease-out, ease), color var(--dur-fast, 140ms) var(--ease-out, ease), background var(--dur-fast, 140ms) var(--ease-out, ease);
}
.console-control-btn:hover { border-color: var(--coral-300); color: var(--fg); background: var(--surface-tint); }
.console-control-btn:disabled { opacity: 0.5; cursor: default; }
.console-clear-btn:hover { border-color: var(--danger); color: var(--danger); background: var(--danger-bg); }
.console-filters {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-4);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-soft);
  background: var(--surface-sunken);
}
.console-filter-section { display: flex; align-items: center; gap: var(--space-2); }
.console-filter-label {
  font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--fg-3);
}
.console-filter-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.console-filter-chip {
  display: inline-flex; align-items: center; gap: 4px;
  height: 24px; padding: 0 10px;
  border-radius: var(--r-pill); border: 1px solid var(--border-soft);
  background: var(--surface); color: var(--fg-3);
  font-size: 0.75rem; font-weight: 600;
  transition: border-color var(--dur-fast, 140ms) var(--ease-out, ease), color var(--dur-fast, 140ms) var(--ease-out, ease), background var(--dur-fast, 140ms) var(--ease-out, ease);
}
.console-filter-chip:hover { border-color: var(--border); color: var(--fg-2); }
.console-filter-chip.active {
  border-color: var(--chip-color, var(--coral-500));
  color: var(--chip-color, var(--coral-600));
  background: var(--surface-tint);
}
.console-filter-action {
  display: grid; place-items: center; width: 24px; height: 24px;
  border-radius: var(--r-pill); border: 1px solid var(--border-soft);
  background: var(--surface); color: var(--fg-3); font-size: 0.7rem;
}
.console-filter-action:hover { border-color: var(--coral-300); color: var(--fg); }
.console-error {
  padding: var(--space-2) var(--space-4);
  background: var(--danger-bg); color: var(--danger);
  font-size: 0.8125rem; font-weight: 600;
}
.console-content {
  flex: 1; overflow: auto;
  background: var(--surface-sunken);
  scrollbar-width: thin; scrollbar-color: var(--border) transparent;
}
.console-logs {
  padding: var(--space-3) var(--space-4);
  font-family: var(--font-mono); font-size: 0.78rem; line-height: 1.55;
}
.log-line { white-space: pre-wrap; word-break: break-word; }
.log-line-raw { color: var(--fg-3); }
.log-line-empty { color: var(--fg-3); font-style: italic; padding: var(--space-2) 0; }
.log-timestamp { color: var(--fg-3); }
.log-correlation { color: var(--info); }
.log-message { color: inherit; }
`;

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

  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(
    new Set(['DEBUG', 'INFO', 'WARN', 'ERROR'])
  );
  const [activeComponents, setActiveComponents] = useState<Set<LogComponent>>(
    new Set(['HOOK', 'WORKER', 'SDK', 'PARSER', 'DB', 'SYSTEM', 'HTTP', 'SESSION', 'CHROMA'])
  );
  const [alignmentOnly, setAlignmentOnly] = useState(false);

  const parsedLines = useMemo(() => {
    if (!logs) return [];
    return logs.split('\n').map(parseLogLine);
  }, [logs]);

  const filteredLines = useMemo(() => {
    return parsedLines.filter(line => {
      if (alignmentOnly) {
        return line.raw.includes('[ALIGNMENT]');
      }
      if (!line.level || !line.component) return true;
      return activeLevels.has(line.level) && activeComponents.has(line.component);
    });
  }, [parsedLines, activeLevels, activeComponents, alignmentOnly]);

  const checkIfAtBottom = useCallback(() => {
    if (!contentRef.current) return true;
    const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (contentRef.current && wasAtBottomRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    wasAtBottomRef.current = checkIfAtBottom();

    setIsLoading(true);
    setError(null);
    try {
      const response = await authFetch('/api/logs');
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
      const response = await authFetch('/api/logs/clear', { method: 'POST' });
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

  useEffect(() => {
    if (isOpen) {
      wasAtBottomRef.current = true; 
      fetchLogs();
    }
  }, [isOpen, fetchLogs]);

  useEffect(() => {
    if (!isOpen || !autoRefresh) {
      return;
    }

    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [isOpen, autoRefresh, fetchLogs]);

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

  const setAllLevels = useCallback((enabled: boolean) => {
    if (enabled) {
      setActiveLevels(new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']));
    } else {
      setActiveLevels(new Set());
    }
  }, []);

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

  const getLineStyle = (line: ParsedLogLine): React.CSSProperties => {
    const levelConfig = LOG_LEVELS.find(l => l.key === line.level);
    const componentConfig = LOG_COMPONENTS.find(c => c.key === line.component);

    let color = 'var(--fg)';
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

  const renderLogLine = (line: ParsedLogLine, index: number) => {
    if (!line.timestamp) {
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
      <style>{CONSOLE_STYLES}</style>
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
