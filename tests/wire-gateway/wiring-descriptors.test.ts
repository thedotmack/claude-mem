import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { BUILT_IN_AGENT_DESCRIPTORS } from '../../src/services/wire-gateway/agents/builtin-agents.js';
import type { AgentDescriptor } from '../../src/services/wire-gateway/agents/types.js';
import { readWireGatewayRoutesFile } from '../../src/services/wire-gateway/routes.js';
import { connectAgent, disconnectAgent } from '../../src/services/wire-gateway/wiring/wiring-engine.js';
import { readAppliedRecords, readStash } from '../../src/services/wire-gateway/wiring/wiring-records.js';
import { TEST_GATEWAY_ORIGIN, WiringSandbox, recordingSideEffects } from './helpers/wiring-sandbox.js';

const sandboxes: WiringSandbox[] = [];
afterEach(() => {
  while (sandboxes.length) sandboxes.pop()!.remove();
});

function sandbox(label: string, env: Record<string, string | undefined> = {}): WiringSandbox {
  const created = new WiringSandbox(label, env);
  sandboxes.push(created);
  return created;
}

function descriptor(id: string): AgentDescriptor {
  const found = BUILT_IN_AGENT_DESCRIPTORS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no descriptor ${id}`);
  return found;
}

/** Every file under the fake home, as bytes, keyed by relative path. */
function snapshotHome(home: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(home, path), readFileSync(path).toString('base64'));
    }
  };
  walk(home);
  return files;
}

interface RoundTripCase {
  agentId: string;
  files: Record<string, string>;
  env?: Record<string, string>;
  /** relative file → substrings the connected file must hold */
  expectAfterConnect: Record<string, string[]>;
  expectRoutes: Record<string, string>;
  captureSource?: 'wire' | 'native';
  helpers?: { readAgentVersion: (executable: string) => string | null };
}

const ROUND_TRIP_CASES: RoundTripCase[] = [
  {
    agentId: 'claude-code',
    files: {
      '.claude/settings.json': '{\n  // my settings\n  "model": "opus",\n  "env": {\n    "ANTHROPIC_API_KEY": "sk-ant-api03-test"\n  }\n}\n',
    },
    expectAfterConnect: {
      '.claude/settings.json': [`"ANTHROPIC_BASE_URL": "${TEST_GATEWAY_ORIGIN}/r/claude-code"`, '"CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1"', '// my settings'],
    },
    expectRoutes: { 'claude-code': 'https://api.anthropic.com' },
    captureSource: 'native',
  },
  {
    agentId: 'codex',
    files: { '.codex/config.toml': '# my codex\nmodel = "gpt-5"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n' },
    expectAfterConnect: { '.codex/config.toml': [`openai_base_url = "${TEST_GATEWAY_ORIGIN}/r/codex/v1"`, '# my codex', '[profiles.fast]'] },
    expectRoutes: { codex: 'https://api.openai.com' },
  },
  {
    agentId: 'codex',
    files: {
      '.codex/config.toml': 'model_provider = "azure"\r\n\r\n[model_providers.azure]\r\nname = "Azure"\r\nbase_url = \'https://example.openai.azure.com/openai\'\r\nwire_api = "responses"\r\n',
    },
    expectAfterConnect: { '.codex/config.toml': [`base_url = "${TEST_GATEWAY_ORIGIN}/r/codex-azure/openai"\r\n`] },
    expectRoutes: { 'codex-azure': 'https://example.openai.azure.com' },
  },
  {
    agentId: 'gemini-cli',
    files: {
      '.gemini/settings.json': '{"security":{"auth":{"selectedType":"gemini-api-key"}}}',
      '.gemini/.env': 'GEMINI_API_KEY=abc123\n',
    },
    expectAfterConnect: { '.gemini/.env': ['GEMINI_API_KEY=abc123', `GOOGLE_GEMINI_BASE_URL=${TEST_GATEWAY_ORIGIN}/r/gemini-cli`] },
    expectRoutes: { 'gemini-cli': 'https://generativelanguage.googleapis.com' },
  },
  {
    agentId: 'gemini-cli',
    // No .env yet: connect creates it, disconnect removes it again.
    files: { '.gemini/settings.json': '{"security":{"auth":{"selectedType":"gemini-api-key"}}}\n' },
    expectAfterConnect: { '.gemini/.env': [`GOOGLE_GEMINI_BASE_URL=${TEST_GATEWAY_ORIGIN}/r/gemini-cli`] },
    expectRoutes: { 'gemini-cli': 'https://generativelanguage.googleapis.com' },
  },
  {
    agentId: 'opencode',
    files: {
      '.config/opencode/opencode.jsonc': [
        '{',
        '  "$schema": "https://opencode.ai/config.json",',
        '  "provider": {',
        '    "anthropic": {},',
        '    "openrouter": {',
        '      "npm": "@ai-sdk/openai-compatible",',
        '      "options": { "baseURL": "https://openrouter.ai/api/v1", "apiKey": "{env:OPENROUTER_API_KEY}" }, // mine',
        '    },',
        '    "local": { "npm": "@ai-sdk/openai-compatible" },',
        '  },',
        '}',
        '',
      ].join('\n'),
    },
    expectAfterConnect: {
      '.config/opencode/opencode.jsonc': [`${TEST_GATEWAY_ORIGIN}/r/opencode-anthropic/v1`, `${TEST_GATEWAY_ORIGIN}/r/opencode-openrouter/api/v1`, '// mine'],
    },
    expectRoutes: { 'opencode-anthropic': 'https://api.anthropic.com', 'opencode-openrouter': 'https://openrouter.ai' },
  },
  {
    agentId: 'crush',
    files: { '.config/crush/crush.json': '{\n  "providers": {\n    "deepseek": {\n      "type": "openai",\n      "base_url": "https://api.deepseek.com/v1"\n    }\n  }\n}\n' },
    expectAfterConnect: { '.config/crush/crush.json': [`"base_url": "${TEST_GATEWAY_ORIGIN}/r/crush-deepseek/v1"`] },
    expectRoutes: { 'crush-deepseek': 'https://api.deepseek.com' },
  },
  {
    agentId: 'pi',
    files: { '.pi/agent/models.json': '{\n  "providers": {\n    "groq": {\n      "baseUrl": "https://api.groq.com/openai/v1",\n      "api": "openai-completions"\n    }\n  }\n}\n' },
    expectAfterConnect: { '.pi/agent/models.json': [`"baseUrl": "${TEST_GATEWAY_ORIGIN}/r/pi-groq/openai/v1"`, '"sendSessionAffinityHeaders": true'] },
    expectRoutes: { 'pi-groq': 'https://api.groq.com' },
  },
  {
    agentId: 'omp',
    files: { '.omp/agent/models.yml': '# omp models\nproviders:\n  fireworks:\n    baseUrl: https://api.fireworks.ai/inference/v1 # theirs\n    api: openai-completions\n' },
    helpers: { readAgentVersion: () => 'omp 16.2.1\n' },
    expectAfterConnect: { '.omp/agent/models.yml': [`baseUrl: ${TEST_GATEWAY_ORIGIN}/r/omp-fireworks/inference/v1`, 'promptCacheSessionHeader: x-session-affinity', '# omp models'] },
    expectRoutes: { 'omp-fireworks': 'https://api.fireworks.ai' },
  },
  {
    agentId: 'cline',
    files: { '.cline/data/settings/providers.json': '{"providers":{"openai-compatible":{"settings":{"provider":"openai-compatible","baseUrl":"https://api.together.xyz/v1","model":"m"}}}}' },
    expectAfterConnect: { '.cline/data/settings/providers.json': [`"baseUrl":"${TEST_GATEWAY_ORIGIN}/r/cline/v1"`, '"User-Agent"'] },
    expectRoutes: { cline: 'https://api.together.xyz' },
  },
  {
    agentId: 'qwen',
    files: { '.qwen/settings.json': '{\n  "security": {\n    "auth": {\n      "selectedType": "openai",\n      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1"\n    }\n  }\n}\n' },
    expectAfterConnect: { '.qwen/settings.json': [`"baseUrl": "${TEST_GATEWAY_ORIGIN}/r/qwen/compatible-mode/v1"`] },
    expectRoutes: { qwen: 'https://dashscope.aliyuncs.com' },
  },
  {
    agentId: 'kimi',
    files: { '.kimi-code/config.toml': 'default_model = "kimi-k2"\n\n[providers.moonshot]\ntype = "kimi"\nbase_url = "https://api.moonshot.ai/v1"\n' },
    expectAfterConnect: { '.kimi-code/config.toml': [`base_url = "${TEST_GATEWAY_ORIGIN}/r/kimi-moonshot/v1"`] },
    expectRoutes: { 'kimi-moonshot': 'https://api.moonshot.ai' },
  },
  {
    agentId: 'zed',
    files: { '.config/zed/settings.json': '// Zed settings\n{\n  "language_models": {\n    "openai_compatible": {\n      "Together AI": { "api_url": "https://api.together.xyz/v1" }\n    }\n  }\n}\n' },
    expectAfterConnect: { '.config/zed/settings.json': [`"api_url": "${TEST_GATEWAY_ORIGIN}/r/zed-together-ai/v1"`, '// Zed settings'] },
    expectRoutes: { 'zed-together-ai': 'https://api.together.xyz' },
  },
  {
    agentId: 'hermes',
    files: { '.hermes/config.yaml': 'model:\n  provider: local\nproviders:\n  local:\n    base_url: "http://localhost:8000/v1"\n    api_mode: chat_completions\n' },
    expectAfterConnect: { '.hermes/config.yaml': [`base_url: ${TEST_GATEWAY_ORIGIN}/r/hermes-local/v1`, 'User-Agent: hermes-agent'] },
    expectRoutes: { 'hermes-local': 'http://localhost:8000' },
  },
  {
    agentId: 'aider',
    files: { '.aider.conf.yml': '## aider\nmodel: gpt-5\ndark-mode: true\n' },
    expectAfterConnect: { '.aider.conf.yml': [`openai-api-base: ${TEST_GATEWAY_ORIGIN}/r/aider/v1`, '## aider'] },
    expectRoutes: { aider: 'https://api.openai.com' },
  },
];

describe('wire connect → disconnect round trips (every config descriptor)', () => {
  for (const testCase of ROUND_TRIP_CASES) {
    it(`${testCase.agentId}: ${Object.keys(testCase.files).join(', ')} come back byte for byte`, async () => {
      const box = sandbox(testCase.agentId, testCase.env);
      for (const [path, text] of Object.entries(testCase.files)) box.write(path, text);
      const before = snapshotHome(box.home);
      const sideEffects = recordingSideEffects();

      const connected = await connectAgent(descriptor(testCase.agentId), box.options(sideEffects, testCase.helpers ?? { readAgentVersion: () => null }));
      expect(connected.alreadyConnected).toBe(false);
      expect(connected.plan.captureSource).toBe(testCase.captureSource ?? 'wire');
      for (const [path, substrings] of Object.entries(testCase.expectAfterConnect)) {
        const text = box.read(path);
        for (const substring of substrings) expect(text).toContain(substring);
      }
      const routes = readWireGatewayRoutesFile(box.routesFilePath).routes;
      expect(Object.fromEntries(Object.entries(routes).map(([routeId, route]) => [routeId, route.upstreamBaseUrl]))).toEqual(testCase.expectRoutes);
      for (const route of Object.values(routes)) expect(route.agentId).toBe(testCase.agentId);
      expect(sideEffects.calls).toContain('ensureGatewayRunning');
      expect(sideEffects.calls).toContain('installOsService');
      for (const routeId of Object.keys(testCase.expectRoutes)) expect(sideEffects.calls).toContain(`probe ${TEST_GATEWAY_ORIGIN}/r/${routeId}/`);

      const disconnected = await disconnectAgent(testCase.agentId, box.options(sideEffects));
      expect(disconnected.wasConnected).toBe(true);
      expect(disconnected.fields.every((field) => field.outcome === 'restored')).toBe(true);
      expect(snapshotHome(box.home)).toEqual(before);
      expect(readWireGatewayRoutesFile(box.routesFilePath).routes).toEqual({});
      expect(readAppliedRecords(box.wiringDirectory)).toEqual({});
      const stash = readStash(box.wiringDirectory);
      expect(stash.kind === 'read' && stash.agents).toEqual({});
      expect(disconnected.lastRouteRemoved).toBe(true);
      expect(sideEffects.calls.slice(-2)).toEqual(['stopGateway', 'uninstallOsService']);
    });
  }

  it('every built-in config descriptor has a round-trip case', () => {
    const configAgents = BUILT_IN_AGENT_DESCRIPTORS.filter((agent) => agent.files.length > 0).map((agent) => agent.id);
    const covered = new Set(ROUND_TRIP_CASES.map((testCase) => testCase.agentId));
    expect(configAgents.filter((id) => !covered.has(id))).toEqual([]);
  });
});

describe('disconnect after the user edited the file', () => {
  it('resets our fields, keeps the user\'s edit, and removes the parents connect made (field by field)', async () => {
    const box = sandbox('pi-edited');
    const original = '{\n  "providers": {\n    "groq": {\n      "baseUrl": "https://api.groq.com/openai/v1",\n      "api": "openai-completions"\n    }\n  }\n}\n';
    box.write('.pi/agent/models.json', original);
    await connectAgent(descriptor('pi'), box.options());
    const connected = box.read('.pi/agent/models.json')!;
    expect(connected).toContain('"compat"');
    box.write('.pi/agent/models.json', connected.replace('"api": "openai-completions"', '"api": "openai-responses"'));

    const result = await disconnectAgent('pi', box.options());
    expect(result.fields.map((field) => field.outcome)).toEqual(['restored', 'restored']);
    expect(box.read('.pi/agent/models.json')).toBe(original.replace('"api": "openai-completions"', '"api": "openai-responses"'));
  });

  it('reports a base URL the user changed as replaced and leaves it alone', async () => {
    const box = sandbox('claude-replaced');
    box.write('.claude/settings.json', '{\n  "env": {\n    "ANTHROPIC_API_KEY": "sk-ant-api03-x"\n  }\n}\n');
    await connectAgent(descriptor('claude-code'), box.options());
    const connected = box.read('.claude/settings.json')!;
    box.write('.claude/settings.json', connected.replace(`${TEST_GATEWAY_ORIGIN}/r/claude-code`, 'https://my-proxy.example.com'));

    const result = await disconnectAgent('claude-code', box.options());
    const replaced = result.fields.find((field) => field.keyPath === 'env.ANTHROPIC_BASE_URL')!;
    expect(replaced.outcome).toBe('replaced');
    expect(replaced.currentValue).toBe('https://my-proxy.example.com');
    expect(result.fields.find((field) => field.keyPath === 'env.CLAUDE_CODE_GATEWAY_HINT_HEADERS')!.outcome).toBe('restored');
    const after = box.read('.claude/settings.json')!;
    expect(after).toContain('"ANTHROPIC_BASE_URL": "https://my-proxy.example.com"');
    expect(after).not.toContain('CLAUDE_CODE_GATEWAY_HINT_HEADERS');
  });

  it('restores a TOML key field by field and keeps a note the user added', async () => {
    const box = sandbox('codex-table');
    const original = 'model_provider = "proxy"\n\n[model_providers.proxy]\nname = "Proxy"\nbase_url = "https://proxy.example.com/v1"\n';
    box.write('.codex/config.toml', original);
    await connectAgent(descriptor('codex'), box.options());
    box.write('.codex/config.toml', `${box.read('.codex/config.toml')}\n# user note\n`);
    await disconnectAgent('codex', box.options());
    expect(box.read('.codex/config.toml')).toBe(`${original}\n# user note\n`);
  });
});

