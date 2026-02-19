import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { LogLine } from './LogLine';
import { LogFilterBar, LOG_LEVELS, LOG_COMPONENTS } from './LogFilterBar';

// ---------------------------------------------------------------------------
// Types — exported for unit testing
// ---------------------------------------------------------------------------

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
type LogComponent = 'HOOK' | 'WORKER' | 'SDK' | 'PARSER' | 'DB' | 'SYSTEM' | 'HTTP' | 'SESSION' | 'CHROMA';

export interface ParsedLogLine {
  raw: string;
  timestamp?: string;
  level?: LogLevel;
  component?: LogComponent;
  correlationId?: string;
  message?: string;
  isSpecial?: 'dataIn' | 'dataOut' | 'success' | 'failure' | 'timing' | 'happyPath';
}

// ---------------------------------------------------------------------------
// Pure functions — exported for unit testing
// ---------------------------------------------------------------------------

export function parseLogLine(line: string): ParsedLogLine {
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
    level: level.trim() as LogLevel,
    component: component.trim() as LogComponent,
    correlationId: correlationId || undefined,
    message,
    isSpecial,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface LogsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function LogsDrawer({ isOpen, onClose }: LogsDrawerProps) {
  // Log data
  const [logs, setLogs] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  // Resize
  const [height, setHeight] = useState(350);
  const [isResizing, setIsResizing] = useState(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // Scroll tracking
  const contentRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  // Filters
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(
    () => new Set(LOG_LEVELS.map(l => l.key) as LogLevel[]),
  );
  const [activeComponents, setActiveComponents] = useState<Set<LogComponent>>(
    () => new Set(LOG_COMPONENTS.map(c => c.key) as LogComponent[]),
  );
  const [alignmentOnly, setAlignmentOnly] = useState(false);

  // Parse and filter log lines
  const parsedLines = useMemo(() => {
    if (!logs) return [];
    return logs.split('\n').map(parseLogLine);
  }, [logs]);

  const filteredLines = useMemo(() => {
    return parsedLines
      .map((line, originalIndex) => ({ line, originalIndex }))
      .filter(({ line }) => {
        if (alignmentOnly) return line.raw.includes('[ALIGNMENT]');
        if (!line.level || !line.component) return true;
        return activeLevels.has(line.level) && activeComponents.has(line.component);
      });
  }, [parsedLines, activeLevels, activeComponents, alignmentOnly]);

  // Scroll helpers
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

  // Fetch logs
  const fetchLogs = useCallback(async () => {
    wasAtBottomRef.current = checkIfAtBottom();
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/logs');
      if (!response.ok) throw new Error(`Failed to fetch logs: ${response.statusText}`);
      const data = await response.json() as { logs?: string };
      setLogs(data.logs || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [checkIfAtBottom]);

  // Scroll to bottom after logs update
  useEffect(() => { scrollToBottom(); }, [logs, scrollToBottom]);

  // Clear logs
  const handleClearLogs = useCallback(async () => {
    if (!confirm('Are you sure you want to clear all logs?')) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/logs/clear', { method: 'POST' });
      if (!response.ok) throw new Error(`Failed to clear logs: ${response.statusText}`);
      setLogs('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Resize handling
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
      setHeight(Math.min(Math.max(150, startHeightRef.current + deltaY), window.innerHeight - 100));
    };
    const handleMouseUp = () => { setIsResizing(false); };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Fetch on open
  useEffect(() => {
    if (isOpen) {
      wasAtBottomRef.current = true;
      void fetchLogs();
    }
  }, [isOpen, fetchLogs]);

  // Auto-refresh
  useEffect(() => {
    if (!isOpen || !autoRefresh) return;
    const interval = setInterval(() => { void fetchLogs(); }, 2000);
    return () => { clearInterval(interval); };
  }, [isOpen, autoRefresh, fetchLogs]);

  if (!isOpen) return null;

  return (
    <div className="console-drawer" style={{ height: `${String(height)}px` }}>
      <div className="console-resize-handle" onMouseDown={handleMouseDown}>
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
              onChange={(e) => { setAutoRefresh(e.target.checked); }}
            />
            Auto-refresh
          </label>
          <button className="console-control-btn" onClick={() => { void fetchLogs(); }} disabled={isLoading} title="Refresh logs">
            ↻
          </button>
          <button className="console-control-btn" onClick={() => { wasAtBottomRef.current = true; scrollToBottom(); }} title="Scroll to bottom">
            ⬇
          </button>
          <button className="console-control-btn console-clear-btn" onClick={() => { void handleClearLogs(); }} disabled={isLoading} title="Clear logs">
            🗑
          </button>
          <button className="console-control-btn" onClick={onClose} title="Close console">
            ✕
          </button>
        </div>
      </div>

      <LogFilterBar
        activeLevels={activeLevels}
        activeComponents={activeComponents}
        alignmentOnly={alignmentOnly}
        onActiveLevelsChange={setActiveLevels}
        onActiveComponentsChange={setActiveComponents}
        onAlignmentOnlyChange={setAlignmentOnly}
      />

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
            filteredLines.map(({ line, originalIndex }) => (
              <LogLine key={originalIndex} line={line} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
