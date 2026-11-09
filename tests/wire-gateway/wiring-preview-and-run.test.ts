import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DATA_DIR, WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { BUILT_IN_AGENT_DESCRIPTORS } from '../../src/services/wire-gateway/agents/builtin-agents.js';
import { builtInAgentNames } from '../../src/services/wire-gateway/agents/agent-registry.js';
import { expandUserDescriptorPath, loadUserAgentDescriptors } from '../../src/services/wire-gateway/agents/user-agents.js';
import { loadWireGatewayConfig } from '../../src/services/wire-gateway/config.js';
import type { AgentDescriptor } from '../../src/services/wire-gateway/agents/types.js';
import { readWireGatewayRoutesFile, removeWireGatewayRoute } from '../../src/services/wire-gateway/routes.js';
import { readConfigValue } from '../../src/services/wire-gateway/wiring/config-document.js';
import { diffConfigLines, formatConfigDiffLine, maskSecretLine } from '../../src/services/wire-gateway/wiring/config-diff.js';
import { prepareAgentLaunch, spawnAgentWithInheritedStdio } from '../../src/services/wire-gateway/wiring/launcher.js';
import { runWirePreview } from '../../src/services/wire-gateway/wiring/preview.js';
import { createLaunch, runWireAgentCli } from '../../src/services/wire-gateway/wiring/wire-agent-cli.js';
import { connectAgent, splitUpstreamForRoute } from '../../src/services/wire-gateway/wiring/wiring-engine.js';
import { startWireGatewayForTest } from './helpers/start-wire-gateway.js';
import { WiringSandbox } from './helpers/wiring-sandbox.js';

const IS_WINDOWS = process.platform === 'win32';
const ONE_MEGABYTE = 1024 * 1024;
const WIRE_GATEWAY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'services', 'wire-gateway', 'WireGatewayService.ts');

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
  return BUILT_IN_AGENT_DESCRIPTORS.find((candidate) => candidate.id === id)!;
}

describe('config diff (magpie preview.go diffLines)', () => {
  it('pairs a changed key as ~, masks secrets, and finishes fast over a 60k-line common middle', () => {
    const filler = Array.from({ length: 60_000 }, (_, index) => `k${index} = ${index}`).join('\n');
    const before = `model = "gpt-5"\nmodel_provider = "proxy"\napi_key = "sk-1"\n${filler}\n[model_providers.proxy]\nname = "proxy"\n`;
    const after = `model = "gpt-6"\nopenai_key = "sk-2"\n${filler}\n`;
    const started = performance.now();
    const lines = diffConfigLines(before, after).map(formatConfigDiffLine);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(lines).toEqual([
      '~ model = "gpt-6"   (was model = "gpt-5")',
      '+ openai_key = ••••',
      '- model_provider = "proxy"',
      '- api_key = ••••',
      '- [model_providers.proxy]',
      '- name = "proxy"',
    ]);
  });

  it('pairs only lines at the same indent, and says nothing for identical texts', () => {
    const before = '{\n  "a": {\n    "url": "x"\n  },\n  "url": "y"\n}\n';
    const after = '{\n  "a": {\n    "url": "z"\n  }\n}\n';
    expect(diffConfigLines(before, after)).toEqual([
      { op: '~', text: '    "url": "z"', was: '    "url": "x"' },
      { op: '-', text: '  "url": "y"' },
    ]);
    expect(diffConfigLines(before, before)).toEqual([]);
    expect(diffConfigLines('', 'x = 1\n}')).toEqual([{ op: '+', text: 'x = 1' }]);
  });

  it('falls back to an in-order match past 4,000 edits', () => {
    const removed = Array.from({ length: 7_000 }, (_, index) => `  "k${index}": ${index},`).join('\n');
    const before = `{\n  "model": "proxy/x",\n${removed}\n}\n`;
    const started = performance.now();
    const lines = diffConfigLines(before, '{\n}\n');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(lines.length).toBe(7_001);
    expect(lines[0]).toEqual({ op: '-', text: '  "model": "proxy/x",' });
  });

  it('masks secret-named values only', () => {
    expect(maskSecretLine('  "ANTHROPIC_API_KEY": "sk-ant-x",')).toBe('  "ANTHROPIC_API_KEY": ••••');
    expect(maskSecretLine('export OPENAI_API_KEY=sk-1')).toBe('export OPENAI_API_KEY= ••••');
    expect(maskSecretLine('api_key: sk-yaml')).toBe('api_key: ••••');
    expect(maskSecretLine('apiKey = "$OPENAI_API_KEY"')).toBe('apiKey = "$OPENAI_API_KEY"');
    expect(maskSecretLine('"auth": {')).toBe('"auth": {');
    expect(maskSecretLine('MAX_TOKENS = 4096')).toBe('MAX_TOKENS = 4096');
    expect(maskSecretLine('[auth]')).toBe('[auth]');
    expect(maskSecretLine('  ["a", "b"],')).toBe('  ["a", "b"],');
    expect(maskSecretLine('"baseURL": "http://127.0.0.1:1/r/x"')).toBe('"baseURL": "http://127.0.0.1:1/r/x"');
  });
});