describe('subscription sign-ins are refused and nothing is changed (D4)', () => {
  const refusalCases: Array<{ agentId: string; files: Record<string, string>; env?: Record<string, string>; message: RegExp }> = [
    {
      agentId: 'codex',
      files: { '.codex/config.toml': 'model = "gpt-5"\n', '.codex/auth.json': '{"auth_mode":"chatgpt","tokens":{"access_token":"eyJabc","refresh_token":"r"}}' },
      message: /signed in with ChatGPT.*native integration for Codex/s,
    },
    {
      agentId: 'gemini-cli',
      files: { '.gemini/settings.json': '{"security":{"auth":{"selectedType":"oauth-personal"}}}' },
      message: /oauth-personal.*never forwards subscription sign-ins/s,
    },
    {
      agentId: 'claude-code',
      files: { '.claude/settings.json': '{"model":"opus"}' },
      message: /no API key.*claude\.ai/s,
    },
    {
      agentId: 'claude-code',
      files: { '.claude/settings.json': '{"env":{"ANTHROPIC_AUTH_TOKEN":"sk-ant-oat01-abc"}}' },
      message: /sk-ant-oat/,
    },
    {
      agentId: 'claude-code',
      files: { '.claude/settings.json': '{"env":{"ANTHROPIC_API_KEY":"sk-ant-api03-x"}}' },
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-y' },
      message: /CLAUDE_CODE_OAUTH_TOKEN/,
    },
    {
      agentId: 'opencode',
      files: {
        '.config/opencode/opencode.json': '{"provider":{"anthropic":{}}}',
        '.local/share/opencode/auth.json': '{"anthropic":{"type":"oauth","refresh":"r","access":"a","expires":1}}',
      },
      message: /"anthropic" is signed in with OAuth/,
    },
    {
      agentId: 'qwen',
      files: { '.qwen/settings.json': '{"security":{"auth":{"selectedType":"qwen-oauth","baseUrl":"https://x.example.com/v1"}}}' },
      message: /Qwen OAuth/,
    },
  ];
  for (const refusal of refusalCases) {
    it(`${refusal.agentId}: ${refusal.message}`, async () => {
      const box = sandbox(`refuse-${refusal.agentId}`, refusal.env);
      for (const [path, text] of Object.entries(refusal.files)) box.write(path, text);
      const before = snapshotHome(box.home);
      const sideEffects = recordingSideEffects();
      await expect(connectAgent(descriptor(refusal.agentId), box.options(sideEffects))).rejects.toThrow(refusal.message);
      expect(snapshotHome(box.home)).toEqual(before);
      expect(existsSync(box.routesFilePath)).toBe(false);
      expect(sideEffects.calls).toEqual([]);
    });
  }
});

