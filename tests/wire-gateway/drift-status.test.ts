import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BUILT_IN_AGENT_DESCRIPTORS } from '../../src/services/wire-gateway/agents/builtin-agents.js';
import type { AgentDescriptor } from '../../src/services/wire-gateway/agents/types.js';
import { removeWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { connectAgent, disconnectAgent } from '../../src/services/wire-gateway/wiring/wiring-engine.js';
import { updateAppliedRecords } from '../../src/services/wire-gateway/wiring/wiring-records.js';
import {
  BYPASS_GRACE_MS,
  LAST_USED_TAIL_BYTES,
  evaluateWireAgentStatuses,
  formatWireStatusReport,
  isBypassed,
  readAgentLastUsed,
  withUrlSecretsMasked,
  type WireAgentStatus,
  type WireAgentStatusInputs,
} from '../../src/services/wire-gateway/drift/agent-status.js';
import { AgentLastSeenTracker, readLastSeenFile } from '../../src/services/wire-gateway/drift/last-seen.js';
import {
  ProbeAnswerCache,
  noProxyExempts,
  parseScutilProxyOutput,
  probeIdentityDirectly,
  probeIdentityThroughProxy,
  probeLookupFor,
  proxyRouteFor,
} from '../../src/services/wire-gateway/drift/reachability.js';
import { parseRawHttpResponse, readResponseTextWithinLimit } from '../../src/services/wire-gateway/direct-http.js';
import { wireStatusGatewayOrigin } from '../../src/services/wire-gateway/WireGatewayService.js';
import { startFakeUpstream, type FakeUpstream } from './helpers/fake-upstream.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';
import { TEST_GATEWAY_ORIGIN, WiringSandbox, recordingSideEffects } from './helpers/wiring-sandbox.js';

// Phase 9: drift, reachability and bypass. Every agent home is a sandbox
// under the test data dir (never a real ~/.codex or ~/.claude); probes are
// stubbed unless a test starts its own servers.

const MINUTE_MS = 60_000;
const IS_WINDOWS = process.platform === 'win32';

const sandboxes: WiringSandbox[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  while (sandboxes.length) sandboxes.pop()!.remove();
});

function sandbox(label: string, env: Record<string, string | undefined> = {}): WiringSandbox {
  const created = new WiringSandbox(label, env);
  sandboxes.push(created);
  return created;
}

function descriptor(id: string): AgentDescriptor {
  return BUILT_IN_AGENT_DESCRIPTORS.find((candidate) => candidate.id === id)!;
}

/** Connect an agent in the sandbox, stamped `connectedMinutesAgo` ago. */
async function connectInSandbox(box: WiringSandbox, agentId: string, connectedMinutesAgo = 10): Promise<void> {
  await connectAgent(descriptor(agentId), box.options(recordingSideEffects()));
  // As if the connect ran `connectedMinutesAgo` minutes ago: its applied record's time is what bypass detection reads.
  updateAppliedRecords(box.wiringDirectory, (agents) => {
    agents[agentId].at = new Date(Date.now() - connectedMinutesAgo * MINUTE_MS).toISOString();
  });
}

function statusInputs(box: WiringSandbox, overrides: Partial<WireAgentStatusInputs> = {}): WireAgentStatusInputs {
  return {
    environment: box.environment,
    gatewayOrigin: TEST_GATEWAY_ORIGIN,
    wiringDirectory: box.wiringDirectory,
    routesFilePath: box.routesFilePath,
    descriptors: BUILT_IN_AGENT_DESCRIPTORS,
    lastSeen: { kind: 'read', lastSeenByAgent: {} },
    gatewayStartedAt: Date.now() - 60 * MINUTE_MS,
    lookupProbe: probeLookupFor(new ProbeAnswerCache(), 'wait'),
    probeIdentity: async (base) => base === TEST_GATEWAY_ORIGIN,
    probeThroughProxy: async () => true,
    readSystemProxy: async () => null,
    ...overrides,
  };
}

async function statusOf(box: WiringSandbox, agentId: string, overrides: Partial<WireAgentStatusInputs> = {}): Promise<WireAgentStatus | undefined> {
  const { agents } = await evaluateWireAgentStatuses(statusInputs(box, overrides));
  return agents.find((agent) => agent.agentId === agentId);
}

function codexSandbox(label: string, env: Record<string, string | undefined> = {}): WiringSandbox {
  const box = sandbox(label, env);
  box.write('.codex/config.toml', 'model = "gpt-5"\n');
  return box;
}

function writeCodexPrompt(box: WiringSandbox, atMs: number): void {
  box.write('.codex/history.jsonl', `${JSON.stringify({ session_id: 's', ts: Math.floor(atMs / 1000), text: 'hi' })}\n`);
}

