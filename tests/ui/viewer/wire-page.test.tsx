import { describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AgentCard,
  ConsentCard,
  ContextBucketsSection,
  GatewayBanner,
  InjectedMemorySection,
  LiveCalls,
  SavingsSection,
  WirePageView,
} from '../../../src/ui/viewer/components/WirePage.js';
import { ViewTabs } from '../../../src/ui/viewer/components/ViewTabs.js';
import type { WireAgentStatus, WireConsent, WireTraceCall, WireUsageSummary } from '../../../src/ui/viewer/utils/wire.js';

const loaded = <T,>(data: T) => ({ data, gatewayDown: false, error: null });
const noop = () => {};

function agent(overrides: Partial<WireAgentStatus>): WireAgentStatus {
  return {
    agentId: 'codex', name: 'Codex CLI', state: 'ok', detail: 'requests reach the gateway', fix: null, captureSource: 'wire',
    routeIds: ['codex'], connectedAt: null, lastSeenAt: null, lastUsedAt: null, notes: [], ...overrides,
  };
}

const consentOff: WireConsent = { recording: false, forcedOff: false, effective: false, decidedAt: null, retentionDays: 7, recordingsDirectory: '/data/wire-gateway/recordings' };

describe('Wire page tab', () => {
  it('offers a Wire tab beside Timeline and Sessions', () => {
    const html = renderToStaticMarkup(<ViewTabs active="wire" onSelect={noop} />);
    expect(html).toContain('>Wire</button>');
    expect(html).toMatch(/class="view-tab active" aria-pressed="true">Wire/);
  });
});

describe('Agents', () => {
  it('shows the state badge and the fix the gateway gave', () => {
    const html = renderToStaticMarkup(<AgentCard agent={agent({ state: 'bypassed', detail: 'used since connect, no request reached the gateway', fix: 'restart Codex' })} routes={[{
      routeId: 'codex', agentId: 'codex', captureSource: 'wire', upstream: 'https://api.openai.com/v1', createdAt: '',
      memoryInjection: { on: true, decidedBy: 'setting' }, memorySearchTool: { on: false, decidedBy: 'setting' }, endlessMode: { on: true, decidedBy: 'route' },
    }]} />);
    expect(html).toContain('data-state="bypassed"');
    expect(html).toContain('wire-badge--warn');
    expect(html).toContain('Fix: <code>restart Codex</code>');
    expect(html).toContain('Endless Mode on (route)');
    expect(html).toContain('https://api.openai.com/v1');
  });

  it('says the gateway is down, and shows the unattributed event count when it is up', () => {
    expect(renderToStaticMarkup(<GatewayBanner status={{ data: null, gatewayDown: true, error: null }} />)).toContain('claude-mem wire start');
    const up = renderToStaticMarkup(<GatewayBanner status={loaded({
      generatedAt: '', gateway: { origin: 'http://127.0.0.1:37601', running: true, version: '15.0.2' }, capture: { unattributedEventCount: 3 }, problems: [], agents: [],
    })} />);
    expect(up).toContain('Captured events with no known folder: 3');
  });
});

describe('Consent card', () => {
  it('is off by default and states what, where and how long, with a delete button', () => {
    const html = renderToStaticMarkup(<ConsentCard consent={loaded(consentOff)} busy={false} message={null} onSetRecording={noop} onClear={noop} />);
    expect(html).toContain('role="switch" aria-checked="false"');
    expect(html).toContain('<dt>What</dt>');
    expect(html).toContain('<dt>Where</dt>');
    expect(html).toContain('/data/wire-gateway/recordings');
    expect(html).toContain('<dt>How long</dt>');
    expect(html).toContain('7 days');
    expect(html).toContain('Delete every recording');
  });

  it('cannot be switched on while the setting forces recording off', () => {
    const html = renderToStaticMarkup(<ConsentCard consent={loaded({ ...consentOff, recording: true, forcedOff: true })} busy={false} message={null} onSetRecording={noop} onClear={noop} />);
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('toggle-switch  disabled');
    expect(html).toContain('CLAUDE_MEM_WIRE_GATEWAY_RECORDING=false');
  });
});