describe('capture source (D6)', () => {
  it('a Pi with the claude-mem extension is wired native', async () => {
    const box = sandbox('pi-native');
    box.write('.pi/agent/models.json', '{"providers":{"x":{"baseUrl":"https://x.example.com/v1"}}}');
    box.write('.pi/agent/extensions/claude-mem/index.js', '// claude-mem');
    const result = await connectAgent(descriptor('pi'), box.options());
    expect(result.plan.captureSource).toBe('native');
    expect(readWireGatewayRoutesFile(box.routesFilePath).routes['pi-x'].captureSource).toBe('native');
  });

  it('--capture wire with the Codex plugin installed fails fast and names the uninstall', async () => {
    const box = sandbox('codex-native');
    box.write('.codex/config.toml', 'model = "gpt-5"\n\n[plugins."claude-mem@claude-mem-local"]\nenabled = true\n');
    const before = snapshotHome(box.home);
    await expect(connectAgent(descriptor('codex'), box.options(), { captureSource: 'wire' })).rejects.toThrow(/npx claude-mem uninstall/);
    expect(snapshotHome(box.home)).toEqual(before);
    const native = await connectAgent(descriptor('codex'), box.options());
    expect(native.plan.captureSource).toBe('native');
  });

  it('Claude Code is always native and refuses --capture wire', async () => {
    const box = sandbox('claude-wire');
    box.write('.claude/settings.json', '{"env":{"ANTHROPIC_API_KEY":"sk-ant-api03-x"}}');
    await expect(connectAgent(descriptor('claude-code'), box.options(), { captureSource: 'wire' })).rejects.toThrow(/always captured by its claude-mem hooks/);
  });
});

