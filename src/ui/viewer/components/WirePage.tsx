import React, { useState } from 'react';
import { ToggleSwitch, saveStatusClass } from './ContextSettingsModal';
import { useWireGateway, type WireLoad } from '../hooks/useWireGateway';
import {
  WIRE_AGENT_STATE_BADGES,
  WIRE_CONTEXT_PART_KINDS,
  WIRE_CONTEXT_PART_LABELS,
  formatCacheRatio,
  formatPercent,
  formatTokenCount,
  type WireAgentStatus,
  type WireCallBodies,
  type WireConsent,
  type WireRouteReport,
  type WireStatusReport,
  type WireTraceCall,
  type WireUsageSummary,
} from '../utils/wire';

function Section({ title, hint, children, label }: { title: string; hint?: React.ReactNode; children: React.ReactNode; label: string }) {
  return (
    <section className="wire-section" aria-label={label}>
      <h3 className="wire-section-title">{title}</h3>
      {hint && <p className="wire-section-hint">{hint}</p>}
      {children}
    </section>
  );
}

function LoadProblem({ load, what }: { load: WireLoad<unknown>; what: string }) {
  if (load.error) return <div className="card-delete-error wire-problem" role="alert">Could not load {what}: {load.error}</div>;
  return null;
}

export function GatewayBanner({ status }: { status: WireLoad<WireStatusReport> }) {
  if (status.gatewayDown) {
    return (
      <div className="wire-card wire-banner wire-banner--down" role="status">
        <strong>The wire gateway is not running.</strong> Agents, routes and live calls need it. Start it with <code>claude-mem wire start</code>.
        Consent and the usage below are read from disk and still apply.
      </div>
    );
  }
  const report = status.data;
  if (!report) return <LoadProblem load={status} what="the gateway's status" />;
  return (
    <div className="wire-card wire-banner" role="status">
      <span className="wire-badge wire-badge--ok">running</span>{' '}
      at <code>{report.gateway.origin}</code>
      {report.gateway.version && <> · version {report.gateway.version}</>}
      {report.gateway.startedAt && <> · started {new Date(report.gateway.startedAt).toLocaleString()}</>}
      {report.capture && (
        <div className="wire-muted" data-testid="wire-unattributed">
          Captured events with no known folder: {report.capture.unattributedEventCount}
        </div>
      )}
      {report.problems.map(problem => <div key={problem} className="card-delete-error wire-problem">Problem: {problem}</div>)}
    </div>
  );
}

function FeatureChip({ name, state }: { name: string; state: WireRouteReport['endlessMode'] }) {
  return (
    <span className={`wire-chip${state.on ? ' wire-chip--on' : ''}`} title={state.decidedBy === 'route' ? 'set on this route' : 'follows the setting'}>
      {name} {state.on ? 'on' : 'off'}{state.decidedBy === 'route' ? ' (route)' : ''}
    </span>
  );
}

