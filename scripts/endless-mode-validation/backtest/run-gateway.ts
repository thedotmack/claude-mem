// Replays one session's rebuilt requests through the real wire gateway (in this process, OS-picked ports)
// with Endless Mode on, and records what the gateway forwarded upstream.
//
// What runs for real: WireGatewayService with its default stage chain (durable header, memory injection,
// Endless Mode, memory_search tool, head cache breakpoint), identity / turn detection, the conversation
// ledger, the relay's pairing check; WireObservationLookup with its real miss backoff, on the simulated
// clock; fetchToolObservationsFromWorker over HTTP to the real WireRoutes handler (renderAgentTableRow,
// formatTime, loadContextConfig, projectMemoryContent). What is faked: the upstream (answers {} to every
// request), the worker's database (getSessionStore().getToolUseObservations answers from observations.json,
// only the observations that existed at the simulated time), and the durable header's fetch (what MY_RULES_FILE
// holds, read only: your claude-mem MY-RULES.md as it is on disk now).
//
// Usage (backtest/run.sh runs it): EMV_BACKTEST_WORK_DIR=<work dir> CLAUDE_MEM_DATA_DIR=<work dir>/data DO_NOT_TRACK=1 \
//   bun scripts/endless-mode-validation/backtest/run-gateway.ts <session dir> <timeline|observation> [cont|real]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import express from 'express';

const workDir = process.env.EMV_BACKTEST_WORK_DIR;
if (!workDir || !process.env.CLAUDE_MEM_DATA_DIR || !process.env.CLAUDE_MEM_DATA_DIR.startsWith(`${workDir}/`)) {
  throw new Error('CLAUDE_MEM_DATA_DIR must point inside EMV_BACKTEST_WORK_DIR (never your real claude-mem data dir)');
}

const [sessionDir, rowFormat, variantArg] = process.argv.slice(2);
// Variants: cont (default; the history Claude Code compacted put back), real (the history as recorded,
// compactions included).
const variant = variantArg ?? 'cont';
if (!['cont', 'real'].includes(variant)) throw new Error(`unknown variant ${variant}`);
if (!sessionDir || !['timeline', 'observation'].includes(rowFormat)) throw new Error('usage: run_gateway.ts <session dir> <timeline|observation>');

const { WireRoutes } = await import('../../../src/services/worker/http/routes/WireRoutes.js');
const { ModeManager } = await import('../../../src/services/domain/ModeManager.js');
const { addWireGatewayRoute } = await import('../../../src/services/wire-gateway/routes.js');
const { WireConversationLedger } = await import('../../../src/services/wire-gateway/ledger/conversation-ledger.js');
const { WireObservationLookup, fetchToolObservationsFromWorker } = await import('../../../src/services/wire-gateway/endless/observation-lookup.js');
const { startWireGatewayForTest } = await import('../../../tests/wire-gateway/helpers/start-wire-gateway.js');
const { startFakeUpstream } = await import('../../../tests/wire-gateway/helpers/fake-upstream.js');
const { scanDocument, arrayElements, rawText } = await import('../../../src/services/wire-gateway/json/scanner.js');
const { ScannedObject } = await import('../../../src/services/wire-gateway/ir/scanned-object.js');
const { parseWireRequest } = await import('../../../src/services/wire-gateway/ir/request-parsers.js');
const { userTurnPositionOfRequest } = await import('../../../src/services/wire-gateway/identity/turn-start.js');

interface Session {
  meta: { session_id: string; ttl: '5m' | '1h' };
  blocks: Record<string, { raw: string; tokens: number; kind: string }>;
  requests: Array<{
    i: number; ts: string; ttl?: '5m' | '1h'; model: string; sys: string[]; tools: string[];
    cache_control: Array<{ path: Array<string | number>; value: Record<string, unknown> }> | null;
    msgs_cont: Array<[string, string[]]>;
  }>;
}
interface ObservationRow {
  observation_id: number; type: string; title: string | null; subtitle: string | null; narrative: string | null; facts: string | null;
  files_read: string | null; files_modified: string | null; created_at_epoch: number; available_at_ms: number;
}

const session = JSON.parse(readFileSync(join(sessionDir, 'session.json'), 'utf8')) as Session;
const historyOf = (request: any): Array<[string, string[]]> => (variant === 'real' ? request.msgs_real : request.msgs_cont);
const observations = JSON.parse(readFileSync(join(sessionDir, 'observations.json'), 'utf8')) as Record<string, ObservationRow[]>;
const sessionId = session.meta.session_id;

let simulatedNowMs = 0;