describe('ok, replaced and unwired (ported applied_test.go TestDriftReplaced, TestDriftUnwiredEveryAgent, TestCodexDriftProfile)', () => {
  it('a freshly connected agent is ok, and not listed once disconnected', async () => {
    const box = codexSandbox('ok');
    await connectInSandbox(box, 'codex');
    const status = await statusOf(box, 'codex');
    expect(status?.state).toBe('ok');
    expect(status?.fix).toBeNull();
    expect(status?.routeIds).toEqual(['codex']);
    await disconnectAgent('codex', box.options());
    expect(await statusOf(box, 'codex')).toBeUndefined();
  });

  it('a value connect wrote, changed outside claude-mem, is replaced (and left as it is)', async () => {
    const box = codexSandbox('replaced');
    await connectInSandbox(box, 'codex');
    box.write('.codex/config.toml', 'model = "gpt-5"\nopenai_base_url = "https://api.openai.com/v1"\n');
    const status = await statusOf(box, 'codex');
    expect(status?.state).toBe('replaced');
    expect(status?.field).toEqual({
      filePath: box.path('.codex/config.toml'),
      keyPath: 'openai_base_url',
      now: 'https://api.openai.com/v1',
      want: `${TEST_GATEWAY_ORIGIN}/r/codex/v1`,
    });
    expect(status?.fix).toContain('claude-mem wire disconnect codex');
    expect(box.read('.codex/config.toml')).toContain('https://api.openai.com/v1');

    // A key removed outright reads the same way.
    box.write('.codex/config.toml', 'model = "gpt-5"\n');
    const removed = await statusOf(box, 'codex');
    expect(removed?.state).toBe('replaced');
    expect(removed?.detail).toContain('(absent)');
  });

  it('every built-in with a config file reports a swapped base URL', async () => {
    const box = sandbox('every-agent');
    box.write('.claude/settings.json', '{"env":{"ANTHROPIC_API_KEY":"sk-ant-api03-test"}}');
    box.write('.gemini/settings.json', '{"security":{"auth":{"selectedType":"gemini-api-key"}}}');
    box.write('.gemini/.env', 'GEMINI_API_KEY=abc\n');
    for (const agentId of ['claude-code', 'gemini-cli']) await connectInSandbox(box, agentId);
    expect((await statusOf(box, 'claude-code'))?.state).toBe('ok');
    expect((await statusOf(box, 'gemini-cli'))?.state).toBe('ok');
    box.write('.claude/settings.json', '{"env":{"ANTHROPIC_API_KEY":"sk-ant-api03-test","ANTHROPIC_BASE_URL":"https://other.example"}}');
    box.write('.gemini/.env', 'GEMINI_API_KEY=abc\nGOOGLE_GEMINI_BASE_URL=https://other.example\n');
    expect((await statusOf(box, 'claude-code'))?.state).toBe('replaced');
    expect((await statusOf(box, 'gemini-cli'))?.state).toBe('replaced');
  });

  it('a Codex switched to another provider is unwired, naming the key it uses now', async () => {
    const box = codexSandbox('unwired-provider');
    await connectInSandbox(box, 'codex');
    const wired = box.read('.codex/config.toml')!;
    box.write('.codex/config.toml', `model_provider = "azure"\n${wired}\n[model_providers.azure]\nbase_url = "https://example.openai.azure.com/openai"\n`);
    const status = await statusOf(box, 'codex');
    expect(status?.state).toBe('unwired');
    expect(status?.field?.keyPath).toBe('model_providers.azure.base_url');
    expect(status?.detail).toContain('https://example.openai.azure.com/openai');
    expect(status?.fix).toBe('claude-mem wire disconnect codex && claude-mem wire connect codex');
  });

  it('a removed route is unwired', async () => {
    const box = codexSandbox('unwired-route');
    await connectInSandbox(box, 'codex');
    removeWireGatewayRoute('codex', box.routesFilePath);
    const status = await statusOf(box, 'codex');
    expect(status?.state).toBe('unwired');
    expect(status?.detail).toContain('route(s) codex were removed');
  });

  it('an OpenCode provider added after connect is unwired; one in another merged file is a note', async () => {
    const box = sandbox('opencode');
    box.write('.config/opencode/opencode.jsonc', '{\n  "provider": {\n    "openrouter": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://openrouter.ai/api/v1" } }\n  }\n}\n');
    await connectInSandbox(box, 'opencode');
    box.write('.config/opencode/config.json', '{"provider":{"groq":{"options":{"baseURL":"https://api.groq.com/openai/v1"}}}}');
    const okStatus = await statusOf(box, 'opencode');
    expect(okStatus?.state).toBe('ok');
    expect(okStatus?.notes.join('\n')).toContain(`OpenCode also merges ${box.path('.config/opencode/config.json')}; its providers (groq)`);

    const wired = box.read('.config/opencode/opencode.jsonc')!;
    box.write('.config/opencode/opencode.jsonc', wired.replace('"provider": {', '"provider": {\n    "deepseek": { "options": { "baseURL": "https://api.deepseek.com" } },'));
    const status = await statusOf(box, 'opencode');
    expect(status?.state).toBe('unwired');
    expect(status?.field?.keyPath).toBe('provider.deepseek.options.baseURL');
  });

  it('a reverse proxy in front of the gateway is ok while it answers as us, replaced when it does not', async () => {
    const box = codexSandbox('reverse-proxy');
    await connectInSandbox(box, 'codex');
    box.write('.codex/config.toml', 'model = "gpt-5"\nopenai_base_url = "https://ai.corp.example/claude-mem/r/codex/v1"\n');
    const probed: string[] = [];
    const answering = await statusOf(box, 'codex', {
      probeIdentity: async (base) => {
        probed.push(base);
        return base === TEST_GATEWAY_ORIGIN || base === 'https://ai.corp.example/claude-mem';
      },
    });
    expect(answering?.state).toBe('ok');
    expect(probed).toContain('https://ai.corp.example/claude-mem');
    const silent = await statusOf(box, 'codex', { probeIdentity: async (base) => base === TEST_GATEWAY_ORIGIN });
    expect(silent?.state).toBe('replaced');
  });

  it('saved provider URLs are shown with their userinfo and secret query values masked', async () => {
    const box = codexSandbox('masked-urls');
    await connectInSandbox(box, 'codex');
    const wired = box.read('.codex/config.toml')!;
    box.write('.codex/config.toml', `model_provider = "azure"\n${wired}\n[model_providers.azure]\nbase_url = "https://alice:hunter2@example.openai.azure.com/openai?api-key=sekrit-key&api-version=2024-10-01"\n`);
    const unwired = await statusOf(box, 'codex');
    expect(unwired?.state).toBe('unwired');
    expect(unwired?.field?.now).toBe('https://***@example.openai.azure.com/openai?api-key=***&api-version=2024-10-01');
    expect(unwired?.detail).toContain('https://***@example.openai.azure.com/openai?api-key=***&api-version=2024-10-01');

    box.write('.codex/config.toml', 'model = "gpt-5"\nopenai_base_url = "https://bob:p%40ss@api.example.com/v1?token=abc123"\n');
    const replaced = await statusOf(box, 'codex');
    expect(replaced?.state).toBe('replaced');
    expect(replaced?.field?.now).toBe('https://***@api.example.com/v1?token=***');

    for (const status of [unwired!, replaced!]) {
      const shown = `${JSON.stringify(status)}\n${formatWireStatusReport({ generatedAt: '', gateway: { origin: TEST_GATEWAY_ORIGIN, running: true }, capture: null, problems: [], agents: [status] }).join('\n')}`;
      for (const secret of ['alice', 'hunter2', 'sekrit-key', 'bob', 'p%40ss', 'abc123']) expect(shown).not.toContain(secret);
    }
    // A clean value is kept exactly as written; a non-URL is left alone.
    expect(withUrlSecretsMasked('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(withUrlSecretsMasked('not a url')).toBe('not a url');
    expect(withUrlSecretsMasked(undefined)).toBeUndefined();
  });

  it('Gemini CLI carries its trusted-folder note', async () => {
    const box = sandbox('gemini-note');
    box.write('.gemini/settings.json', '{"security":{"auth":{"selectedType":"gemini-api-key"}}}');
    await connectInSandbox(box, 'gemini-cli');
    expect((await statusOf(box, 'gemini-cli'))?.notes.join('\n')).toContain('only in folders it trusts');
  });
});

describe('unreachable', () => {
  it('the gateway not answering at the agent\'s address is unreachable, fixed by starting it', async () => {
    const box = codexSandbox('unreachable');
    await connectInSandbox(box, 'codex');
    const status = await statusOf(box, 'codex', { probeIdentity: async () => false });
    expect(status?.state).toBe('unreachable');
    expect(status?.fix).toBe('claude-mem wire start');
  });

  it('an agent left on the old port after the port setting changed is told to reconnect', async () => {
    const box = codexSandbox('old-port');
    await connectInSandbox(box, 'codex');
    const status = await statusOf(box, 'codex', { gatewayOrigin: 'http://127.0.0.1:37700', probeIdentity: async () => false });
    expect(status?.state).toBe('unreachable');
    expect(status?.detail).toContain('listens on http://127.0.0.1:37700');
    expect(status?.fix).toContain('wire connect codex');
  });

  it('a route made by hand or `wire run` is checked for the gateway only', async () => {
    const box = sandbox('route-only');
    const { addWireGatewayRoute } = await import('../../src/services/wire-gateway/routes.js');
    addWireGatewayRoute({ routeId: 'my-tool', agentId: 'my-tool', upstreamBaseUrl: 'https://api.example.com' }, box.routesFilePath);
    expect((await statusOf(box, 'my-tool'))?.state).toBe('ok');
    const down = await statusOf(box, 'my-tool', { probeIdentity: async () => false });
    expect(down?.state).toBe('unreachable');
    expect(down?.connectedAt).toBeNull();
  });
});

describe('proxied (ported codex_proxy.go, generalized)', () => {
  it('HTTP_PROXY without a loopback NO_PROXY exemption, through a proxy that does not pass requests on, is proxied', async () => {
    const box = codexSandbox('proxied', { HTTP_PROXY: 'http://user:secret@127.0.0.1:7890' });
    await connectInSandbox(box, 'codex');
    const asked: string[] = [];
    const status = await statusOf(box, 'codex', {
      probeThroughProxy: async (base, proxyUrl) => {
        asked.push(`${proxyUrl} ${base}`);
        return false;
      },
    });
    expect(status?.state).toBe('proxied');
    expect(status?.proxy).toEqual({ url: 'http://***@127.0.0.1:7890', source: 'HTTP_PROXY' });
    expect(status?.detail).not.toContain('secret');
    expect(status?.fix).toContain('NO_PROXY');
    expect(status?.fix).toContain('IP-CIDR,127.0.0.0/8,DIRECT,no-resolve');
    expect(asked).toEqual([`http://user:secret@127.0.0.1:7890 ${TEST_GATEWAY_ORIGIN}`]);

    // A proxy that does pass it on is fine.
    expect((await statusOf(box, 'codex', { probeThroughProxy: async () => true }))?.state).toBe('ok');
  });

  it('NO_PROXY exempts loopback only by IP or CIDR (or *), not by name', async () => {
    for (const [noProxy, expected] of [['127.0.0.1', 'ok'], ['127.0.0.0/8', 'ok'], ['*', 'ok'], ['localhost', 'proxied'], ['10.0.0.0/8', 'proxied']] as const) {
      const box = codexSandbox(`no-proxy-${expected}`, { ALL_PROXY: 'socks5://127.0.0.1:7891', NO_PROXY: noProxy });
      await connectInSandbox(box, 'codex');
      expect((await statusOf(box, 'codex', { probeThroughProxy: async () => false }))?.state).toBe(expected);
    }
  });

  it('the macOS system HTTP proxy counts when no env proxy is set', async () => {
    const box = codexSandbox('system-proxy');
    await connectInSandbox(box, 'codex');
    const status = await statusOf(box, 'codex', { readSystemProxy: async () => ({ http: 'http://127.0.0.1:7890' }), probeThroughProxy: async () => false });
    expect(status?.state).toBe('proxied');
    expect(status?.proxy?.source).toBe("the system's proxy settings");
  });

  it('proxy routing, NO_PROXY and scutil parsing match magpie', () => {
    expect(proxyRouteFor('http://127.0.0.1:37677/', { http_proxy: 'http://p:1' }, null)).toEqual({ proxyUrl: 'http://p:1', source: 'HTTP_PROXY' });
    expect(proxyRouteFor('http://127.0.0.1:37677/', { HTTPS_PROXY: 'http://p:1' }, null)).toBeNull();
    expect(proxyRouteFor('https://corp.example/', { HTTPS_PROXY: 'http://p:1' }, null)?.source).toBe('HTTPS_PROXY');
    expect(proxyRouteFor('http://127.0.0.1:1/', { ALL_PROXY: 'http://a:1' }, { http: 'http://s:1' })?.proxyUrl).toBe('http://s:1');
    expect(noProxyExempts('127.0.0.1', ' 192.168.0.0/16 , 127.0.0.0/8')).toBe(true);
    expect(noProxyExempts('127.0.0.1', '127.0.0.0/33')).toBe(false);
    expect(noProxyExempts('::1', '::1')).toBe(true);
    expect(noProxyExempts('[::1]', 'localhost')).toBe(false);
    expect(noProxyExempts('api.example.com', '.example.com')).toBe(true);
    expect(noProxyExempts('example.com.evil', 'example.com')).toBe(false);
    const scutil = '<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n    1 : 169.254/16\n  }\n  FTPPassive : 1\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 1\n  SOCKSPort : 7892\n  SOCKSProxy : 127.0.0.1\n}\n';
    expect(parseScutilProxyOutput(scutil)).toEqual({ http: 'http://127.0.0.1:7890' });
    expect(parseScutilProxyOutput('<dictionary> {\n  HTTPEnable : 0\n  HTTPProxy : x\n}')).toEqual({ http: '' });
    expect(parseScutilProxyOutput('<dictionary> {\n  SOCKSEnable : 1\n  SOCKSPort : 1080\n  SOCKSProxy : 10.0.0.2\n}')).toEqual({ http: '' });
  });

  it('hostile 1 MB inputs to the scutil, NO_PROXY and raw HTTP parsers finish in bounded time', () => {
    const megabyte = 1024 * 1024;
    const started = performance.now();
    expect(parseScutilProxyOutput(' : '.repeat(megabyte / 3))).toEqual({ http: '' });
    expect(parseScutilProxyOutput(`ExceptionsList : <array> {\n${'  0 : x\n'.repeat(megabyte / 8)}`)).toEqual({ http: '' });
    expect(parseScutilProxyOutput(`HTTPEnable : 1\nHTTPProxy : ${'a'.repeat(megabyte)}\n`).http.length).toBeGreaterThan(megabyte);
    expect(noProxyExempts('127.0.0.1', ','.repeat(megabyte))).toBe(false);
    expect(noProxyExempts('127.0.0.1', `${'1'.repeat(megabyte)}/8`)).toBe(false);
    expect(noProxyExempts('a.example', `${'.'.repeat(megabyte)}example`)).toBe(false);
    expect(noProxyExempts('127.0.0.1', `${'/'.repeat(megabyte)}`)).toBe(false);
    expect(parseRawHttpResponse(Buffer.from(`HTTP/1.1 200 OK\r\nTransfer-Encoding:${' '.repeat(megabyte)}x\r\n\r\n{}`))).toEqual({ statusCode: 200, bodyText: '{}' });
    expect(parseRawHttpResponse(Buffer.from(`HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n${'1\r\nx\r\n'.repeat(megabyte / 8)}`))).toBeNull();
    expect(parseRawHttpResponse(Buffer.from('\r\n'.repeat(megabyte / 2)))).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('bypassed (ported applied_test.go TestDriftBypassed)', () => {
  it('used since connect with nothing reaching the gateway is bypassed, until a request arrives', async () => {
    const box = codexSandbox('bypassed');
    await connectInSandbox(box, 'codex', 10);
    writeCodexPrompt(box, Date.now() - 5 * MINUTE_MS);
    const bypassed = await statusOf(box, 'codex');
    expect(bypassed?.state).toBe('bypassed');
    expect(bypassed?.fix).toBe('quit and reopen Codex');
    expect(bypassed?.lastUsedAt).not.toBeNull();

    // A request arrived since: fine.
    expect((await statusOf(box, 'codex', { lastSeen: { kind: 'read', lastSeenByAgent: { codex: Date.now() } } }))?.state).toBe('ok');
    // Used before the last request.
    writeCodexPrompt(box, Date.now() - MINUTE_MS);
    expect((await statusOf(box, 'codex', { lastSeen: { kind: 'read', lastSeenByAgent: { codex: Date.now() } } }))?.state).toBe('ok');
    // Used while the gateway was down.
    writeCodexPrompt(box, Date.now() - 5 * MINUTE_MS);
    expect((await statusOf(box, 'codex', { gatewayStartedAt: Date.now() }))?.state).toBe('ok');
    // Used before connect.
    writeCodexPrompt(box, Date.now() - 20 * MINUTE_MS);
    expect((await statusOf(box, 'codex'))?.state).toBe('ok');
    // Used in the last 30 s: its request may still be on the way.
    writeCodexPrompt(box, Date.now() - 5_000);
    expect((await statusOf(box, 'codex'))?.state).toBe('ok');
  });

  it('the rule itself', () => {
    const now = Date.now();
    const used = now - 5 * MINUTE_MS;
    expect(isBypassed(used, used - MINUTE_MS, used - MINUTE_MS, null, now)).toBe(true);
    expect(isBypassed(used, used - MINUTE_MS, used - MINUTE_MS, used - 1_000, now)).toBe(false);
    expect(isBypassed(used, used - MINUTE_MS, used - MINUTE_MS, used - 3_000, now)).toBe(true);
    expect(isBypassed(now - BYPASS_GRACE_MS + 1_000, 0, 0, null, now)).toBe(false);
  });

  it('Claude Code\'s history skips / commands and takes milliseconds', async () => {
    const box = sandbox('claude-history');
    const used = Date.now() - 5 * MINUTE_MS;
    box.write('.claude/history.jsonl', [
      JSON.stringify({ display: 'fix the bug', timestamp: used }),
      JSON.stringify({ display: '  /model opus', timestamp: Date.now() - MINUTE_MS }),
      'not json',
      '',
    ].join('\n'));
    const result = readAgentLastUsed(descriptor('claude-code').lastUsed!, box.environment);
    expect(result).toEqual({ kind: 'used', at: Math.floor(used / 1000) * 1000 });
  });

  it('Codex\'s history skips / commands in text, as magpie reads it', () => {
    const box = sandbox('codex-history');
    box.write('.codex/history.jsonl', [
      JSON.stringify({ ts: 1_700_000_000, text: 'refactor this' }),
      JSON.stringify({ ts: 1_700_000_500, text: '/status' }),
    ].join('\n'));
    expect(readAgentLastUsed(descriptor('codex').lastUsed!, box.environment)).toEqual({ kind: 'used', at: 1_700_000_000_000 });
  });

  it('skips nothing when the descriptor names no prompt text field', () => {
    const box = sandbox('plain-history');
    const logPath = box.write('log.jsonl', JSON.stringify({ at: 1_700_000_000, display: '/looks like a command' }));
    const lastUsed = { path: () => logPath, field: 'at', unit: 's' as const };
    expect(readAgentLastUsed(lastUsed, box.environment)).toEqual({ kind: 'used', at: 1_700_000_000_000 });
  });

  it('a hostile 1 MB line and 1 MB of short garbage lines are read in bounded time', () => {
    const box = sandbox('hostile-history');
    const lastUsed = descriptor('claude-code').lastUsed!;
    box.write('.claude/history.jsonl', `{"display":"${'\\"'.repeat(512 * 1024)}\n${JSON.stringify({ display: 'ok', timestamp: 1_700_000_000_000 })}\n`);
    const started = performance.now();
    expect(readAgentLastUsed(lastUsed, box.environment)).toEqual({ kind: 'used', at: 1_700_000_000_000 });
    box.write('.claude/history.jsonl', '{\n'.repeat(512 * 1024));
    expect(readAgentLastUsed(lastUsed, box.environment)).toEqual({ kind: 'none' });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('reads only the last 64 KiB, and a missing log means never used', () => {
    const box = sandbox('history-tail');
    const lastUsed = descriptor('codex').lastUsed!;
    expect(readAgentLastUsed(lastUsed, box.environment)).toEqual({ kind: 'none' });
    const old = `${JSON.stringify({ ts: 2_000_000_000, text: 'far future, but far back in the file' })}\n`;
    const filler = `${JSON.stringify({ ts: 1_700_000_000, text: 'x'.repeat(200) })}\n`.repeat(Math.ceil((LAST_USED_TAIL_BYTES * 2) / 220));
    box.write('.codex/history.jsonl', old + filler);
    expect(readAgentLastUsed(lastUsed, box.environment)).toEqual({ kind: 'used', at: 1_700_000_000_000 });
  });
});

describe('unknown: what cannot be read is never ok', () => {
  it('an unparseable config is unknown', async () => {
    const box = codexSandbox('bad-config');
    await connectInSandbox(box, 'codex');
    box.write('.codex/config.toml', 'openai_base_url = "unterminated\n');
    const status = await statusOf(box, 'codex');
    expect(status?.state).toBe('unknown');
    expect(status?.detail).toContain('cannot be read');
  });

  it.skipIf(IS_WINDOWS)('an unreadable prompt log is unknown', async () => {
    const box = codexSandbox('bad-history');
    await connectInSandbox(box, 'codex');
    mkdirSync(box.path('.codex/history.jsonl'), { recursive: true });
    const status = await statusOf(box, 'codex');
    expect(status?.state).toBe('unknown');
    expect(status?.detail).toContain('history.jsonl cannot be read');
  });

  it('an unreadable last-seen file is unknown where it would decide bypass, and listed as a problem', async () => {
    const box = codexSandbox('bad-last-seen');
    await connectInSandbox(box, 'codex');
    writeCodexPrompt(box, Date.now() - 5 * MINUTE_MS);
    const inputs = statusInputs(box, { lastSeen: { kind: 'unreadable', reason: 'last-seen.json cannot be read (boom)' } });
    const { agents, problems } = await evaluateWireAgentStatuses(inputs);
    expect(agents.find((agent) => agent.agentId === 'codex')?.state).toBe('unknown');
    expect(problems).toContain('last-seen.json cannot be read (boom)');
  });

  it('an agent whose descriptor is gone is unknown', async () => {
    const box = codexSandbox('gone-descriptor');
    await connectInSandbox(box, 'codex');
    updateAppliedRecords(box.wiringDirectory, (agents) => {
      agents['my-agent'] = { ...agents.codex, routeIds: [] };
    });
    expect((await statusOf(box, 'my-agent'))?.state).toBe('unknown');
  });

  it('an unreadable applied.json is a problem and leaves routed agents unknown', async () => {
    const box = codexSandbox('bad-applied');
    await connectInSandbox(box, 'codex');
    writeFileSync(join(box.wiringDirectory, 'applied.json'), '{not json');
    const { agents, problems } = await evaluateWireAgentStatuses(statusInputs(box));
    expect(problems.join('\n')).toContain('applied.json cannot be read');
    expect(agents.find((agent) => agent.agentId === 'codex')?.state).toBe('unknown');
  });

  it('cached-only probes read unknown until their answer lands, then answer', async () => {
    const box = codexSandbox('cached-only');
    await connectInSandbox(box, 'codex');
    const cache = new ProbeAnswerCache();
    const inputs = { lookupProbe: probeLookupFor(cache, 'cached-only') };
    const first = await statusOf(box, 'codex', inputs);
    expect(first?.state).toBe('unknown');
    await Bun.sleep(10);
    expect((await statusOf(box, 'codex', inputs))?.state).toBe('ok');
  });
});

describe('probe answer cache', () => {
  it('reuses a fresh answer, asks again after 20 s, and runs one probe at a time per key', async () => {
    let clock = 0;
    let calls = 0;
    const cache = new ProbeAnswerCache({ now: () => clock });
    const probe = async () => {
      calls++;
      return calls;
    };
    expect(cache.cached('k', probe)).toEqual({ known: false });
    expect(cache.cached('k', probe)).toEqual({ known: false });
    await Bun.sleep(1);
    expect(calls).toBe(1);
    expect(cache.cached('k', probe)).toEqual({ known: true, value: 1 });
    expect(await cache.fresh('k', probe)).toBe(1);
    clock += 20_001;
    expect(await cache.fresh('k', probe)).toBe(2);
  });
});

describe('last seen', () => {
  it('persists, carries over into the next gateway, and refuses to read a bad file as empty', () => {
    const box = sandbox('last-seen');
    const filePath = join(box.root, 'state', 'last-seen.json');
    let clock = 1_000;
    const tracker = new AgentLastSeenTracker({ filePath, now: () => clock });
    tracker.noteRequestFromAgent('codex');
    tracker.flush();
    expect(readLastSeenFile(filePath)).toEqual({ kind: 'read', lastSeenByAgent: { codex: 1_000 } });

    clock = 500;
    const next = new AgentLastSeenTracker({ filePath, now: () => clock });
    next.noteRequestFromAgent('gemini-cli');
    next.startPersisting(60_000);
    next.stopPersisting();
    expect(next.snapshot()).toEqual({ codex: 1_000, 'gemini-cli': 500 });

    writeFileSync(filePath, '{oops');
    expect(readLastSeenFile(filePath).kind).toBe('unreadable');
    expect(readLastSeenFile(join(box.root, 'absent.json'))).toEqual({ kind: 'read', lastSeenByAgent: {} });
  });
});

describe('identity probes against real sockets', () => {
  it('answers true only for this gateway, over a plain socket', async () => {
    const gateway = await startWireGatewayForTest();
    cleanups.push(() => gateway.stop());
    const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ name: 'someone-else' }) });
    cleanups.push(() => other.stop(true));
    const chunked = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"name":"claude-mem-'));
          controller.enqueue(new TextEncoder().encode('wire-gateway"}'));
          controller.close();
        },
      }), { headers: { 'content-type': 'application/json' } }),
    });
    cleanups.push(() => chunked.stop(true));
    expect(await probeIdentityDirectly(gateway.baseUrl)).toBe(true);
    expect(await probeIdentityDirectly(`http://127.0.0.1:${other.port}`)).toBe(false);
    expect(await probeIdentityDirectly(`http://127.0.0.1:${chunked.port}`)).toBe(true);
    const closedPort = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const closedUrl = `http://127.0.0.1:${closedPort.port}`;
    closedPort.stop(true);
    expect(await probeIdentityDirectly(closedUrl)).toBe(false);
  });

  it('through a proxy: true when it forwards to the gateway, false when it answers 502', async () => {
    const gateway = await startWireGatewayForTest();
    cleanups.push(() => gateway.stop());
    const forwardingProxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => fetch(request.url, { headers: { accept: 'application/json' } }) });
    cleanups.push(() => forwardingProxy.stop(true));
    const brokenProxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('Bad Gateway', { status: 502 }) });
    cleanups.push(() => brokenProxy.stop(true));
    expect(await probeIdentityThroughProxy(gateway.baseUrl, `http://127.0.0.1:${forwardingProxy.port}`)).toBe(true);
    expect(await probeIdentityThroughProxy(gateway.baseUrl, `socks5://127.0.0.1:${brokenProxy.port}`)).toBe(false);
  });
});