export function AgentCard({ agent, routes }: { agent: WireAgentStatus; routes: WireRouteReport[] }) {
  const badge = WIRE_AGENT_STATE_BADGES[agent.state] ?? WIRE_AGENT_STATE_BADGES.unknown;
  return (
    <div className="wire-card" data-agent={agent.agentId}>
      <div className="wire-card-header">
        <div className="session-card-title-group">
          <span className="session-card-name">{agent.name}</span>
          <span className="session-card-id">{agent.agentId}{agent.captureSource ? ` · capture: ${agent.captureSource}` : ''}</span>
        </div>
        <span className={`wire-badge wire-badge--${badge.tone}`} title={badge.meaning} data-state={agent.state}>{badge.label}</span>
      </div>
      <p className="wire-detail">{agent.detail}</p>
      {agent.fix && <p className="wire-fix">Fix: <code>{agent.fix}</code></p>}
      {agent.notes.map(note => <p key={note} className="wire-muted">Note: {note}</p>)}
      <div className="wire-muted">
        {agent.lastSeenAt ? `Last request through the gateway ${new Date(agent.lastSeenAt).toLocaleString()}` : 'No request through the gateway yet'}
        {agent.connectedAt && ` · connected ${new Date(agent.connectedAt).toLocaleString()}`}
      </div>
      {routes.map(route => (
        <div key={route.routeId} className="wire-route">
          <code>/r/{route.routeId}</code> → <code>{route.upstream}</code>
          <div className="wire-chips">
            <FeatureChip name="memory" state={route.memoryInjection} />
            <FeatureChip name="memory_search" state={route.memorySearchTool} />
            <FeatureChip name="Endless Mode" state={route.endlessMode} />
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentsSection({ status, routes }: { status: WireLoad<WireStatusReport>; routes: WireLoad<{ routes: WireRouteReport[] }> }) {
  const agents = status.data?.agents ?? [];
  const routeList = routes.data?.routes ?? [];
  return (
    <Section title="Agents" label="Agents" hint="Whether each wired agent's model calls really reach the gateway, with the fix when they do not.">
      <LoadProblem load={routes} what="the routes" />
      {agents.map(agent => (
        <AgentCard key={agent.agentId} agent={agent} routes={routeList.filter(route => route.agentId === agent.agentId)} />
      ))}
      {status.data && agents.length === 0 && (
        <div className="session-list-empty"><h3>No agents are wired</h3><p>Wire one with <code>claude-mem wire connect &lt;agent&gt;</code>.</p></div>
      )}
    </Section>
  );
}

export function ConsentCard({ consent, busy, message, onSetRecording, onClear }: {
  consent: WireLoad<WireConsent>;
  busy: boolean;
  message: string | null;
  onSetRecording: (recording: boolean) => void;
  onClear: () => void;
}) {
  const decision = consent.data;
  return (
    <Section title="Raw recording" label="Raw recording consent">
      <div className="wire-card wire-consent">
        <LoadProblem load={consent} what="the recording decision" />
        {decision && (
          <>
            <ToggleSwitch
              id="wire-recording-consent"
              label="Record the text of model calls"
              description={decision.forcedOff
                ? 'Off: CLAUDE_MEM_WIRE_GATEWAY_RECORDING=false forces it off whatever is chosen here.'
                : decision.recording ? 'On. Turn it off at any time; what was kept stays until it ages out or you delete it.' : 'Off. Nothing is recorded until you turn this on.'}
              checked={decision.effective}
              disabled={busy || decision.forcedOff}
              onChange={onSetRecording}
            />
            <dl className="wire-consent-facts">
              <dt>What</dt>
              <dd>The request and reply text of model calls from agents the gateway captures (routes with capture: wire), with secrets scrubbed first. Headers are never kept. The live feed below can then show the last 40 calls' text.</dd>
              <dt>Where</dt>
              <dd>On this computer only, in <code>{decision.recordingsDirectory}</code>, and in the running gateway's memory for the live feed. Cloud sync never reads them.</dd>
              <dt>How long</dt>
              <dd>{decision.retentionDays} day{decision.retentionDays === 1 ? '' : 's'} (CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS), then deleted. Turning recording off or deleting clears the live feed's text at once.</dd>
            </dl>
            <div className="wire-consent-actions">
              <button type="button" className="wire-button" onClick={onClear} disabled={busy}>Delete every recording</button>
              <span className="wire-muted">{decision.decidedAt ? `Decided ${new Date(decision.decidedAt).toLocaleString()}` : 'Never decided: off'}</span>
              {message && <span className={`save-status ${saveStatusClass(message)}`} role="status">{message}</span>}
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

function callTokens(call: WireTraceCall): string {
  if (call.inputTokens === undefined && call.outputTokens === undefined) return '';
  const parts = [`${formatTokenCount(call.inputTokens ?? 0)} in`, `${formatTokenCount(call.outputTokens ?? 0)} out`];
  if (call.cacheReadTokens) parts.push(`${formatTokenCount(call.cacheReadTokens)} cache read`);
  if (call.cacheWriteTokens) parts.push(`${formatTokenCount(call.cacheWriteTokens)} cache write`);
  return parts.join(' · ');
}

export function LiveCalls({ calls, trace, recordingOn, loadCallBodies }: {
  calls: WireTraceCall[];
  trace: { gatewayDown: boolean; error: string | null; connected: boolean };
  recordingOn: boolean;
  loadCallBodies: (id: string) => Promise<WireCallBodies>;
}) {
  const [openCall, setOpenCall] = useState<{ id: string; bodies: WireCallBodies | null; error: string | null } | null>(null);

  async function toggleBodies(id: string): Promise<void> {
    if (openCall?.id === id) {
      setOpenCall(null);
      return;
    }
    setOpenCall({ id, bodies: null, error: null });
    try {
      const bodies = await loadCallBodies(id);
      setOpenCall(current => (current?.id === id ? { id, bodies, error: null } : current));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOpenCall(current => (current?.id === id ? { id, bodies: null, error: message } : current));
    }
  }

  return (
    <Section
      title="Live calls"
      label="Live calls"
      hint={<>The last calls the gateway relayed, as they start and end: agent, model, status, timing and tokens. {recordingOn ? 'A call’s text can be opened while raw recording is on.' : 'Turn raw recording on to open a call’s text.'}</>}
    >
      <div className="wire-muted" data-testid="wire-trace-state">
        {trace.connected ? 'Live' : trace.gatewayDown ? 'Waiting for the wire gateway…' : trace.error ? `Feed interrupted: ${trace.error}; retrying` : 'Connecting…'}
      </div>
      {calls.length === 0 && <div className="session-list-empty">No calls yet.</div>}
      <ul className="wire-calls">
        {calls.map(call => (
          <li key={call.id} className="wire-card wire-call" data-call-id={call.id}>
            <div className="wire-card-header">
              <span>
                <strong>{call.agentId}</strong>
                {call.model && <span className="wire-muted"> · {call.model}</span>}
                <span className="wire-muted"> · {call.kind}</span>
              </span>
              <span className={`wire-badge wire-badge--${!call.done ? 'muted' : (call.status ?? 0) >= 400 ? 'error' : 'ok'}`}>
                {call.done ? String(call.status ?? '—') : 'in flight'}
              </span>
            </div>
            <div className="wire-muted">
              {new Date(call.time).toLocaleTimeString()} · {call.method} {call.path}
              {call.durationMs !== undefined && ` · ${(call.durationMs / 1000).toFixed(1)}s`}
              {callTokens(call) && ` · ${callTokens(call)}`}
            </div>
            {recordingOn && call.hasBodies && (
              <button type="button" className="wire-button wire-button--small" onClick={() => void toggleBodies(call.id)} aria-expanded={openCall?.id === call.id}>
                {openCall?.id === call.id ? 'Hide text' : 'Show text'}
              </button>
            )}
            {recordingOn && openCall?.id === call.id && (
              <div className="wire-bodies">
                {openCall.error && <div className="card-delete-error">{openCall.error}</div>}
                {!openCall.error && !openCall.bodies && <div className="wire-muted">Loading…</div>}
                {openCall.bodies && (
                  <>
                    <div className="wire-muted">Request{openCall.bodies.requestTruncated ? ' (cut at 256 KiB)' : ''}</div>
                    <pre className="wire-body">{openCall.bodies.requestBody}</pre>
                    <div className="wire-muted">Reply{openCall.bodies.responseTruncated ? ' (cut at 256 KiB)' : ''}</div>
                    <pre className="wire-body">{openCall.bodies.responseBody}</pre>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function SavingsSection({ usage }: { usage: WireLoad<WireUsageSummary> }) {
  const summary = usage.data;
  return (
    <Section
      title="Endless Mode savings"
      label="Endless Mode savings"
      hint={<>Each conversation's prompt cache before its first swap and from it on, and the tokens the swaps took out{summary ? `, over the usage ledger's last ${summary.usageDays} days` : ''}. A swap writes the cache once more; after that it should be read as before, from a smaller prompt.</>}
    >
      <LoadProblem load={usage} what="the usage ledger" />
      {summary && summary.unreadableLines > 0 && (
        <div className="card-delete-error wire-problem" role="alert" data-testid="wire-unreadable-lines">
          {summary.unreadableLines} usage ledger line{summary.unreadableLines === 1 ? ' is' : 's are'} not a usage record and {summary.unreadableLines === 1 ? 'is' : 'are'} not counted in the numbers below.
        </div>
      )}
      {summary && summary.endless.length === 0 && (
        <div className="wire-muted">No swaps yet. Endless Mode is off by default: <code>claude-mem wire routes endless &lt;routeId&gt; on</code>.</div>
      )}
      {summary && summary.endless.length > 0 && (
        <table className="wire-table">
          <thead><tr><th>Agent</th><th>Conversations</th><th>Requests with swaps</th><th>Tokens saved</th><th>Cache read:write before</th><th>From the first swap</th></tr></thead>
          <tbody>
            {summary.endless.map(agent => (
              <tr key={agent.agentId}>
                <td>{agent.agentId}</td>
                <td>{agent.conversationsSwapped}</td>
                <td>{agent.requestsSwapped}</td>
                <td>~{formatTokenCount(agent.tokensSaved)}</td>
                <td title={`${agent.beforeFirstSwap.cacheRead} read, ${agent.beforeFirstSwap.cacheWrite} written, ${agent.beforeFirstSwap.requests} requests`}>{formatCacheRatio(agent.beforeFirstSwap)}</td>
                <td title={`${agent.afterFirstSwap.cacheRead} read, ${agent.afterFirstSwap.cacheWrite} written, ${agent.afterFirstSwap.requests} requests`}>{formatCacheRatio(agent.afterFirstSwap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

export function InjectedMemorySection({ usage }: { usage: WireLoad<WireUsageSummary> }) {
  const summary = usage.data;
  return (
    <Section title="Injected memory" label="Injected memory" hint="What memory injection adds to the prompts it goes into: estimated tokens per request × the requests that carried it.">
      {summary && summary.injectedMemory.length === 0 && <div className="wire-muted">No memory injected yet.</div>}
      {summary && summary.injectedMemory.length > 0 && (
        <table className="wire-table">
          <thead><tr><th>Agent</th><th>Per request</th><th>Requests</th><th>Total</th></tr></thead>
          <tbody>
            {summary.injectedMemory.map(agent => (
              <tr key={agent.agentId}>
                <td>{agent.agentId}</td>
                <td>~{formatTokenCount(agent.averageTokensPerRequest)}</td>
                <td>× {agent.requestsInjected}</td>
                <td>~{formatTokenCount(agent.injectedTokensEst)} tokens</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

export function ContextBucketsSection({ usage }: { usage: WireLoad<WireUsageSummary> }) {
  const summary = usage.data;
  return (
    <Section title="Context per agent" label="Context per agent" hint="What each agent's prompts are made of, as shares of their estimated tokens. An agent whose prompts are a tenth memory or more is tagged memory-heavy.">
      {summary && summary.context.length === 0 && <div className="wire-muted">No prompts read yet.</div>}
      {summary?.context.map(agent => (
        <div key={agent.agent} className="wire-card wire-buckets" data-agent={agent.agent}>
          <div className="wire-card-header">
            <strong>{agent.agent}</strong>
            <span>
              {agent.tags.map(tag => <span key={tag} className="wire-badge wire-badge--warn">{tag}</span>)}
              <span className="wire-muted"> {agent.requests} request{agent.requests === 1 ? '' : 's'}</span>
            </span>
          </div>
          <div className="wire-bar" role="img" aria-label={WIRE_CONTEXT_PART_KINDS.map(kind => `${WIRE_CONTEXT_PART_LABELS[kind]} ${formatPercent(agent.shares[kind] ?? 0)}`).join(', ')}>
            {WIRE_CONTEXT_PART_KINDS.map(kind => (agent.shares[kind] ?? 0) > 0 && (
              <span key={kind} className={`wire-bar-part wire-bar-part--${kind}`} style={{ width: `${(agent.shares[kind] ?? 0) * 100}%` }} />
            ))}
          </div>
          <ul className="wire-legend">
            {WIRE_CONTEXT_PART_KINDS.map(kind => (
              <li key={kind}><span className={`wire-swatch wire-bar-part--${kind}`} />{WIRE_CONTEXT_PART_LABELS[kind]} {formatPercent(agent.shares[kind] ?? 0)}</li>
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}

type WireGatewayView = ReturnType<typeof useWireGateway>;

export function WirePageView({ header, wire }: { header: React.ReactNode; wire: WireGatewayView }) {
  return (
    <main className="session-list wire-page" aria-label="Wire gateway">
      <div className="session-list-content">
        {header}
        <GatewayBanner status={wire.status} />
        <AgentsSection status={wire.status} routes={wire.routes} />
        <ConsentCard
          consent={wire.consent}
          busy={wire.consentBusy}
          message={wire.consentMessage}
          onSetRecording={recording => void wire.setRecording(recording)}
          onClear={() => void wire.clearRecordings()}
        />
        <LiveCalls calls={wire.calls} trace={wire.trace} recordingOn={wire.consent.data?.effective === true} loadCallBodies={wire.loadCallBodies} />
        <SavingsSection usage={wire.usage} />
        <InjectedMemorySection usage={wire.usage} />
        <ContextBucketsSection usage={wire.usage} />
      </div>
    </main>
  );
}

/** The Wire page: the wire gateway's agents, consent, live calls and what it saves and costs. */
export function WirePage({ header }: { header: React.ReactNode }) {
  const wire = useWireGateway();
  return <WirePageView header={header} wire={wire} />;
}