// --- the worker: the real WireRoutes handler over a store that answers from observations.json at the simulated time
ModeManager.getInstance().loadMode('code');
const store = {
  getToolUseObservations(query: { contentSessionId: string; toolUseIds: string[] }) {
    const rows = [];
    for (const toolUseId of [...new Set(query.toolUseIds)].sort()) {
      for (const o of observations[toolUseId] ?? []) {
        if (o.available_at_ms > simulatedNowMs) continue;
        rows.push({ tool_use_id: toolUseId, observation_id: o.observation_id, type: o.type, title: o.title, subtitle: o.subtitle, narrative: o.narrative,
          facts: o.facts, files_read: o.files_read, files_modified: o.files_modified, created_at_epoch: o.created_at_epoch });
      }
    }
    return rows;
  },
};
const app = express();
app.use(express.json({ limit: '50mb' }));
new WireRoutes({ getSessionStore: () => store } as any).setupRoutes(app as any);
const workerServer = await new Promise<import('http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const workerPort = (workerServer.address() as { port: number }).port;

const pendingLookups = new Set<Promise<unknown>>();
const observationLookup = new WireObservationLookup({
  now: () => simulatedNowMs,
  fetchToolObservations: query => {
    const promise = fetchToolObservationsFromWorker(query, apiPath => `http://127.0.0.1:${workerPort}${apiPath}`);
    pendingLookups.add(promise);
    promise.finally(() => pendingLookups.delete(promise)).catch(() => undefined);
    return promise;
  },
});

// --- the gateway
const runRoot = join(process.env.CLAUDE_MEM_DATA_DIR!, 'runs', `${session.meta.session_id.slice(0, 8)}-${rowFormat}-${variant}`);
mkdirSync(runRoot, { recursive: true });
const routesFilePath = join(runRoot, 'routes.json');
const ledgerDirectory = join(runRoot, 'ledger');
const upstream = await startFakeUpstream({ kind: 'json', body: { id: 'msg_backtest', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 0, output_tokens: 0 } } });
const ROUTE_ID = 'backtest';
addWireGatewayRoute({
  routeId: ROUTE_ID, agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'native',
  features: { endlessMode: true, durableHeader: true, memoryInjection: false, memorySearchTool: false },
}, routesFilePath);
const myRulesPath = process.env.MY_RULES_FILE ?? '';
const myRules = myRulesPath && existsSync(myRulesPath) ? readFileSync(myRulesPath, 'utf8') : null;
const gateway = await startWireGatewayForTest({
  routesFilePath,
  routesReloadCheckIntervalMs: 0,
  rewriteSettings: { CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_ROW_FORMAT: rowFormat },
  observationLookup,
  conversationLedger: new WireConversationLedger({ directory: ledgerDirectory }),
  memory: { header: { fetchHeader: async () => ({ text: myRules, hash: createHash('sha256').update(myRules ?? '').digest('hex') }) } },
} as any);

// --- bodies
const ttlJson = (value: Record<string, unknown>) => JSON.stringify(value);
const marker = (ttl: '5m' | '1h') => (ttl === '1h' ? '{"type":"ephemeral","ttl":"1h"}' : '{"type":"ephemeral"}');
const withCacheControl = (raw: string, cc: string) => `${raw.slice(0, -1)},"cache_control":${cc}}`;

function bodyOf(request: Session['requests'][number]): string {
  const systemMarks = new Map<number, string>();
  const toolMarks = new Map<number, string>();
  if (request.cache_control) {
    for (const c of request.cache_control) {
      if (c.path[0] === 'system') systemMarks.set(c.path[1] as number, ttlJson(c.value));
      if (c.path[0] === 'tools') toolMarks.set(c.path[1] as number, ttlJson(c.value));
    }
  } else if (request.sys.length >= 2) {
    systemMarks.set(request.sys.length - 2, marker(request.ttl ?? session.meta.ttl));
    systemMarks.set(request.sys.length - 1, marker(request.ttl ?? session.meta.ttl));
  }
  const raw = (id: string) => session.blocks[id].raw;
  const system = request.sys.map((id, index) => (systemMarks.has(index) ? withCacheControl(raw(id), systemMarks.get(index)!) : raw(id)));
  const tools = request.tools.map((id, index) => (toolMarks.has(index) ? withCacheControl(raw(id), toolMarks.get(index)!) : raw(id)));
  const history = historyOf(request);
  const messages = history.map(([role, ids], messageIndex) => {
    const last = messageIndex === history.length - 1;
    const blocks = ids.map((id, blockIndex) => (last && blockIndex === ids.length - 1 ? withCacheControl(raw(id), marker(request.ttl ?? session.meta.ttl)) : raw(id)));
    return `{"role":${JSON.stringify(role)},"content":[${blocks.join(',')}]}`;
  });
  return `{"model":${JSON.stringify(request.model)},"max_tokens":128000,"thinking":{"type":"adaptive"},"system":[${system.join(',')}],"tools":[${tools.join(',')}],"messages":[${messages.join(',')}]}`;
}

