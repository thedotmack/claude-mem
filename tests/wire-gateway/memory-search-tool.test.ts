import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { addWireGatewayRoute, readWireGatewayRoutesFile, setWireGatewayRouteFeature } from '../../src/services/wire-gateway/routes.js';
import { WireConversationLedger } from '../../src/services/wire-gateway/ledger/conversation-ledger.js';
import { parseWireRequest } from '../../src/services/wire-gateway/ir/request-parsers.js';
import { appendArrayItems } from '../../src/services/wire-gateway/memory/stitch/stitch-events.js';
import { getSpan } from '../../src/services/wire-gateway/json/scanner.js';
import { validateWireGatewayListenSettings } from '../../src/services/wire-gateway/config.js';
import {
  appendToolDefinition,
  hiddenToolNameFor,
  memorySearchToolDefinition,
} from '../../src/services/wire-gateway/memory/memory-search-stage.js';
import { buildWireMemoryStatus, formatWireMemoryStatus } from '../../src/services/wire-gateway/memory/memory-status.js';
import { memoryInjectionEnabledFor } from '../../src/services/wire-gateway/memory/memory-injection-stage.js';
import type { WireStatusReport } from '../../src/services/wire-gateway/drift/agent-status.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';
import { STITCH_PROTOCOL_CASES } from './helpers/stitch-scripts.js';

// The hidden tool's definition (plan Phase 12 task 2): appended at the end
// of `tools` on a born conversation's first request, frozen, never added
// later; the per-route switches, the settings, and what `wire status` says.

const testRoot = join(WIRE_GATEWAY_DIR, 'memory-search-tool-test');
const routesFilePath = join(testRoot, 'routes.json');
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const textOf = (bytes: Uint8Array) => decoder.decode(bytes);

describe('the hidden tool definition', () => {
  it('is named memory_search, or claude_mem_memory_search[_N] when the agent has that name', () => {
    expect(hiddenToolNameFor(['Read'])).toBe('memory_search');
    expect(hiddenToolNameFor(['memory_search'])).toBe('claude_mem_memory_search');
    expect(hiddenToolNameFor(['memory_search', 'claude_mem_memory_search'])).toBe('claude_mem_memory_search_2');
    expect(hiddenToolNameFor(['memory_search', 'claude_mem_memory_search', 'claude_mem_memory_search_2'])).toBe('claude_mem_memory_search_3');
  });

  it('has each protocol\'s own shape with {query (required), limit?}', () => {
    const anthropic = JSON.parse(memorySearchToolDefinition('anthropic', 'memory_search'));
    expect(Object.keys(anthropic)).toEqual(['name', 'description', 'input_schema']);
    expect(anthropic.input_schema.required).toEqual(['query']);
    expect(anthropic.input_schema.properties.limit.type).toBe('integer');
    expect(JSON.parse(memorySearchToolDefinition('openai-chat', 'memory_search')).function.parameters.properties.query.type).toBe('string');
    const responses = JSON.parse(memorySearchToolDefinition('openai-responses', 'memory_search'));
    expect([responses.type, responses.name]).toEqual(['function', 'memory_search']);
    expect(Object.keys(JSON.parse(memorySearchToolDefinition('gemini', 'memory_search')))).toEqual(['name', 'description', 'parameters']);
  });

  it('goes at the end of tools, twice is once; Gemini into the last functionDeclarations', () => {
    for (const testCase of STITCH_PROTOCOL_CASES) {
      const body = encoder.encode(testCase.requestBody(true));
      const request = parseWireRequest(testCase.protocol, body, { suffixPath: testCase.streamPath.split('?')[0] });
      const definition = memorySearchToolDefinition(testCase.protocol, 'memory_search');
      const once = appendToolDefinition(request, definition);
      expect(textOf(once)).toContain(`${definition}]`);
      const twice = appendToolDefinition(parseWireRequest(testCase.protocol, once, { suffixPath: testCase.streamPath.split('?')[0] }), definition);
      expect(twice).toBe(once);
      expect(textOf(twice)).toBe(textOf(once));
    }
    const gemini = encoder.encode('{"contents":[],"tools":[{"googleSearch":{}},{"functionDeclarations":[{"name":"a"}]}]}');
    const appended = appendToolDefinition(parseWireRequest('gemini', gemini, { suffixPath: '/v1beta/models/g:generateContent' }), '{"name":"memory_search"}');
    expect(textOf(appended)).toBe('{"contents":[],"tools":[{"googleSearch":{}},{"functionDeclarations":[{"name":"a"},{"name":"memory_search"}]}]}');
    const noTools = encoder.encode('{"model":"m","messages":[]}');
    expect(textOf(appendToolDefinition(parseWireRequest('openai-chat', noTools), '{"type":"function"}'))).toBe('{"model":"m","messages":[],"tools":[{"type":"function"}]}');
  });
});