describe('connect fails fast', () => {
  it('when the agent is not installed', async () => {
    const box = sandbox('absent');
    await expect(connectAgent(descriptor('crush'), box.options())).rejects.toThrow(/Crush was not found/);
  });

  it('when a key already points at the gateway without a record', async () => {
    const box = sandbox('loop');
    box.write('.config/crush/crush.json', `{"providers":{"x":{"base_url":"${TEST_GATEWAY_ORIGIN}/r/crush-x"}}}`);
    await expect(connectAgent(descriptor('crush'), box.options())).rejects.toThrow(/already points at the wire gateway/);
  });

  it('when a Codex config holds a TOML datetime Bun cannot parse, with what to do', async () => {
    const box = sandbox('datetime');
    box.write('.codex/config.toml', 'model = "gpt-5"\n[projects."/x"]\ntrusted_at = 1979-05-27T07:32:00Z\n');
    await expect(connectAgent(descriptor('codex'), box.options())).rejects.toThrow(/line 3 holds a TOML date or time.*Quote that value/s);
  });

  it('when the gateway does not answer through the new URL: the connect is undone', async () => {
    const box = sandbox('probe-fails');
    box.write('.config/crush/crush.json', '{"providers":{"x":{"base_url":"https://x.example.com/v1"}}}\n');
    const before = snapshotHome(box.home);
    await expect(connectAgent(descriptor('crush'), box.options(recordingSideEffects({ probeAnswers: false })))).rejects.toThrow(/Its config is back as it was/);
    expect(snapshotHome(box.home)).toEqual(before);
    expect(readWireGatewayRoutesFile(box.routesFilePath).routes).toEqual({});
    expect(readAppliedRecords(box.wiringDirectory)).toEqual({});
  });

  it('when a route id belongs to another agent', async () => {
    const box = sandbox('route-clash');
    box.write('.config/crush/crush.json', '{"providers":{"x":{"base_url":"https://x.example.com/v1"}}}\n');
    const { addWireGatewayRoute } = await import('../../src/services/wire-gateway/routes.js');
    addWireGatewayRoute({ routeId: 'crush-x', agentId: 'someone-else', upstreamBaseUrl: 'https://y.example.com' }, box.routesFilePath);
    await expect(connectAgent(descriptor('crush'), box.options())).rejects.toThrow(/belongs to agent someone-else/);
  });
});