// --- reading back what the gateway forwarded
const CACHE_CONTROL_MEMBER = /,"cache_control":\{[^{}]*\}/;
const idByRaw = new Map<string, string>();
for (const [id, block] of Object.entries(session.blocks)) idByRaw.set(block.raw, id);
const newBlocks: Record<string, string> = {};
function idOfRaw(blockRaw: string): { id: string; ttl: string | null } {
  const match = CACHE_CONTROL_MEMBER.exec(blockRaw);
  const stripped = match ? blockRaw.replace(CACHE_CONTROL_MEMBER, '') : blockRaw;
  const ttl = match ? ((JSON.parse(match[0].slice(1).replace(/^"cache_control":/, '')) as { ttl?: string }).ttl ?? '5m') : null;
  let id = idByRaw.get(stripped);
  if (!id) {
    id = `new:${createHash('sha256').update(stripped).digest('hex').slice(0, 24)}`;
    newBlocks[id] = stripped;
  }
  return { id, ttl };
}
const encoder = new TextEncoder();
function readBack(bodyBytes: Uint8Array) {
  const root = new ScannedObject(bodyBytes, scanDocument(bodyBytes));
  const elements = (key: string) => {
    const span = root.spanOf(key);
    return span?.type === 'array' ? [...arrayElements(bodyBytes, span)] : [];
  };
  const bps: Array<Array<string | number>> = [];
  const sys = elements('system').map((span, index) => { const { id, ttl } = idOfRaw(rawText(bodyBytes, span)); if (ttl) bps.push(['system', index, ttl]); return id; });
  const tools = elements('tools').map((span, index) => { const { id, ttl } = idOfRaw(rawText(bodyBytes, span)); if (ttl) bps.push(['tools', index, ttl]); return id; });
  const msgs = elements('messages').map((span, messageIndex) => {
    const message = ScannedObject.of(bodyBytes, span)!;
    const contentSpan = message.spanOf('content');
    const role = message.string('role') ?? '?';
    if (contentSpan?.type !== 'array') {
      const text = message.string('content') ?? '';
      return [role, [idOfRaw(JSON.stringify({ type: 'text', text })).id]];
    }
    const ids = [...arrayElements(bodyBytes, contentSpan)].map((blockSpan, blockIndex) => {
      const { id, ttl } = idOfRaw(rawText(bodyBytes, blockSpan));
      if (ttl) bps.push(['messages', messageIndex, blockIndex, ttl]);
      return id;
    });
    return [role, ids];
  });
  return { sys, tools, msgs, bps };
}

// --- replay
const out: unknown[] = [];
const decoder = new TextDecoder();
let failOpenSuspects = 0;
const startedAt = performance.now();
for (const request of session.requests) {
  simulatedNowMs = Date.parse(request.ts);
  const body = bodyOf(request);
  const bodyBytes = encoder.encode(body);
  const parsed = parseWireRequest('anthropic', bodyBytes);
  const position = userTurnPositionOfRequest(parsed);
  upstream.requests.length = 0;
  const response = await fetch(`${gateway.baseUrl}/r/${ROUTE_ID}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'backtest', 'anthropic-version': '2023-06-01', 'x-claude-mem-session': sessionId },
    body,
  });
  await response.arrayBuffer();
  if (response.status !== 200 || upstream.requests.length !== 1) throw new Error(`request ${request.i}: gateway answered ${response.status}, upstream saw ${upstream.requests.length}`);
  const forwarded = upstream.requests[0].body;
  // Let the background lookups this request started finish before the next request (they would have had
  // the time between the two requests in the real session).
  while (pendingLookups.size > 0) await Promise.allSettled([...pendingLookups]);
  await new Promise(resolve => setTimeout(resolve, 0));
  const read = readBack(forwarded);
  const hasTimeline = decoder.decode(forwarded).includes('<claude-mem-timeline>');
  if (!hasTimeline) failOpenSuspects++;
  out.push({ i: request.i, turn: position.userTurnOrdinal, within_turn: position.withinTurn, has_timeline: hasTimeline, sent_bytes: bodyBytes.length, forwarded_bytes: forwarded.length, ...read });
  upstream.requests.length = 0;
  if (request.i % 50 === 0) console.error(`${sessionId.slice(0, 8)} ${rowFormat}: request ${request.i}/${session.requests.length} (${Math.round((performance.now() - startedAt) / 1000)} s)`);
}
writeFileSync(join(sessionDir, `gateway-${rowFormat}${variant === 'cont' ? '' : `-${variant}`}.json`), JSON.stringify({ requests: out, new_blocks: newBlocks, ledger_directory: ledgerDirectory, requests_without_timeline: failOpenSuspects }));
console.error(`${sessionId.slice(0, 8)} ${rowFormat}: done, ${session.requests.length} requests, ${failOpenSuspects} without a timeline, ${Math.round((performance.now() - startedAt) / 1000)} s`);
await gateway.stop();
await upstream.stop();
workerServer.close();
process.exit(0);