describe('wire preview', () => {
  it('runs the real connect and disconnect in a sandbox copy and leaves the real files alone', async () => {
    const box = sandbox('preview', { PATH: process.env.PATH });
    const configPath = box.write('.config/crush/crush.json', '{\n  "providers": {\n    "deepseek": {\n      "base_url": "https://api.deepseek.com/v1",\n      "api_key": "sk-secret"\n    }\n  }\n}\n');
    const original = box.read('.config/crush/crush.json');
    // A binary file beside the config (Finder's .DS_Store) is not UTF-8; an unchanged one must not fail the preview.
    writeFileSync(join(dirname(configPath), '.DS_Store'), Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31, 0xff, 0xfe, 0x80]));
    const previewOptions = {
      descriptor: descriptor('crush'),
      environment: box.environment,
      dataDirectory: DATA_DIR,
      wireGatewayDirectory: WIRE_GATEWAY_DIR,
      bunPath: process.execPath,
      scriptPath: WIRE_GATEWAY_SCRIPT,
    };

    const connectPreview = runWirePreview({ ...previewOptions, disconnect: false });
    expect(connectPreview.changes.map((change) => change.displayPath)).toEqual(['~/.config/crush/crush.json']);
    const [line] = connectPreview.changes[0].lines;
    expect(line.op).toBe('~');
    expect(line.text).toMatch(/^ {6}"base_url": "http:\/\/127\.0\.0\.1:\d+\/r\/crush-deepseek\/v1",$/);
    expect(line.was).toBe('      "base_url": "https://api.deepseek.com/v1",');
    expect(box.read('.config/crush/crush.json')).toBe(original);
    expect(configPath.startsWith(box.home)).toBe(true);

    // Disconnect preview of an agent never connected: nothing would change.
    expect(runWirePreview({ ...previewOptions, disconnect: true }).changes).toEqual([]);
  }, 60_000);

  it('re-roots a user descriptor\'s own path variable, so the real file is never written', async () => {
    const box = sandbox('preview-user', { PATH: process.env.PATH });
    box.env.MY_AGENT_HOME = box.path('.my-agent');
    const wireGatewayDirectory = join(box.root, 'wire-gateway');
    const agentsDirectory = join(wireGatewayDirectory, 'agents');
    mkdirSync(agentsDirectory, { recursive: true });
    writeFileSync(join(agentsDirectory, 'my-agent.json'), JSON.stringify({
      id: 'my-agent',
      files: [{ key: 'config', path: '$MY_AGENT_HOME/config.json', format: 'json' }],
      targets: [{ file: 'config', keyPath: 'baseUrl', kind: 'baseUrl' }],
    }));
    const original = '{"baseUrl": "https://api.example.com/v1"}\n';
    box.write('.my-agent/config.json', original);
    const userDescriptor = loadUserAgentDescriptors(agentsDirectory, builtInAgentNames()).descriptors[0];
    expect(userDescriptor.pathVariables).toEqual(['MY_AGENT_HOME']);

    const result = runWirePreview({
      descriptor: userDescriptor,
      disconnect: false,
      environment: box.environment,
      dataDirectory: join(box.root, 'data'),
      wireGatewayDirectory,
      bunPath: process.execPath,
      scriptPath: WIRE_GATEWAY_SCRIPT,
    });
    expect(result.changes.map((change) => change.displayPath)).toEqual(['~/.my-agent/config.json']);
    expect(result.changes[0].lines[0].text).toContain('/r/my-agent/v1');
    expect(box.read('.my-agent/config.json')).toBe(original);
  }, 60_000);

  it('reports a connect that would fail', () => {
    const box = sandbox('preview-fail', { PATH: process.env.PATH });
    box.write('.gemini/settings.json', '{"security":{"auth":{"selectedType":"oauth-personal"}}}');
    expect(() => runWirePreview({
      descriptor: descriptor('gemini-cli'),
      disconnect: false,
      environment: box.environment,
      dataDirectory: DATA_DIR,
      wireGatewayDirectory: WIRE_GATEWAY_DIR,
      bunPath: process.execPath,
      scriptPath: WIRE_GATEWAY_SCRIPT,
    })).toThrow(/connect would fail:.*oauth-personal/s);
  }, 60_000);
});