describe('Live calls', () => {
  const finished: WireTraceCall = {
    id: 'call-1', seq: 2, time: '2026-10-24T10:00:00.000Z', agentId: 'codex', routeId: 'codex', protocol: 'openai-responses',
    method: 'POST', path: '/v1/responses', kind: 'turn', sessionId: 's', model: 'gpt-5', done: true, status: 200, durationMs: 1500,
    inputTokens: 1200, outputTokens: 30, hasBodies: true,
  };

  it('offers a call’s text only while recording is on', () => {
    const trace = { gatewayDown: false, error: null, connected: true };
    const off = renderToStaticMarkup(<LiveCalls calls={[finished]} trace={trace} recordingOn={false} loadCallBodies={async () => { throw new Error('unused'); }} />);
    expect(off).toContain('gpt-5');
    expect(off).toContain('1.2k in');
    expect(off).not.toContain('Show text');
    const on = renderToStaticMarkup(<LiveCalls calls={[finished]} trace={trace} recordingOn loadCallBodies={async () => { throw new Error('unused'); }} />);
    expect(on).toContain('Show text');
  });

  function pageWith(consent: WireConsent): string {
    const wire = {
      status: { data: null, gatewayDown: true, error: null },
      routes: { data: null, gatewayDown: true, error: null },
      usage: { data: null, gatewayDown: false, error: null },
      consent: loaded(consent),
      consentBusy: false,
      consentMessage: null,
      calls: [finished],
      trace: { gatewayDown: false, error: null, connected: true },
      setRecording: async () => {},
      clearRecordings: async () => {},
      loadCallBodies: async () => { throw new Error('unused'); },
    };
    return renderToStaticMarkup(<WirePageView header={null} wire={wire} />);
  }

  it('hides call text when CLAUDE_MEM_WIRE_GATEWAY_RECORDING=false forces recording off, even with the decision on', () => {
    expect(pageWith({ ...consentOff, recording: true, forcedOff: false, effective: true })).toContain('Show text');
    expect(pageWith({ ...consentOff, recording: true, forcedOff: true, effective: false })).not.toContain('Show text');
  });
});

describe('Savings, injected memory and context buckets', () => {
  const usage: WireUsageSummary = {
    usageDays: 7,
    requests: 3,
    unreadableLines: 0,
    endless: [{
      agentId: 'codex', conversationsSwapped: 1, requestsSwapped: 2, tokensSaved: 12_000,
      beforeFirstSwap: { requests: 1, cacheRead: 0, cacheWrite: 1000, readWriteRatio: 0 },
      afterFirstSwap: { requests: 2, cacheRead: 1800, cacheWrite: 200, readWriteRatio: 9 },
    }],
    injectedMemory: [{ agentId: 'codex', requestsInjected: 3, injectedTokensEst: 900, averageTokensPerRequest: 300 }],
    context: [{ agent: 'codex', requests: 3, shares: { system: 0.1, tools: 0.1, memory: 0.3, files: 0, results: 0, chat: 0.5 }, tags: ['memory-heavy'] }],
  };

  it('shows cache read:write before and after the first swap, and the tokens saved', () => {
    const html = renderToStaticMarkup(<SavingsSection usage={loaded(usage)} />);
    expect(html).toContain('0.0:1');
    expect(html).toContain('9.0:1');
    expect(html).toContain('~12k');
  });

  it('says how many ledger lines were not counted, and nothing when all were', () => {
    expect(renderToStaticMarkup(<SavingsSection usage={loaded(usage)} />)).not.toContain('wire-unreadable-lines');
    const html = renderToStaticMarkup(<SavingsSection usage={loaded({ ...usage, unreadableLines: 2 })} />);
    expect(html).toContain('data-testid="wire-unreadable-lines"');
    expect(html).toContain('2 usage ledger lines are not a usage record');
  });

  it('shows injected memory as tokens per request × requests', () => {
    const html = renderToStaticMarkup(<InjectedMemorySection usage={loaded(usage)} />);
    expect(html).toContain('~300');
    expect(html).toContain('× 3');
    expect(html).toContain('~900 tokens');
  });

  it('draws each agent’s context buckets with the memory-heavy tag', () => {
    const html = renderToStaticMarkup(<ContextBucketsSection usage={loaded(usage)} />);
    expect(html).toContain('memory-heavy');
    expect(html).toContain('Memory and instructions 30%');
    expect(html).toContain('width:30%');
  });
});