describe('probe bodies are read within a byte cap', () => {
  function endlessBody(onCancel: () => void): ReadableStream<Uint8Array> {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    return new ReadableStream({ pull: (controller) => controller.enqueue(chunk), cancel: onCancel });
  }

  it('cancels an endless body past the cap, refuses a declared oversize body, and reads a small one', async () => {
    let cancelled = false;
    expect(await readResponseTextWithinLimit(new Response(endlessBody(() => { cancelled = true; })), 1024 * 1024)).toBeNull();
    expect(cancelled).toBe(true);
    const declaredLarge = new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } });
    expect(await readResponseTextWithinLimit(declaredLarge, 64 * 1024)).toBeNull();
    expect(await readResponseTextWithinLimit(new Response('{"name":"x"}'), 64 * 1024)).toBe('{"name":"x"}');
  });

  it('a proxy that answers with an endless body is not us, and is dropped at the cap, not at the timeout', async () => {
    // Paced, so the server's own loop does not starve the client in this process.
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    let chunksServed = 0;
    const endlessProxy = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(new ReadableStream({
        async pull(controller) {
          await Bun.sleep(1);
          chunksServed++;
          controller.enqueue(chunk);
        },
      }), { headers: { 'content-type': 'application/json' } }),
    });
    cleanups.push(() => endlessProxy.stop(true));
    const startedAt = Date.now();
    expect(await probeIdentityThroughProxy('http://127.0.0.1:9', `http://127.0.0.1:${endlessProxy.port}`, 10_000)).toBe(false);
    expect(chunksServed).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

