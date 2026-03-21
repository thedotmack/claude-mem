import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TokenUsageEvent, AgentErrorEvent, AgentActivityEvent } from '../types';
import { TokenCounter } from './TokenCounter';
import { AgentActivityPanel } from './AgentActivityPanel';
import { DebugPanel } from './DebugPanel';

interface LiveTerminalProps {
  agentLogs: Record<string, string[]>;
  tokenEvents: TokenUsageEvent[];
  agentErrors: AgentErrorEvent[];
  agentActivity: Record<number, AgentActivityEvent>;
  onClearErrors: () => void;
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

type LiveTab = 'terminals' | 'activity' | 'debug';

export function LiveTerminal({ agentLogs, tokenEvents, agentErrors, agentActivity, onClearErrors }: LiveTerminalProps) {
  const [claudeLogs, setClaudeLogs] = useState<string[]>([]);
  const [codexLogs, setCodexLogs] = useState<string[]>([]);
  const [isPolling, setIsPolling] = useState(true);
  const [activeTab, setActiveTab] = useState<LiveTab>('terminals');

  const fetchLogs = useCallback(async () => {
    try {
      const codexRes = await fetch('/api/logs/live?agent=codex&tail=200');
      if (codexRes.ok) { const data = await codexRes.json(); if (data.lines) setCodexLogs(data.lines); }
      const claudeRes = await fetch('/api/logs/live?agent=claude-code&tail=200');
      if (claudeRes.ok) { const data = await claudeRes.json(); if (data.lines) setClaudeLogs(data.lines); }
    } catch { /* logs may not exist yet */ }
  }, []);

  useEffect(() => {
    if (!isPolling) return;
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => clearInterval(interval);
  }, [fetchLogs, isPolling]);

  useEffect(() => {
    if (agentLogs['claude-code']?.length) {
      setClaudeLogs(prev => [...prev, ...agentLogs['claude-code']].slice(-500));
    }
    if (agentLogs['codex']?.length) {
      setCodexLogs(prev => [...prev, ...agentLogs['codex']].slice(-500));
    }
  }, [agentLogs]);

  const errorCount = agentErrors.length;
  const activeCount = Object.values(agentActivity).filter(a => a.status === 'calling_api' || a.status === 'processing_response').length;

  const tabs: { id: LiveTab; label: string; badge?: number; badgeColor?: string }[] = [
    { id: 'activity', label: 'Activity', badge: activeCount > 0 ? activeCount : undefined, badgeColor: '#60a5fa' },
    { id: 'terminals', label: 'Terminals' },
    { id: 'debug', label: 'Debug', badge: errorCount > 0 ? errorCount : undefined, badgeColor: '#f87171' },
  ];

  return (
    <div className="live-terminal-container">
      {/* Token counter strip — always visible */}
      <div style={{ marginBottom: '12px' }}>
        <TokenCounter tokenEvents={tokenEvents} />
      </div>

      {/* Tab navigation */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px', alignItems: 'center' }}>
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            style={{
              background: activeTab === tab.id ? 'var(--accent-color, #7c3aed)' : 'var(--bg-secondary, #16213e)',
              color: activeTab === tab.id ? '#fff' : 'var(--text-secondary, #888)',
              border: `1px solid ${activeTab === tab.id ? 'var(--accent-color, #7c3aed)' : 'var(--border-color, #333)'}`,
              borderRadius: '6px', padding: '6px 14px', fontSize: '12px', cursor: 'pointer',
              fontWeight: activeTab === tab.id ? 600 : 400, display: 'flex', alignItems: 'center', gap: '6px',
              transition: 'all 0.15s ease'
            }}>
            {tab.label}
            {tab.badge != null && tab.badge > 0 && (
              <span style={{
                background: tab.badgeColor || '#f87171',
                color: '#fff', fontSize: '10px', fontWeight: 700,
                padding: '1px 6px', borderRadius: '8px', minWidth: '16px', textAlign: 'center'
              }}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}

        {/* Polling controls (only for terminals tab) */}
        {activeTab === 'terminals' && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '4px' }}>
            <button className={`plan-form-btn-sm ${isPolling ? 'live-terminal-active' : ''}`}
              onClick={() => setIsPolling(!isPolling)}>
              {isPolling ? 'Pause' : 'Resume'}
            </button>
            <button className="plan-form-btn-sm"
              onClick={() => { setClaudeLogs([]); setCodexLogs([]); }}>
              Clear
            </button>
          </div>
        )}
      </div>

      {/* Tab content */}
      {activeTab === 'terminals' && (
        <div className="live-terminal-split">
          <TerminalPane name="claude-code" lines={claudeLogs} color="var(--color-accent-primary)" />
          <TerminalPane name="codex" lines={codexLogs} color="var(--color-accent-success)" />
        </div>
      )}

      {activeTab === 'activity' && (
        <AgentActivityPanel agentActivity={agentActivity} agentErrors={agentErrors} />
      )}

      {activeTab === 'debug' && (
        <DebugPanel errors={agentErrors} onClear={onClearErrors} />
      )}
    </div>
  );
}
