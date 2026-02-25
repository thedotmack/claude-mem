/**
 * SessionRegistryPage
 *
 * Full-page session registry browser. Shows sessions from:
 *   - ~/.claude/projects (Claude Code)
 *   - ~/.openclaw/agents (OpenClaw)
 *   - ~/.codex/sessions (Codex)
 *
 * Features: search, status/source/project filters, event viewer, stats,
 * subagent list (with drill-down to subagent events).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RegistrySession {
  sessionId: string;
  project: string;
  source: 'claude' | 'openclaw' | 'codex';
  slug: string;
  status: 'active' | 'completed';
  model: string;
  version: string;
  mtime: number;
  size: number;
  eventCount: number;
  cwd: string;
  gitBranch: string;
  subagentCount: number;
  duration: number;
  contextPct: number;
}

interface RegistrySubagent {
  id: string;
  parentId: string;
  agentType: string;
  slug: string;
  model: string;
  status: 'active' | 'completed';
  mtime: number;
  size?: number;
  eventCount?: number;
  filename?: string;
  ephemeral?: boolean;
  spawnStatus?: string;
  runId?: string;
  childSessionKey?: string;
  timestamp?: string;
}

interface RegistryEvent {
  type: string;
  uuid: string;
  timestamp: string;
  text?: string;
  model?: string;
  userType?: string;
  subtype?: string;
  hasThinking?: boolean;
  truncated?: boolean;
  tool_uses?: ToolUse[];
  tool_results?: ToolResult[];
  usage?: UsageInfo;
  stop_reason?: string;
  [key: string]: unknown;
}

interface ToolUse {
  id: string;
  name: string;
  input: string;
  type: string;
  truncated?: boolean;
}

interface ToolResult {
  tool_use_id: string;
  content: string;
  type: string;
  is_error?: boolean;
  truncated?: boolean;
}

interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
}

interface SessionStats {
  model: string;
  version: string;
  cwd: string;
  gitBranch: string;
  tokens: { input: number; output: number; cache_read: number; cache_creation: number };
  tool_calls: Record<string, number>;
  event_counts: Record<string, number>;
  first_timestamp: string;
  last_timestamp: string;
  duration_seconds: number;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

const BASE = '/api/session-registry';
const LIVE_POLL_MS = 5000;
const LIVE_SSE_DEBOUNCE_MS = 500;
const LIVE_UPDATE_EVENT_TYPES = new Set([
  'new_prompt',
  'new_observation',
  'new_summary',
  'session_started',
  'session_completed',
  'observation_queued',
  'processing_status',
]);

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function useSessionRegistryLiveTick(): number {
  const [tick, setTick] = useState(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const bump = () => setTick(prev => prev + 1);
    const scheduleBump = () => {
      if (debounceTimerRef.current) return;
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        bump();
      }, LIVE_SSE_DEBOUNCE_MS);
    };

    const interval = window.setInterval(bump, LIVE_POLL_MS);
    const eventSource = new EventSource('/stream');

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string };
        if (data.type && LIVE_UPDATE_EVENT_TYPES.has(data.type)) {
          scheduleBump();
        }
      } catch {
        scheduleBump();
      }
    };

    const onFocus = () => bump();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') bump();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.clearInterval(interval);
      eventSource.close();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  return tick;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatRelTime(epochSec: number): string {
  const diffSec = Math.floor(Date.now() / 1000 - epochSec);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function formatDurationCompact(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── EventBlock ───────────────────────────────────────────────────────────────

function EventBlock({ event }: { event: RegistryEvent }) {
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());

  const toggleTool = (id: string) => setExpandedTools(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleResult = (id: string) => setExpandedResults(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const typeLabel = event.type === 'user'
    ? (event.userType === 'tool_result' ? 'Tool Result' : 'User')
    : event.type === 'assistant' ? 'Assistant'
    : event.type === 'system' ? 'System'
    : event.type;

  const typeColor: Record<string, string> = {
    user: 'var(--color-accent-prompt)',
    assistant: 'var(--color-accent-observation)',
    system: 'var(--color-text-muted)',
  };
  const color = typeColor[event.type] || 'var(--color-text-muted)';

  const ts = event.timestamp
    ? new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';

  return (
    <div style={{
      borderLeft: `3px solid ${color}`,
      paddingLeft: '10px',
      marginBottom: '10px',
      opacity: event.type === 'system' ? 0.7 : 1,
    }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' }}>
        <span style={{ fontSize: '11px', fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{typeLabel}</span>
        {event.model && <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{event.model}</span>}
        {event.hasThinking && <span style={{ fontSize: '10px', color: 'var(--color-accent-summary)', border: '1px solid var(--color-accent-summary)', borderRadius: '4px', padding: '0 4px' }}>thinking</span>}
        {ts && <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', marginLeft: 'auto' }}>{ts}</span>}
        {event.usage && (event.usage.input_tokens || event.usage.output_tokens) ? (
          <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>
            ↑{formatNum(event.usage.input_tokens || 0)} ↓{formatNum(event.usage.output_tokens || 0)}
          </span>
        ) : null}
      </div>

      {/* System event subtype */}
      {event.type === 'system' && event.subtype && (
        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', fontStyle: 'italic' }}>{event.subtype}</div>
      )}

      {/* Text content */}
      {event.text && (
        <div style={{
          fontSize: '13px',
          lineHeight: '1.5',
          color: 'var(--color-text-primary)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: '300px',
          overflowY: 'auto',
        }}>
          {event.text}
          {event.truncated && <span style={{ color: 'var(--color-text-muted)' }}> [truncated]</span>}
        </div>
      )}

      {/* Tool uses */}
      {event.tool_uses?.map((tu) => (
        <div key={tu.id} style={{
          background: 'var(--color-bg-stat)',
          border: '1px solid var(--color-border-primary)',
          borderRadius: '6px',
          padding: '6px 10px',
          marginTop: '6px',
          fontSize: '12px',
        }}>
          <div
            onClick={() => toggleTool(tu.id)}
            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <span style={{ color: 'var(--color-accent-primary)', fontWeight: 600 }}>🔧 {tu.name}</span>
            <span style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}>{expandedTools.has(tu.id) ? '▲' : '▼'}</span>
          </div>
          {expandedTools.has(tu.id) && (
            <pre style={{
              marginTop: '4px', fontSize: '11px', whiteSpace: 'pre-wrap',
              wordBreak: 'break-all', color: 'var(--color-text-secondary)',
              maxHeight: '200px', overflowY: 'auto',
            }}>
              {tu.input}{tu.truncated ? ' [truncated]' : ''}
            </pre>
          )}
        </div>
      ))}

      {/* Tool results */}
      {event.tool_results?.map((tr, i) => {
        const resultKey = `${tr.tool_use_id || 'tool-result'}-${i}`;
        const isOpen = expandedResults.has(resultKey);
        const preview = tr.content.length > 140 ? `${tr.content.slice(0, 140)}…` : tr.content;
        return (
          <div key={i} style={{
            background: tr.is_error ? 'rgba(231,72,86,0.06)' : 'var(--color-bg-stat)',
            border: `1px solid ${tr.is_error ? 'var(--color-accent-error)' : 'var(--color-border-primary)'}`,
            borderRadius: '6px',
            padding: '6px 10px',
            marginTop: '6px',
            fontSize: '12px',
          }}>
            <div
              onClick={() => toggleResult(resultKey)}
              style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <span style={{ color: tr.is_error ? 'var(--color-accent-error)' : 'var(--color-text-muted)', fontSize: '10px' }}>
                {tr.is_error ? '✗ Error' : '✓ Result'} (tool_use_id: {tr.tool_use_id?.slice(-8)})
              </span>
              <span style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}>{isOpen ? '▲' : '▼'}</span>
            </div>
            {!isOpen && (
              <div
                style={{
                  marginTop: '4px',
                  fontSize: '11px',
                  color: 'var(--color-text-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {preview}{tr.truncated ? ' [truncated]' : ''}
              </div>
            )}
            {isOpen && (
              <pre style={{
                marginTop: '4px', fontSize: '11px', whiteSpace: 'pre-wrap',
                wordBreak: 'break-all', color: 'var(--color-text-secondary)',
                maxHeight: '200px', overflowY: 'auto',
              }}>
                {tr.content}{tr.truncated ? ' [truncated]' : ''}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── SessionEventList ─────────────────────────────────────────────────────────

function SessionEventList({ sessionId, liveTick }: { sessionId: string; liveTick: number }) {
  const [events, setEvents] = useState<RegistryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const lastUuidRef = useRef<string | null>(null);

  const loadEvents = useCallback(async (after?: string) => {
    try {
      const url = after
        ? `${BASE}/${encodeURIComponent(sessionId)}/events?after=${encodeURIComponent(after)}&limit=100`
        : `${BASE}/${encodeURIComponent(sessionId)}/events?limit=100`;
      const data = await apiGet<{ events: RegistryEvent[] }>(url);
      const evts = data.events || [];
      if (after) {
        setEvents(prev => [...prev, ...evts]);
      } else {
        setEvents(evts);
      }
      setHasMore(evts.length === 100);
      if (evts.length > 0) {
        lastUuidRef.current = evts[evts.length - 1].uuid;
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setEvents([]);
    lastUuidRef.current = null;
    setHasMore(false);
    loadEvents().finally(() => setLoading(false));
  }, [sessionId, loadEvents]);

  const loadMore = async () => {
    if (!lastUuidRef.current || loadingMore) return;
    setLoadingMore(true);
    await loadEvents(lastUuidRef.current);
    setLoadingMore(false);
  };

  useEffect(() => {
    if (!liveTick || !lastUuidRef.current) return;

    const after = lastUuidRef.current;
    const url = `${BASE}/${encodeURIComponent(sessionId)}/events?after=${encodeURIComponent(after)}&limit=100`;
    apiGet<{ events: RegistryEvent[] }>(url)
      .then((data) => {
        const evts = data.events || [];
        if (evts.length === 0) return;
        setEvents(prev => [...prev, ...evts]);
        lastUuidRef.current = evts[evts.length - 1].uuid;
      })
      .catch(() => {
        // Keep UI stable on background refresh failures.
      });
  }, [liveTick, sessionId]);

  if (loading) return <div style={{ color: 'var(--color-text-muted)', padding: '20px' }}>Loading events…</div>;
  if (error) return <div style={{ color: 'var(--color-accent-error)', padding: '20px' }}>Error: {error}</div>;
  if (!events.length) return <div style={{ color: 'var(--color-text-muted)', padding: '20px' }}>No events found.</div>;

  return (
    <div>
      {events.map((ev, i) => (
        <EventBlock key={ev.uuid || i} event={ev} />
      ))}
      {hasMore && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          style={{
            marginTop: '10px', padding: '6px 16px',
            background: 'var(--color-bg-stat)', border: '1px solid var(--color-border-primary)',
            borderRadius: '6px', cursor: 'pointer', color: 'var(--color-text-primary)', fontSize: '12px',
          }}
        >
          {loadingMore ? 'Loading…' : 'Load more events'}
        </button>
      )}
    </div>
  );
}

// ─── SessionStatsPanel ────────────────────────────────────────────────────────

function SessionStatsPanel({ sessionId, liveTick }: { sessionId: string; liveTick: number }) {
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback((silent: boolean) => {
    if (!silent) setLoading(true);
    if (!silent) setError(null);
    return apiGet<SessionStats>(`${BASE}/${encodeURIComponent(sessionId)}/stats`)
      .then(setStats)
      .catch((e) => {
        if (!silent) setError((e as Error).message);
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, [sessionId]);

  useEffect(() => {
    fetchStats(false);
  }, [fetchStats]);

  useEffect(() => {
    if (!liveTick) return;
    fetchStats(true);
  }, [liveTick, fetchStats]);

  if (loading) return <div style={{ color: 'var(--color-text-muted)' }}>Loading stats…</div>;
  if (error) return <div style={{ color: 'var(--color-accent-error)' }}>Error: {error}</div>;
  if (!stats) return null;

  const sortedTools = Object.entries(stats.tool_calls).sort((a, b) => b[1] - a[1]);
  const totalTokens = stats.tokens.input + stats.tokens.output;

  return (
    <div style={{ fontSize: '13px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '12px' }}>
        {[
          ['Model', stats.model || '—'],
          ['Version', stats.version || '—'],
          ['Duration', stats.duration_seconds ? formatDuration(stats.duration_seconds) : '—'],
          ['Total Tokens', formatNum(totalTokens)],
          ['Input', formatNum(stats.tokens.input)],
          ['Output', formatNum(stats.tokens.output)],
          ['Cache Read', formatNum(stats.tokens.cache_read)],
          ['Cache Write', formatNum(stats.tokens.cache_creation)],
        ].map(([label, value]) => (
          <div key={label} style={{ background: 'var(--color-bg-stat)', borderRadius: '6px', padding: '8px 10px', border: '1px solid var(--color-border-primary)' }}>
            <div style={{ fontSize: '10px', color: 'var(--color-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '2px' }}>{label}</div>
            <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{value}</div>
          </div>
        ))}
      </div>
      {stats.cwd && (
        <div style={{ marginBottom: '8px', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-terminal)', fontSize: '11px' }}>
          📁 {stats.cwd} {stats.gitBranch ? `(${stats.gitBranch})` : ''}
        </div>
      )}
      {sortedTools.length > 0 && (
        <>
          <div style={{ fontWeight: 600, marginBottom: '6px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>Tool Calls</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {sortedTools.slice(0, 20).map(([name, count]) => (
              <span key={name} style={{
                background: 'var(--color-type-badge-bg)', color: 'var(--color-type-badge-text)',
                borderRadius: '12px', padding: '2px 8px', fontSize: '11px', fontWeight: 500,
              }}>
                {name} × {count}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ─── SubagentList ─────────────────────────────────────────────────────────────

function SubagentList({ sessionId, onSelect }: { sessionId: string; onSelect: (id: string) => void }) {
  const [subagents, setSubagents] = useState<RegistrySubagent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    apiGet<{ subagents: RegistrySubagent[] }>(`${BASE}/${encodeURIComponent(sessionId)}/subagents`)
      .then(d => setSubagents(d.subagents || []))
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  if (loading) return <div style={{ color: 'var(--color-text-muted)' }}>Loading subagents…</div>;
  if (error) return <div style={{ color: 'var(--color-accent-error)' }}>Error: {error}</div>;
  if (!subagents.length) return <div style={{ color: 'var(--color-text-muted)' }}>No subagents found.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {subagents.map(sa => (
        <div
          key={sa.id}
          style={{
            background: 'var(--color-bg-stat)', border: '1px solid var(--color-border-primary)',
            borderRadius: '8px', padding: '8px 12px', fontSize: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>{sa.agentType}</span>
            <span style={{
              fontSize: '10px', padding: '1px 6px', borderRadius: '10px',
              background: sa.status === 'active' ? 'rgba(22,198,12,0.15)' : 'var(--color-bg-tertiary)',
              color: sa.status === 'active' ? 'var(--color-accent-success)' : 'var(--color-text-muted)',
            }}>{sa.status}</span>
            {sa.ephemeral && <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>ephemeral</span>}
            {sa.mtime > 0 && <span style={{ marginLeft: 'auto', color: 'var(--color-text-muted)', fontSize: '11px' }}>{formatRelTime(sa.mtime)}</span>}
          </div>
          {sa.slug && <div style={{ color: 'var(--color-text-secondary)', marginBottom: '4px', fontStyle: 'italic' }}>{sa.slug}</div>}
          {sa.model && <div style={{ color: 'var(--color-text-muted)', fontSize: '11px' }}>Model: {sa.model}</div>}
          {sa.childSessionKey && (
            <div style={{ color: 'var(--color-text-muted)', fontSize: '11px', fontFamily: 'var(--font-terminal)' }}>{sa.childSessionKey}</div>
          )}
          {!sa.ephemeral && (
            <button
              onClick={() => onSelect(sa.id)}
              style={{
                marginTop: '6px', padding: '3px 10px', fontSize: '11px',
                background: 'var(--color-bg-button)', color: 'var(--color-text-button)',
                border: 'none', borderRadius: '4px', cursor: 'pointer',
              }}
            >
              View Events
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── SessionDetail ────────────────────────────────────────────────────────────

type DetailTab = 'events' | 'stats' | 'subagents';

function SessionDetail({ session, onBack, liveTick }: { session: RegistrySession; onBack: () => void; liveTick: number }) {
  const [tab, setTab] = useState<DetailTab>('events');
  const [subagentSessionId, setSubagentSessionId] = useState<string | null>(null);

  const handleSubagentSelect = (id: string) => setSubagentSessionId(id);

  const tabStyle = (t: DetailTab): React.CSSProperties => ({
    padding: '6px 14px', fontSize: '13px', cursor: 'pointer', border: 'none', borderRadius: '6px',
    background: tab === t ? 'var(--color-accent-primary)' : 'var(--color-bg-stat)',
    color: tab === t ? '#fff' : 'var(--color-text-secondary)',
    fontWeight: tab === t ? 600 : 400,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: '10px',
        padding: '12px 16px', borderBottom: '1px solid var(--color-border-primary)',
        background: 'var(--color-bg-header)', flexShrink: 0,
      }}>
        <button
          onClick={onBack}
          style={{
            padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
            border: '1px solid var(--color-border-primary)', borderRadius: '6px',
            background: 'var(--color-bg-card)', color: 'var(--color-text-secondary)',
          }}
        >← Back</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, color: 'var(--color-text-title)', fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {session.slug || session.sessionId.slice(0, 24) + '…'}
          </div>
          <div style={{ display: 'flex', gap: '8px', marginTop: '3px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{session.project}</span>
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>•</span>
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', fontFamily: 'var(--font-terminal)' }}>{session.source}</span>
            {session.model && <><span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>•</span><span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{session.model}</span></>}
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>•</span>
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{formatSize(session.size)}</span>
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>•</span>
            <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{formatRelTime(session.mtime)}</span>
          </div>
        </div>
        <span style={{
          padding: '3px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: 600,
          background: session.status === 'active' ? 'rgba(22,198,12,0.15)' : 'var(--color-bg-tertiary)',
          color: session.status === 'active' ? 'var(--color-accent-success)' : 'var(--color-text-muted)',
        }}>{session.status}</span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '6px', padding: '10px 16px', borderBottom: '1px solid var(--color-border-primary)', flexShrink: 0 }}>
        <button style={tabStyle('events')} onClick={() => { setTab('events'); setSubagentSessionId(null); }}>Events</button>
        <button style={tabStyle('stats')} onClick={() => setTab('stats')}>Stats</button>
        <button style={tabStyle('subagents')} onClick={() => setTab('subagents')}>
          Subagents {session.subagentCount > 0 ? `(${session.subagentCount})` : ''}
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
        {tab === 'events' && !subagentSessionId && (
          <SessionEventList sessionId={session.sessionId} liveTick={liveTick} />
        )}
        {tab === 'events' && subagentSessionId && (
          <div>
            <button
              onClick={() => setSubagentSessionId(null)}
              style={{
                marginBottom: '10px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
                border: '1px solid var(--color-border-primary)', borderRadius: '6px',
                background: 'var(--color-bg-card)', color: 'var(--color-text-secondary)',
              }}
            >← Back to parent events</button>
            <div style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginBottom: '10px' }}>
              Subagent: <code style={{ fontFamily: 'var(--font-terminal)' }}>{subagentSessionId}</code>
            </div>
            <SessionEventList sessionId={subagentSessionId} liveTick={liveTick} />
          </div>
        )}
        {tab === 'stats' && <SessionStatsPanel sessionId={session.sessionId} liveTick={liveTick} />}
        {tab === 'subagents' && (
          <SubagentList
            sessionId={session.sessionId}
            onSelect={(id) => { setTab('events'); handleSubagentSelect(id); }}
          />
        )}
      </div>
    </div>
  );
}


function SessionDetailPlaceholder() {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '32px',
      background: 'var(--color-bg-primary)',
    }}>
      <div style={{
        fontSize: '28px',
        fontWeight: 600,
        color: 'var(--color-text-muted)',
        textAlign: 'center',
        letterSpacing: '0.05em',
      }}>
        {'<-- Choose a session to start!'}
      </div>
    </div>
  );
}


// ─── SessionList ──────────────────────────────────────────────────────────────

function SessionList({ onSelect, liveTick }: { onSelect: (s: RegistrySession) => void; liveTick: number }) {
  const [sessions, setSessions] = useState<RegistrySession[]>([]);
  const [total, setTotal] = useState(0);
  const [projects, setProjects] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('');
  const [projectFilter, setProjectFilter] = useState('');

  const offsetRef = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSessions = useCallback(async (opts: { reset?: boolean; searchVal?: string; statusVal?: string; sourceVal?: string; projectVal?: string }) => {
    const { reset, searchVal, statusVal, sourceVal, projectVal } = opts;
    const s = searchVal ?? search;
    const st = statusVal ?? statusFilter;
    const src = sourceVal ?? sourceFilter;
    const proj = projectVal ?? projectFilter;

    if (reset) { offsetRef.current = 0; }

    const params = new URLSearchParams({ limit: '50', offset: String(offsetRef.current) });
    if (s) params.set('search', s);
    if (st && st !== 'all') params.set('status', st);
    if (src) params.set('source', src);
    if (proj) params.set('project', proj);

    try {
      const data = await apiGet<{ sessions: RegistrySession[]; total: number; projects: string[]; sources: string[] }>(`${BASE}/list?${params}`);
      if (reset) {
        setSessions(data.sessions);
      } else {
        setSessions(prev => [...prev, ...data.sessions]);
      }
      setTotal(data.total);
      setProjects(data.projects || []);
      setSources(data.sources || []);
      offsetRef.current += data.sessions.length;
    } catch (e) {
      setError((e as Error).message);
    }
  }, [search, statusFilter, sourceFilter, projectFilter]);

  const refresh = useCallback((overrides: { searchVal?: string; statusVal?: string; sourceVal?: string; projectVal?: string } = {}) => {
    setLoading(true);
    setError(null);
    fetchSessions({ reset: true, ...overrides }).finally(() => setLoading(false));
  }, [fetchSessions]);

  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!liveTick) return;
    fetchSessions({ reset: true }).catch(() => {
      // Keep UI stable on background refresh failures.
    });
  }, [liveTick, fetchSessions]);

  const handleSearch = (val: string) => {
    setSearch(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => refresh({ searchVal: val }), 400);
  };

  const handleStatusChange = (val: string) => { setStatusFilter(val); refresh({ statusVal: val }); };
  const handleSourceChange = (val: string) => { setSourceFilter(val); refresh({ sourceVal: val }); };
  const handleProjectChange = (val: string) => { setProjectFilter(val); refresh({ projectVal: val }); };

  const loadMore = async () => {
    setLoadingMore(true);
    await fetchSessions({});
    setLoadingMore(false);
  };

  const inputStyle: React.CSSProperties = {
    padding: '6px 10px', fontSize: '13px', background: 'var(--color-bg-input)',
    border: '1px solid var(--color-border-primary)', borderRadius: '6px',
    color: 'var(--color-text-primary)', outline: 'none',
  };

  const sourceColors: Record<string, string> = {
    claude: 'var(--color-accent-observation)',
    openclaw: 'var(--color-accent-prompt)',
    codex: 'var(--color-accent-summary)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Filters */}
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid var(--color-border-primary)',
        background: 'var(--color-bg-header)', display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', flexShrink: 0,
      }}>
        <input
          type="text"
          placeholder="Search sessions…"
          value={search}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleSearch(e.target.value)}
          style={{ ...inputStyle, flex: '1 1 200px', minWidth: '120px' }}
        />
        <select value={statusFilter} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleStatusChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
        </select>
        <select value={sourceFilter} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleSourceChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          <option value="">All Sources</option>
          {sources.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={projectFilter} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => handleProjectChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
          <option value="">All Projects</option>
          {projects.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <button
          onClick={() => refresh()}
          style={{
            padding: '6px 12px', fontSize: '12px', cursor: 'pointer',
            border: '1px solid var(--color-border-primary)', borderRadius: '6px',
            background: 'var(--color-bg-stat)', color: 'var(--color-text-secondary)',
          }}
        >↺ Refresh</button>
        {total > 0 && <span style={{ fontSize: '12px', color: 'var(--color-text-muted)', marginLeft: 'auto' }}>{total} session{total !== 1 ? 's' : ''}</span>}
      </div>

      {/* Session items */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
        {loading && <div style={{ color: 'var(--color-text-muted)', padding: '20px 12px' }}>Loading sessions…</div>}
        {error && <div style={{ color: 'var(--color-accent-error)', padding: '12px' }}>Error: {error}</div>}
        {!loading && !error && sessions.length === 0 && (
          <div style={{ color: 'var(--color-text-muted)', padding: '20px 12px' }}>No sessions found.</div>
        )}
        {sessions.map(s => (
          <div
            key={s.sessionId}
            onClick={() => onSelect(s)}
            style={{
              background: 'var(--color-bg-card)', border: '1px solid var(--color-border-primary)',
              borderRadius: '8px', padding: '10px 14px', marginBottom: '6px',
              cursor: 'pointer', transition: 'border-color 0.15s',
            }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--color-border-hover)')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--color-border-primary)')}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontWeight: 600, fontSize: '13px', color: 'var(--color-text-title)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {s.slug || <span style={{ color: 'var(--color-text-muted)' }}>(no description)</span>}
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '3px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '11px', color: sourceColors[s.source] || 'var(--color-text-muted)', fontWeight: 600 }}>{s.source}</span>
                  <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{s.project}</span>
                  {s.model && <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{s.model}</span>}
                  {s.gitBranch && <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>🌿 {s.gitBranch}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px', flexShrink: 0 }}>
                <span style={{
                  fontSize: '10px', padding: '2px 7px', borderRadius: '10px', fontWeight: 600,
                  background: s.status === 'active' ? 'rgba(22,198,12,0.15)' : 'var(--color-bg-tertiary)',
                  color: s.status === 'active' ? 'var(--color-accent-success)' : 'var(--color-text-muted)',
                }}>{s.status}</span>
                <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>{formatRelTime(s.mtime)}</span>
                {s.duration > 0 && <span style={{ fontSize: '10px', color: 'var(--color-text-muted)' }}>{formatDurationCompact(s.duration)}</span>}
                {s.contextPct > 0 && <span style={{ fontSize: '10px', color: 'var(--color-accent-summary)', fontWeight: 600 }}>{s.contextPct}% ctx</span>}
                {s.subagentCount > 0 && <span style={{ fontSize: '10px', color: 'var(--color-accent-prompt)' }}>🤖 {s.subagentCount}</span>}
              </div>
            </div>
          </div>
        ))}
        {!loading && sessions.length < total && (
          <button
            onClick={loadMore}
            disabled={loadingMore}
            style={{
              display: 'block', width: '100%', padding: '8px', fontSize: '13px',
              background: 'var(--color-bg-stat)', border: '1px solid var(--color-border-primary)',
              borderRadius: '8px', cursor: 'pointer', color: 'var(--color-text-secondary)',
            }}
          >
            {loadingMore ? 'Loading…' : `Load more (${total - sessions.length} remaining)`}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── SessionRegistryPage (main export) ───────────────────────────────────────

export function SessionRegistryPage({ onNavigateHome }: { onNavigateHome: () => void }) {
  const [selected, setSelected] = useState<RegistrySession | null>(null);
  const liveTick = useSessionRegistryLiveTick();
  const [isNarrowLayout, setIsNarrowLayout] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth < 980 : false
  ));

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const handleResize = () => {
      setIsNarrowLayout(window.innerWidth < 980);
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Page header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '12px',
        padding: '10px 16px', background: 'var(--color-bg-header)',
        borderBottom: '2px solid var(--color-border-primary)', flexShrink: 0,
      }}>
        <button
          onClick={onNavigateHome}
          style={{
            padding: '5px 12px', fontSize: '13px', cursor: 'pointer',
            border: '1px solid var(--color-border-primary)', borderRadius: '6px',
            background: 'var(--color-bg-card)', color: 'var(--color-text-secondary)',
            fontWeight: 500,
          }}
        >← Feed</button>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: 'var(--color-text-title)' }}>
          Session Registry
        </h2>
        <span style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>
          Browse raw Claude Code, OpenClaw & Codex sessions
        </span>
      </div>

      {/* Body: split or full */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', flexDirection: isNarrowLayout ? 'column' : 'row' }}>
        {/* Session list pane */}
        <div style={{
          width: isNarrowLayout ? '100%' : '360px',
          minWidth: isNarrowLayout ? undefined : '280px',
          height: isNarrowLayout ? '42%' : undefined,
          minHeight: isNarrowLayout ? '240px' : undefined,
          flexShrink: 0,
          borderRight: isNarrowLayout ? 'none' : '1px solid var(--color-border-primary)',
          borderBottom: isNarrowLayout ? '1px solid var(--color-border-primary)' : 'none',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <SessionList onSelect={setSelected} liveTick={liveTick} />
        </div>

        {/* Detail pane */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {selected ? (
            <SessionDetail session={selected} onBack={() => setSelected(null)} liveTick={liveTick} />
          ) : (
            <SessionDetailPlaceholder />
          )}
        </div>
      </div>
    </div>
  );
}