describe('wire run', () => {
  it('starts a stub agent from PATH with its launch URL, the user\'s settings, no nesting markers, and no CLAUDE_MEM_INTERNAL', async () => {
    if (IS_WINDOWS) return;
    const box = sandbox('run');
    const binDirectory = join(box.root, 'bin');
    mkdirSync(binDirectory, { recursive: true });
    const stubPath = join(binDirectory, 'agy');
    writeFileSync(stubPath, '#!/bin/sh\nenv\n');
    chmodSync(stubPath, 0o755);
    box.env.PATH = `${binDirectory}:/usr/bin:/bin`;
    box.env.CLAUDE_MEM_INTERNAL = '1';
    box.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    box.env.KEEP_ME = 'yes';
    box.env.CLAUDE_CODE_EFFORT_LEVEL = 'high';

    const gateway = await startWireGatewayForTest({ routesFilePath: box.routesFilePath, routesReloadCheckIntervalMs: 0 });
    try {
      let ensured = 0;
      const prepared = await prepareAgentLaunch(descriptor('antigravity-cli'), ['--model', 'x'], {
        environment: box.environment,
        cwd: box.home,
        gatewayOrigin: gateway.baseUrl,
        routesFilePath: box.routesFilePath,
        ensureGatewayRunning: async () => { ensured++; },
        createLaunch: (agentId, cwd) => createLaunch(gateway.baseUrl, agentId, cwd),
        spawnAgent: async () => 0,
      }, 'wire');
      expect(ensured).toBe(1);
      expect(prepared.executablePath).toBe(stubPath);
      expect(prepared.args).toEqual(['--model', 'x']);

      const child = Bun.spawn({ cmd: [prepared.executablePath, ...prepared.args], env: prepared.env, stdout: 'pipe' });
      const printed = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(printed).toMatch(new RegExp(`^GOOGLE_GEMINI_BASE_URL=${gateway.baseUrl.replaceAll('.', '\\.')}/r/antigravity-cli/l/[a-z2-7]{26}$`, 'm'));
      expect(printed).toContain('KEEP_ME=yes');
      // The user's own agent setting is theirs; a normal launch would see it.
      expect(printed).toContain('CLAUDE_CODE_EFFORT_LEVEL=high');
      expect(printed).not.toContain('CLAUDE_MEM_INTERNAL');
      expect(printed).not.toContain('CLAUDE_CODE_ENTRYPOINT');
      expect(readWireGatewayRoutesFile(box.routesFilePath).routes['antigravity-cli'].upstreamBaseUrl).toBe('https://generativelanguage.googleapis.com');

      // The route root answers identity, as connect's probe expects.
      const identity = await fetch(`${gateway.baseUrl}/r/antigravity-cli/`).then((response) => response.json()) as { name: string };
      expect(identity.name).toBe('claude-mem-wire-gateway');
    } finally {
      await gateway.stop();
    }
  });

  it('keeps the wrapper alive through Ctrl-C and relays SIGTERM to the agent, whose exit code passes through', async () => {
    if (IS_WINDOWS) return;
    const interruptListenersBefore = process.listenerCount('SIGINT');
    const exitCode = spawnAgentWithInheritedStdio('/bin/sh', ['-c', 'trap "exit 7" TERM; trap "" INT; while :; do sleep 0.05; done'], { PATH: '/usr/bin:/bin' }, '/');
    expect(process.listenerCount('SIGINT')).toBe(interruptListenersBefore + 1);
    await Bun.sleep(200);
    // Call only the handlers just added; emitting the signal would reach the test runner's own.
    (process.listeners('SIGINT').at(-1) as () => void)();
    (process.listeners('SIGTERM').at(-1) as () => void)();
    expect(await exitCode).toBe(7);
    expect(process.listenerCount('SIGINT')).toBe(interruptListenersBefore);
  });

  it('starts the agent in the folder --cwd names, honours --capture, and returns its exit code', async () => {
    if (IS_WINDOWS) return;
    const box = sandbox('run-cli');
    const agentsDirectory = join(WIRE_GATEWAY_DIR, 'agents');
    const descriptorPath = join(agentsDirectory, 'cwd-stub-agent.json');
    mkdirSync(agentsDirectory, { recursive: true });
    writeFileSync(descriptorPath, JSON.stringify({
      id: 'cwd-stub-agent',
      launch: { env: { STUB_BASE_URL: '{baseUrl}' }, baseUrlVariable: 'STUB_BASE_URL', defaultUpstream: 'https://api.example.com/v1' },
    }));
    const gateway = await startWireGatewayForTest({ routesReloadCheckIntervalMs: 0 });
    const printedPath = join(box.root, 'pwd.txt');
    const errorLines: string[] = [];
    try {
      const exitCode = await runWireAgentCli('run', ['cwd-stub-agent', '--cwd', box.home, '--capture', 'native', '--', '/bin/sh', '-c', 'pwd -P > "$0"; exit 7', printedPath], {
        config: { ...loadWireGatewayConfig(), host: '127.0.0.1', port: gateway.port },
        bunPath: process.execPath,
        scriptPath: WIRE_GATEWAY_SCRIPT,
        startDaemon: async () => undefined,
        stopDaemon: async () => undefined,
        writeLine: () => undefined,
        writeErrorLine: (line) => errorLines.push(line),
      });
      expect(exitCode).toBe(7);
      // The stub sent nothing through its launch: nothing was recorded, and it is said.
      expect(errorLines.join('\n')).toContain('sent no requests through the wire gateway');
      expect(readFileSync(printedPath, 'utf-8').trim()).toBe(realpathSync(box.home));
      // A stub with no native integration would default to wire capture; the flag wins.
      expect(readWireGatewayRoutesFile().routes['cwd-stub-agent'].captureSource).toBe('native');
      // As with connect, wire capture is refused for an agent its claude-mem hooks capture:
      // both would record the same session.
      await expect(runWireAgentCli('run', ['claude-code', '--capture', 'wire', '--', '/bin/true'], {
        config: { ...loadWireGatewayConfig(), host: '127.0.0.1', port: gateway.port },
        bunPath: process.execPath,
        scriptPath: WIRE_GATEWAY_SCRIPT,
        startDaemon: async () => undefined,
        stopDaemon: async () => undefined,
        writeLine: () => undefined,
        writeErrorLine: () => undefined,
      })).rejects.toThrow(/always captured by its claude-mem hooks; it cannot use --capture wire/);
    } finally {
      await gateway.stop();
      rmSync(descriptorPath, { force: true });
      removeWireGatewayRoute('cwd-stub-agent');
    }
  });

  it('refuses a config-wired agent and an env-only agent with no endpoint', async () => {
    const box = sandbox('run-refuse');
    const dependencies = {
      environment: box.environment,
      cwd: box.home,
      gatewayOrigin: 'http://127.0.0.1:1',
      routesFilePath: box.routesFilePath,
      ensureGatewayRunning: async () => undefined,
      createLaunch: async () => 'x',
      spawnAgent: async () => 0,
    };
    await expect(prepareAgentLaunch(descriptor('codex'), [], dependencies, 'wire')).rejects.toThrow(/wire connect codex/);
    await expect(prepareAgentLaunch(descriptor('cursor-private-inference'), ['sh'], { ...dependencies, environment: { ...box.environment, env: { PATH: '/usr/bin:/bin' } } }, 'wire'))
      .rejects.toThrow(/set CURSOR_LOCAL_AGENT_BASE_URL/);
  });
});

