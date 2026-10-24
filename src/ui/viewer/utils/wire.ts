// The Wire page's data (plan Phase 15), as the worker's /api/wire/* routes
// answer it. The shapes mirror the gateway's own (drift/agent-status.ts,
// trace/live-trace-feed.ts, metrics/usage-summary.ts); the viewer bundle
// cannot import server modules, so the fields it reads are restated here.

export type WireAgentState = 'ok' | 'unwired' | 'replaced' | 'unreachable' | 'proxied' | 'bypassed' | 'unknown';

export interface WireAgentStatus {
  agentId: string;
  name: string;
  state: WireAgentState;
  detail: string;
  fix: string | null;
  captureSource: 'wire' | 'native' | null;
  routeIds: string[];
  connectedAt: string | null;
  lastSeenAt: string | null;
  lastUsedAt: string | null;
  notes: string[];
}

export interface WireStatusReport {
  generatedAt: string;
  gateway: { origin: string; running: boolean; version?: string; startedAt?: string };
  capture: { unattributedEventCount: number } | null;
  problems: string[];
  agents: WireAgentStatus[];
}

export interface WireFeatureState {
  on: boolean;
  decidedBy: 'route' | 'setting';
}

export interface WireRouteReport {
  routeId: string;
  agentId: string;
  captureSource: 'wire' | 'native';
  upstream: string;
  createdAt: string;
  memoryInjection: WireFeatureState;
  memorySearchTool: WireFeatureState;
  endlessMode: WireFeatureState;
}

export interface WireTraceCall {
  id: string;
  seq: number;
  time: string;
  agentId: string;
  routeId: string;
  protocol: string | null;
  method: string;
  path: string;
  kind: string;
  sessionId: string;
  model?: string;
  done: boolean;
  status?: number;
  outcome?: string;
  durationMs?: number;
  responseBytes?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  hasBodies: boolean;
}

export interface WireTraceSnapshot {
  /** The gateway's feed, new each time it starts. */
  feedId: string;
  seq: number;
  calls: WireTraceCall[];
  now: string;
}

export interface WireCallBodies {
  requestBody: string;
  responseBody: string;
  requestTruncated: boolean;
  responseTruncated: boolean;
}

export interface WireConsent {
  recording: boolean;
  forcedOff: boolean;
  effective: boolean;
  decidedAt: string | null;
  retentionDays: number;
  recordingsDirectory: string;
}

export interface WireCacheTotals {
  requests: number;
  cacheRead: number;
  cacheWrite: number;
  readWriteRatio: number | null;
}

export type WireContextPartKind = 'system' | 'tools' | 'memory' | 'files' | 'results' | 'chat';

export interface WireUsageSummary {
  usageDays: number;
  requests: number;
  /** Ledger lines that are not records: not counted. */
  unreadableLines: number;
  endless: Array<{
    agentId: string;
    conversationsSwapped: number;
    requestsSwapped: number;
    beforeFirstSwap: WireCacheTotals;
    afterFirstSwap: WireCacheTotals;
    tokensSaved: number;
  }>;
  injectedMemory: Array<{ agentId: string; requestsInjected: number; injectedTokensEst: number; averageTokensPerRequest: number }>;
  context: Array<{ agent: string; requests: number; shares: Record<WireContextPartKind, number>; tags: string[] }>;
}

/** The parts of a prompt in the order the gateway reports them (metrics/context-buckets.ts WIRE_CONTEXT_PART_KINDS). */
export const WIRE_CONTEXT_PART_KINDS: readonly WireContextPartKind[] = ['system', 'tools', 'memory', 'files', 'results', 'chat'];

export const WIRE_CONTEXT_PART_LABELS: Record<WireContextPartKind, string> = {
  system: 'System prompt',
  tools: 'Tool definitions',
  memory: 'Memory and instructions',
  files: 'Files read',
  results: 'Other tool output',
  chat: 'Conversation',
};

/** Badge words and the tone each state is drawn in; the fix itself comes from the gateway. */
export const WIRE_AGENT_STATE_BADGES: Record<WireAgentState, { label: string; tone: 'ok' | 'warn' | 'error' | 'muted'; meaning: string }> = {
  ok: { label: 'ok', tone: 'ok', meaning: 'Wired, answering, and nothing says otherwise.' },
  unwired: { label: 'unwired', tone: 'error', meaning: 'A base URL the agent uses now does not point at the gateway.' },
  replaced: { label: 'replaced', tone: 'warn', meaning: 'A value connect wrote was changed to something else.' },
  unreachable: { label: 'unreachable', tone: 'error', meaning: 'The address the agent is given does not answer as the gateway.' },
  proxied: { label: 'proxied', tone: 'warn', meaning: "The agent's proxy settings send gateway requests through a proxy that does not pass them on." },
  bypassed: { label: 'bypassed', tone: 'warn', meaning: 'The agent was used since connect, yet none of its requests reached the gateway.' },
  unknown: { label: 'unknown', tone: 'muted', meaning: 'Something needed cannot be read, or a probe has no answer yet.' },
};

/**
 * Calls the page keeps: the gateway's feed keeps 60 (trace/live-trace-feed.ts
 * LIVE_TRACE_KEPT_CALLS), so more could only be calls the gateway forgot.
 */
export const WIRE_TRACE_KEPT_CALLS = 60;

/**
 * Fold a trace answer into the calls shown, newest first. A changed call
 * replaces its earlier copy. An answer from another feed than the last one
 * means the gateway restarted: the calls shown are the old gateway's (some
 * "in flight" forever), so the list starts over from the new feed's answer,
 * which holds all of its calls (a cursor from another feed is read as 0).
 */
export function mergeTraceCalls(current: WireTraceCall[], previousFeedId: string | null, snapshot: WireTraceSnapshot): WireTraceCall[] {
  const base = snapshot.feedId === previousFeedId ? current : [];
  const byId = new Map(base.map(call => [call.id, call]));
  for (const call of snapshot.calls) byId.set(call.id, call);
  return [...byId.values()]
    .sort((first, second) => second.time.localeCompare(first.time) || second.seq - first.seq)
    .slice(0, WIRE_TRACE_KEPT_CALLS);
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** "12.3:1" read:write, or why there is no ratio. */
export function formatCacheRatio(totals: WireCacheTotals): string {
  if (totals.requests === 0) return 'no requests';
  if (totals.readWriteRatio === null) return 'no cache writes';
  return `${totals.readWriteRatio.toFixed(1)}:1`;
}

/** The text of a worker answer that is not ok: its `{error}` (a string, or the gateway's {type, message}), else the status. */
export async function describeWireFailure(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
    if (body.error && typeof body.error === 'object' && typeof (body.error as { message?: unknown }).message === 'string') {
      return (body.error as { message: string }).message;
    }
  } catch {
    // Not JSON: the status below says what happened.
  }
  return `the worker answered HTTP ${response.status}`;
}