describe('connect and disconnect bookkeeping', () => {
  it('a second connect is a no-op; a failed service install is reported, not fatal', async () => {
    const box = sandbox('again');
    box.write('.config/crush/crush.json', '{"providers":{"x":{"base_url":"https://x.example.com/v1"}}}\n');
    const sideEffects = recordingSideEffects({ installThrows: true });
    const first = await connectAgent(descriptor('crush'), box.options(sideEffects));
    expect(first.messages.join('\n')).toMatch(/Could not install the login service/);
    const afterFirst = box.read('.config/crush/crush.json');
    const second = await connectAgent(descriptor('crush'), box.options(sideEffects));
    expect(second.alreadyConnected).toBe(true);
    expect(box.read('.config/crush/crush.json')).toBe(afterFirst);
  });

  it('keeps the daemon and service while another agent still has a route', async () => {
    const box = sandbox('two-agents');
    box.write('.config/crush/crush.json', '{"providers":{"x":{"base_url":"https://x.example.com/v1"}}}\n');
    box.write('.aider.conf.yml', 'model: gpt-5\n');
    const sideEffects = recordingSideEffects();
    await connectAgent(descriptor('crush'), box.options(sideEffects));
    await connectAgent(descriptor('aider'), box.options(sideEffects));
    const first = await disconnectAgent('crush', box.options(sideEffects));
    expect(first.lastRouteRemoved).toBe(false);
    expect(sideEffects.calls).not.toContain('stopGateway');
    const last = await disconnectAgent('aider', box.options(sideEffects));
    expect(last.lastRouteRemoved).toBe(true);
    expect(sideEffects.calls).toContain('uninstallOsService');
  });

  it('disconnect of an agent never connected removes only its own routes', async () => {
    const box = sandbox('orphan-routes');
    const { addWireGatewayRoute } = await import('../../src/services/wire-gateway/routes.js');
    addWireGatewayRoute({ routeId: 'antigravity-cli', agentId: 'antigravity-cli', upstreamBaseUrl: 'https://generativelanguage.googleapis.com' }, box.routesFilePath);
    addWireGatewayRoute({ routeId: 'other', agentId: 'other', upstreamBaseUrl: 'https://o.example.com' }, box.routesFilePath);
    const result = await disconnectAgent('antigravity-cli', box.options());
    expect(result.wasConnected).toBe(false);
    expect(result.removedRouteIds).toEqual(['antigravity-cli']);
    expect(Object.keys(readWireGatewayRoutesFile(box.routesFilePath).routes)).toEqual(['other']);
  });

  it('a connect whose route was removed by hand says so instead of reporting it connected', async () => {
    const box = sandbox('route-removed');
    box.write('.config/crush/crush.json', '{"providers":{"x":{"base_url":"https://x.example.com/v1"}}}\n');
    await connectAgent(descriptor('crush'), box.options());
    const { removeWireGatewayRoute } = await import('../../src/services/wire-gateway/routes.js');
    removeWireGatewayRoute('crush-x', box.routesFilePath);
    await expect(connectAgent(descriptor('crush'), box.options())).rejects.toThrow(/route\(s\) crush-x, which were removed; run `claude-mem wire disconnect crush`/);
  });

  it('the preview sandbox refuses to write an agent file outside its folder', async () => {
    const box = sandbox('confined');
    box.write('.config/crush/crush.json', '{"providers":{"x":{"base_url":"https://x.example.com/v1"}}}\n');
    const before = snapshotHome(box.home);
    const options = { ...box.options(), confineAgentFileWritesTo: join(box.root, 'elsewhere') };
    await expect(connectAgent(descriptor('crush'), options)).rejects.toThrow(/outside the preview sandbox/);
    expect(snapshotHome(box.home)).toEqual(before);
    expect(readAppliedRecords(box.wiringDirectory)).toEqual({});
  });

  it('omp below 16.0.6 skips the session header and says so', async () => {
    const box = sandbox('omp-old');
    box.write('.omp/agent/models.yml', 'providers:\n  x:\n    baseUrl: https://x.example.com/v1\n');
    const result = await connectAgent(descriptor('omp'), box.options(recordingSideEffects(), { readAgentVersion: () => 'omp/15.9.0' }));
    expect(result.plan.identitySwitches).toEqual([]);
    expect(result.plan.notes.join('\n')).toMatch(/omp 15\.9\.0 is older than 16\.0\.6/);
    expect(box.read('.omp/agent/models.yml')).not.toContain('promptCacheSessionHeader');
  });
});