describe('wire status asks the running gateway where it listens', () => {
  it('uses the running instance\'s saved host and port, the configured ones only when none runs', () => {
    const configured = { host: '127.0.0.1', port: 37778 };
    expect(wireStatusGatewayOrigin(configured, { host: '::1', port: 41000 })).toBe('http://[::1]:41000');
    expect(wireStatusGatewayOrigin(configured, { host: '127.0.0.1', port: 41001 })).toBe('http://127.0.0.1:41001');
    expect(wireStatusGatewayOrigin(configured, null)).toBe('http://127.0.0.1:37778');
  });
});

describe('loopback requests never take HTTP_PROXY', () => {
  // Bun reads HTTP_PROXY at launch and sends even loopback fetches through
  // it, so this runs the CLI-side requests in a child Bun started with
  // HTTP_PROXY pointing at a proxy that answers 502 to everything.
  it('connect\'s route probe, the start probe, wire status and wire run\'s launch all reach the gateway', async () => {
    const box = sandbox('behind-proxy');
    const gateway = await startWireGatewayForTest({
      routesFilePath: box.routesFilePath,
      status: { wiringDirectory: box.wiringDirectory, agentEnvironment: box.environment, readSystemProxy: async () => null },
    });
    cleanups.push(() => gateway.stop());
    const refusingProxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('Bad Gateway', { status: 502 }) });
    cleanups.push(() => refusingProxy.stop(true));
    const proxyUrl = `http://127.0.0.1:${refusingProxy.port}`;
    const sourceDirectory = join(import.meta.dir, '../../src/services/wire-gateway');
    const child = Bun.spawn([process.execPath, '-e', `
      const { probeRouteIdentity, createLaunch } = await import(${JSON.stringify(join(sourceDirectory, 'wiring/wire-agent-cli.ts'))});
      const { probeWireGatewayIdentity, fetchRunningWireGatewayStatus } = await import(${JSON.stringify(join(sourceDirectory, 'WireGatewayService.ts'))});
      const baseUrl = ${JSON.stringify(gateway.baseUrl)};
      const plainFetchStatus = await fetch(baseUrl + '/').then((response) => response.status, () => 'error');
      const answers = {
        plainFetchStatus,
        routeProbe: await probeRouteIdentity(baseUrl),
        startProbe: await probeWireGatewayIdentity('127.0.0.1', ${gateway.port}),
        statusReportRunning: (await fetchRunningWireGatewayStatus(baseUrl))?.gateway.running ?? null,
        launchId: await createLaunch(baseUrl, 'aider', '/Users/me/launched').then((id) => typeof id, (error) => String(error)),
      };
      process.stdout.write(JSON.stringify(answers));
    `], {
      env: { ...process.env, HOME: box.home, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: '', no_proxy: '' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    const answers = JSON.parse(stdout) as Record<string, unknown>;
    // The proxy really is in the way of a plain fetch...
    expect(answers.plainFetchStatus).toBe(502);
    // ...and none of these go through it.
    expect(answers).toMatchObject({ routeProbe: true, startProbe: { version: expect.any(String) }, statusReportRunning: true, launchId: 'string' });
  });
});

describe('the running gateway: GET /wire/status and lastSeen', () => {
  let upstream: FakeUpstream;
  let gateway: StartedWireGateway;

  it('updates lastSeen on every routed request and reports each agent', async () => {
    const box = sandbox('live');
    upstream = await startFakeUpstream({ kind: 'json', body: { id: 'resp_1', output: [] } });
    cleanups.push(() => upstream.stop());
    box.write('.codex/config.toml', `model = "gpt-5"\nopenai_base_url = "${upstream.url}/v1"\n`);
    const lastSeenFilePath = join(box.root, 'state', 'last-seen.json');
    gateway = await startWireGatewayForTest({
      routesFilePath: box.routesFilePath,
      routesReloadCheckIntervalMs: 10,
      status: {
        lastSeenFilePath,
        wiringDirectory: box.wiringDirectory,
        agentEnvironment: box.environment,
        readSystemProxy: async () => null,
      },
    });
    cleanups.push(() => gateway.stop());
    await connectAgent(descriptor('codex'), { ...box.options(recordingSideEffects()), gatewayOrigin: gateway.baseUrl });

    const read = async () => (await (await fetch(`${gateway.baseUrl}/wire/status`)).json()) as { gateway: { running: boolean }; capture: { unattributedEventCount: number } | null; agents: WireAgentStatus[] };
    const first = await read();
    expect(first.gateway.running).toBe(true);
    expect(first.capture).toEqual({ unattributedEventCount: 0 });
    // Probes run in the background: the first answer may still be unknown.
    expect(['unknown', 'ok']).toContain(first.agents[0].state);
    expect(first.agents[0].lastSeenAt).toBeNull();

    await Bun.sleep(50);
    const relayed = await fetch(`${gateway.baseUrl}/r/codex/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"gpt-5","input":"hi"}' });
    expect(relayed.status).toBe(200);
    await relayed.text();
    let report = await read();
    for (let attempt = 0; attempt < 50 && report.agents[0].state === 'unknown'; attempt++) {
      await Bun.sleep(20);
      report = await read();
    }
    expect(report.agents[0].state).toBe('ok');
    expect(report.agents[0].lastSeenAt).not.toBeNull();
    expect((await fetch(`${gateway.baseUrl}/wire/status`, { method: 'POST' })).status).toBe(405);

    await gateway.stop();
    cleanups.pop();
    const persisted = readLastSeenFile(lastSeenFilePath);
    expect(persisted.kind === 'read' && typeof persisted.lastSeenByAgent.codex).toBe('number');
  });
});

describe('CLI table', () => {
  it('lists each agent with its state, fix and notes', () => {
    const lines = formatWireStatusReport({
      generatedAt: '2026-10-15T00:00:00.000Z',
      gateway: { origin: 'http://127.0.0.1:37677', running: true, version: '13.39.0', startedAt: '2026-10-15T00:00:00.000Z' },
      capture: { unattributedEventCount: 2 },
      problems: [],
      agents: [{
        agentId: 'codex', name: 'Codex', state: 'bypassed', detail: 'Codex was used at 10:00, but …', fix: 'quit and reopen Codex',
        captureSource: 'wire', routeIds: ['codex'], connectedAt: null, lastSeenAt: null, lastUsedAt: null, notes: ['a note'],
      }],
    });
    expect(lines[0]).toContain('Wire gateway is running at http://127.0.0.1:37677');
    expect(lines).toContain('  Captured events with no known folder: 2');
    expect(lines.some((line) => /^codex\s+bypassed\s+Codex was used/.test(line))).toBe(true);
    expect(lines.some((line) => line.trim() === 'fix: quit and reopen Codex')).toBe(true);
    expect(lines.some((line) => line.trim() === 'note: a note')).toBe(true);
    expect(formatWireStatusReport({ generatedAt: '', gateway: { origin: 'x', running: false }, capture: null, problems: [], agents: [] }))
      .toEqual(['Wire gateway is not running (it would listen at x)', 'No agents are wired (claude-mem wire connect <agent>)']);
  });
});