describe('regexes over agent content stay linear on 1 MB hostile input', () => {
  const withinOneSecond = (work: () => void) => {
    const started = performance.now();
    work();
    expect(performance.now() - started).toBeLessThan(1_000);
  };

  it('diff and mask', () => {
    withinOneSecond(() => maskSecretLine(' '.repeat(ONE_MEGABYTE) + 'x'));
    withinOneSecond(() => maskSecretLine('a'.repeat(ONE_MEGABYTE)));
    withinOneSecond(() => maskSecretLine(`export ${'\t'.repeat(ONE_MEGABYTE)}key`));
    withinOneSecond(() => diffConfigLines('a\n', `${'\n'.repeat(ONE_MEGABYTE)}x`));
    withinOneSecond(() => diffConfigLines('', `"${'k'.repeat(ONE_MEGABYTE)}`));
  });

  it('the TOML datetime explanation', () => {
    withinOneSecond(() => {
      expect(() => readConfigValue('toml', 'x.toml', new TextEncoder().encode(`${'a'.repeat(ONE_MEGABYTE)}\n`), 'a')).toThrow();
    });
    withinOneSecond(() => {
      expect(() => readConfigValue('toml', 'x.toml', new TextEncoder().encode(`k ${'='.repeat(ONE_MEGABYTE)}`), 'a')).toThrow();
    });
  });

  it('upstream paths, route ids, descriptor paths and version output', async () => {
    withinOneSecond(() => splitUpstreamForRoute(`https://x.example.com/${'/'.repeat(ONE_MEGABYTE)}a`, 'http://127.0.0.1:1', 'r'));
    withinOneSecond(() => expandUserDescriptorPath(`\${${'a'.repeat(ONE_MEGABYTE)}`, { home: '/h', env: {}, platform: 'linux' }));
    withinOneSecond(() => expandUserDescriptorPath('$'.repeat(ONE_MEGABYTE), { home: '/h', env: {}, platform: 'linux' }));

    const box = sandbox('hostile');
    box.write('.config/crush/crush.json', JSON.stringify({ providers: { [`${'-'.repeat(ONE_MEGABYTE)}a`]: { base_url: 'https://x.example.com/v1' } } }));
    box.write('.omp/agent/models.yml', 'providers:\n  x:\n    baseUrl: https://x.example.com/v1\n');
    const started = performance.now();
    const crush = await connectAgent(descriptor('crush'), box.options());
    expect(crush.plan.routes[0].routeId).toBe('crush-a');
    const omp = await connectAgent(descriptor('omp'), box.options(undefined, { readAgentVersion: () => `${'1'.repeat(ONE_MEGABYTE)}.` }));
    expect(omp.plan.identitySwitches).toEqual([]);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('the route identity path', async () => {
    const gateway = await startWireGatewayForTest();
    try {
      const started = performance.now();
      const response = await fetch(`${gateway.baseUrl}/r/${'a'.repeat(64 * 1024)}b/c`);
      await response.arrayBuffer();
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      await gateway.stop();
    }
  });
});