describe('the hidden tool through the relay', () => {
  let upstream: FakeUpstream;
  let gateway: StartedWireGateway;
  const anthropicCase = STITCH_PROTOCOL_CASES[0];

  beforeAll(async () => {
    rmSync(testRoot, { recursive: true, force: true });
    upstream = await startFakeUpstream({ kind: 'json', body: { ok: true } });
    addWireGatewayRoute({ routeId: 'tool-on', agentId: 'claude-code', upstreamBaseUrl: upstream.url, captureSource: 'wire', features: { memorySearchTool: true, memoryInjection: false } }, routesFilePath);
    gateway = await startWireGatewayForTest({ routesFilePath, conversationLedger: new WireConversationLedger({ directory: join(testRoot, 'ledger') }) });
  });

  afterAll(async () => {
    await gateway?.stop();
    await upstream?.stop();
    rmSync(testRoot, { recursive: true, force: true });
  });

  async function send(body: Uint8Array, session: string): Promise<Uint8Array> {
    const response = await fetch(`${gateway.baseUrl}/r/tool-on/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'x-claude-mem-session': session },
      body,
    });
    await response.arrayBuffer();
    return upstream.requests[upstream.requests.length - 1].body;
  }

  const first = encoder.encode(anthropicCase.requestBody(false));
  const later = appendArrayItems(first, getSpan(first, ['messages'])!, ['{"role":"assistant","content":"ok"}', '{"role":"user","content":"more"}']);

  it('is offered from the first request and frozen: the same tools bytes on every later request', async () => {
    const sentFirst = await send(first, 'tool-frozen');
    const sentLater = await send(later, 'tool-frozen');
    const toolsOf = (bytes: Uint8Array) => textOf(bytes.subarray(getSpan(bytes, ['tools'])!.start, getSpan(bytes, ['tools'])!.end));
    expect(toolsOf(sentFirst)).toContain('"name":"memory_search"');
    expect(toolsOf(sentLater)).toBe(toolsOf(sentFirst));
  });

  it('is never added to a conversation not born under the gateway', async () => {
    expect(textOf(await send(later, 'tool-not-born'))).toBe(textOf(later));
  });

  it('turned off for one request after being offered, it is never offered there again', async () => {
    await send(first, 'tool-suspended');
    setWireGatewayRouteFeature('tool-on', 'memorySearchTool', false, routesFilePath);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(textOf(await send(later, 'tool-suspended'))).toBe(textOf(later));
    setWireGatewayRouteFeature('tool-on', 'memorySearchTool', true, routesFilePath);
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(textOf(await send(later, 'tool-suspended'))).toBe(textOf(later));
    // A new conversation gets it again.
    expect(textOf(await send(first, 'tool-fresh'))).toContain('"name":"memory_search"');
  }, 10_000);

  it('GET /wire/status says per route what is on, and the stages\' counters', async () => {
    const response = await fetch(`${gateway.baseUrl}/wire/status`);
    const report = await response.json() as WireStatusReport;
    expect(report.memory?.mcpPath).toBe('/mcp');
    const route = report.memory?.routes.find(entry => entry.routeId === 'tool-on');
    expect(route?.memorySearchTool).toEqual({ on: true, decidedBy: 'route' });
    expect(route?.memoryInjection).toEqual({ on: false, decidedBy: 'route' });
    expect(route?.endlessMode).toEqual({ on: false, decidedBy: 'setting' });
    expect(report.memory?.stages?.['memory-search']?.calls).toBeGreaterThan(0);
  });
});

describe('memory settings and status', () => {
  it('validates the Phase 12 settings', () => {
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION: 'yes' })).toContain('MEMORY_INJECTION');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_MEMORY_SEARCH_TOOL: '1' })).toContain('MEMORY_SEARCH_TOOL');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_CONTEXT_TIMEOUT_MS: '0' })).toContain('CONTEXT_TIMEOUT_MS');
    expect(validateWireGatewayListenSettings({ CLAUDE_MEM_WIRE_GATEWAY_CONTEXT_TIMEOUT_MS: '1.5' })).toContain('CONTEXT_TIMEOUT_MS');
    expect(validateWireGatewayListenSettings({
      CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION: 'false', CLAUDE_MEM_WIRE_GATEWAY_MEMORY_SEARCH_TOOL: 'true', CLAUDE_MEM_WIRE_GATEWAY_CONTEXT_TIMEOUT_MS: '1500',
    })).toBeNull();
  });

  it('injection is on for capture=wire routes by default, off for native ones, and a route\'s own switch wins', () => {
    const route = (captureSource: 'wire' | 'native', memoryInjection?: boolean) => ({
      agentId: 'a', upstreamBaseUrl: 'http://x', captureSource, features: memoryInjection === undefined ? {} : { memoryInjection }, createdAt: '',
    });
    expect(memoryInjectionEnabledFor(route('wire'), {})).toBe(true);
    expect(memoryInjectionEnabledFor(route('wire'), { CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION: 'false' })).toBe(false);
    expect(memoryInjectionEnabledFor(route('native'), {})).toBe(false);
    expect(memoryInjectionEnabledFor(route('native', true), {})).toBe(true);
    expect(memoryInjectionEnabledFor(route('wire', false), {})).toBe(false);
  });

  it('wire status prints one line per route and the stage counters', () => {
    rmSync(testRoot, { recursive: true, force: true });
    addWireGatewayRoute({ routeId: 'codex-main', agentId: 'codex', upstreamBaseUrl: 'https://api.openai.com/v1', captureSource: 'wire', features: { memorySearchTool: true } }, routesFilePath);
    const status = buildWireMemoryStatus(readWireGatewayRoutesFile(routesFilePath).routes, { CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION: 'true' }, { 'memory-injection': { calls: 3, failures: 1, averageMicros: 10, lastError: 'onRequest: boom' } });
    const lines = formatWireMemoryStatus(status, 'http://127.0.0.1:37677');
    expect(lines).toContain('Memory: MCP tools at http://127.0.0.1:37677/mcp');
    expect(lines.some(line => /^codex-main\s+on\s+on \(route\)\s+off$/.test(line))).toBe(true);
    expect(lines).toContain('  stage memory-injection: 3 calls, 1 failures (last: onRequest: boom)');
    rmSync(testRoot, { recursive: true, force: true });
  });
});

describe('the search worker client', () => {
  it('POSTs /api/dumb-search with the query and limit, and reads its text content', async () => {
    const seen: Array<{ path: string; body: unknown }> = [];
    const worker = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        seen.push({ path: new URL(request.url).pathname, body: await request.json() });
        return Response.json({ content: [{ type: 'text', text: 'memory one' }, { type: 'text', text: 'memory two' }] });
      },
    });
    try {
      const { searchMemoryInWorker } = await import('../../src/services/wire-gateway/memory/memory-worker-client.js');
      const answer = await searchMemoryInWorker({ query: 'auth', limit: 3, timeoutMs: 1_000 }, apiPath => `http://127.0.0.1:${worker.port}${apiPath}`);
      expect(answer).toEqual({ text: 'memory one\nmemory two', isError: false });
      expect(seen).toEqual([{ path: '/api/dumb-search', body: { query: 'auth', limit: 3 } }]);
    } finally {
      worker.stop(true);
    }
  });

  it('says why there is no answer: aborted, timed out, or unreachable, each as it is', async () => {
    // A worker that never answers.
    const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => undefined) });
    const urlOf = (apiPath: string) => `http://127.0.0.1:${worker.port}${apiPath}`;
    const { searchMemoryInWorker } = await import('../../src/services/wire-gateway/memory/memory-worker-client.js');
    const failureOf = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        return String(error);
      }
      return 'no failure';
    };
    try {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 30);
      const aborted = await failureOf(() => searchMemoryInWorker({ query: 'auth', timeoutMs: 10_000, signal: abort.signal }, urlOf));
      expect(aborted).toContain('the request to the worker was aborted');
      expect(aborted).not.toContain('within');
      const timedOut = await failureOf(() => searchMemoryInWorker({ query: 'auth', timeoutMs: 50 }, urlOf));
      expect(timedOut).toContain('no answer from the worker within 50 ms');
    } finally {
      worker.stop(true);
    }
    const unreachable = await failureOf(() => searchMemoryInWorker({ query: 'auth', timeoutMs: 10_000 }, urlOf));
    expect(unreachable).toContain('the worker could not be reached');
  });
});
