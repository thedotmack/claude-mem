import React, { useState, useEffect, useRef, useCallback } from 'react';

interface LiveTerminalProps {
  agentLogs: Record<string, string[]>;
}

function TerminalPane({ name, lines, color }: { name: string; lines: string[]; color: string }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length]);

  return (
    <div className="live-terminal-pane">
      <div className="live-terminal-header" style={{ borderBottomColor: color }}>
        <span className="live-terminal-dot" style={{ background: color }} />
        <span className="live-terminal-name">{name}</span>
        <span className="live-terminal-line-count">{lines.length} lines</span>
      </div>
      <div className="live-terminal-body">
        {lines.length === 0 ? (
          <div className="live-terminal-empty">Waiting for activity...</div>
        ) : (
          lines.map((line, i) => (
            <div key={i} className="live-terminal-line">
              <span className="live-terminal-lineno">{i + 1}</span>
              <span className="live-terminal-text">{line}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

export function LiveTerminal({ agentLogs }: LiveTerminalProps) {
  const [claudeLogs, setClaudeLogs] = useState<string[]>([]);
  const [codexLogs, setCodexLogs] = useState<string[]>([]);
  const [isPolling, setIsPolling] = useState(true);

  const fetchLogs = useCallback(async () => {
    try {
      // Fetch codex live log
      const codexRes = await fetch('/api/logs/live?agent=codex&tail=200');
      if (codexRes.ok) {
        const data = await codexRes.json();
        if (data.lines) setCodexLogs(data.lines);
      }

      // Fetch claude-code live log
      const claudeRes = await fetch('/api/logs/live?agent=claude-code&tail=200');
      if (claudeRes.ok) {
        const data = await claudeRes.json();
        if (data.lines) setClaudeLogs(data.lines);
      }
    } catch {
      // Silently fail — logs may not exist yet
    }
  }, []);

  useEffect(() => {
    if (!isPolling) return;
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [fetchLogs, isPolling]);

  // Also merge in any SSE-provided logs
  useEffect(() => {
    if (agentLogs['claude-code']?.length) {
      setClaudeLogs(prev => {
        const merged = [...prev, ...agentLogs['claude-code']];
        return merged.slice(-500);
      });
    }
    if (agentLogs['codex']?.length) {
      setCodexLogs(prev => {
        const merged = [...prev, ...agentLogs['codex']];
        return merged.slice(-500);
      });
    }
  }, [agentLogs]);

  return (
    <div className="live-terminal-container">
      <div className="live-terminal-toolbar">
        <h2 className="live-terminal-title">Live Agent Activity</h2>
        <div className="live-terminal-controls">
          <button
            className={`plan-form-btn-sm ${isPolling ? 'live-terminal-active' : ''}`}
            onClick={() => setIsPolling(!isPolling)}
          >
            {isPolling ? 'Pause' : 'Resume'}
          </button>
          <button
            className="plan-form-btn-sm"
            onClick={() => { setClaudeLogs([]); setCodexLogs([]); }}
          >
            Clear
          </button>
        </div>
      </div>
      <div className="live-terminal-split">
        <TerminalPane name="claude-code" lines={claudeLogs} color="var(--color-accent-primary)" />
        <TerminalPane name="codex" lines={codexLogs} color="var(--color-accent-success)" />
      </div>
    </div>
  );
}
