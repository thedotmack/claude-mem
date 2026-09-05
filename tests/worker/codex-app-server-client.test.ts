import { describe, expect, it, spyOn } from 'bun:test';
import { getSupervisor } from '../../src/supervisor/index.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexAppServerArgs,
  buildCodexAppServerEnv,
  buildCodexAppServerThreadConfig,
  CodexAppServerClient,
} from '../../src/services/worker/CodexAppServerClient.js';

interface FakeCodex {
  authHome: string;
  executable: string;
  root: string;
  trace: string;
}

interface FakeCodexOptions {
  instructionSources?: string[];
  mode?: 'normal' | 'terminal-response' | 'slow-first-turn' | 'reject-first-init';
}

function createFakeCodex(options: FakeCodexOptions = {}): FakeCodex {
  const instructionSources = options.instructionSources ?? [];
  const mode = options.mode ?? 'normal';
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-fake-codex-'));
  const executable = join(root, 'codex');
  const trace = join(root, 'trace.jsonl');
  const authHome = join(root, 'native-codex-home');
  mkdirSync(authHome, { mode: 0o700 });
  writeFileSync(join(authHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }), { mode: 0o600 });
  const source = [
    '#!/usr/bin/env bun',
    "import { appendFileSync, statSync, existsSync } from 'node:fs';",
    `const trace = ${JSON.stringify(trace)};`,
    `const instructionSources = ${JSON.stringify(instructionSources)};`,
    `const mode = ${JSON.stringify(mode)};`,
    "const rejectInit = mode === 'reject-first-init' && !existsSync(trace);",
    "const record = value => appendFileSync(trace, JSON.stringify(value) + '\\n');",
    "record({ method: 'process/start', args: process.argv.slice(2), codexHome: process.env.CODEX_HOME, pid: process.pid });",
    "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
    'let buffer = "";',
    'let turn = 0;',
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', chunk => {",
    '  buffer += chunk;',
    "  let newline; while ((newline = buffer.indexOf('\\n')) !== -1) {",
    '    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);',
    '    if (!line) continue;',
    '    const message = JSON.parse(line);',
    '    record(message);',
    "    if (message.method === 'initialized') continue;",
    "    if (message.method === 'initialize') send(rejectInit ? { id: message.id, error: { code: -32600, message: 'initialize rejected' } } : { id: message.id, result: { userAgent: 'fake-codex' } });",
    "    else if (message.method === 'config/read') send({ id: message.id, result: { config: { mcp_servers: { inherited: { command: 'false' } } }, layers: [] } });",
    "    else if (message.method === 'thread/start') {",
    "      const mode = statSync(message.params.cwd).mode & 0o777;",
    "      record({ method: 'workspace/attestation', mode });",
    "      send({ id: message.id, result: { thread: { id: 'thread-' + (turn + 1) }, instructionSources } });",
    '    }',
    "    else if (message.method === 'mcpServerStatus/list') send({ id: message.id, result: { data: [{ name: 'inherited', serverInfo: null, tools: {} }], nextCursor: null } });",
    "    else if (message.method === 'turn/start') {",
    '      turn += 1;',
    "      const turnId = 'turn-' + turn;",
    "      const content = JSON.stringify({ content: '<observation><type>discovery</type><title>Turn ' + turn + '</title><narrative>Captured.</narrative></observation>' });",
    "      const finish = () => {",
    "        send({ method: 'thread/tokenUsage/updated', params: { threadId: message.params.threadId, tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 } } } });",
    "        send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: content } } });",
    "        send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'completed', items: [] } } });",
    '      };',
    "      if (mode === 'terminal-response') {",
    "        send({ id: message.id, result: { turn: { id: turnId, status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: content }] } } });",
    '      } else {',
    '        send({ id: message.id, result: { turn: { id: turnId, status: \'inProgress\' } } });',
    "        if (mode === 'slow-first-turn' && turn === 1) setTimeout(finish, 250); else finish();",
    '      }',
    '    }',
    "    else if (message.method === 'thread/unsubscribe') send({ id: message.id, result: {} });",
    "    else if (message.method === 'turn/interrupt') send({ id: message.id, result: {} });",
    "    else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'unsupported' } });",
    '  }',
    '});',
  ].join('\n');
  writeFileSync(executable, source, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { authHome, executable, root, trace };
}

function readTrace(path: string): Array<Record<string, any>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

it('leaves model and effort selection to Codex when no override is configured', async () => {
  const fake = createFakeCodex();
  const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
  try {
    await client.runTurn({ codexPath: fake.executable, model: '', reasoningEffort: null,
      prompt: 'Summarize the supplied text.', timeoutMs: 5000 });
    const messages = readTrace(fake.trace).filter(entry => ['thread/start', 'turn/start'].includes(entry.method as string));
    expect(messages).toHaveLength(2);
    for (const entry of messages) {
      expect(entry.params).not.toHaveProperty('model');
      expect(entry.params).not.toHaveProperty('effort');
    }
  } finally {
    await client.close();
    rmSync(fake.root, { recursive: true, force: true });
  }
});

it('rejects API-key login before launching a model process', async () => {
  const fake = createFakeCodex();
  writeFileSync(join(fake.authHome, 'auth.json'), JSON.stringify({ auth_mode: 'apikey' }), { mode: 0o600 });
  const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
  try {
    await expect(client.runTurn({ codexPath: fake.executable, model: '', reasoningEffort: null,
      prompt: 'Summarize.', timeoutMs: 5000 })).rejects.toThrow('not an API key');
    expect(readTrace(fake.trace)).toHaveLength(0);
  } finally {
    await client.close();
    rmSync(fake.root, { recursive: true, force: true });
  }
});

async function waitForTrace(path: string, predicate: (trace: Array<Record<string, any>>) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate(readTrace(path))) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for fake Codex trace');
}

describe('CodexAppServerClient configuration', () => {
  it('starts the persistent stdio app-server transport', () => {
    expect(buildCodexAppServerArgs()).toEqual(['app-server', '--listen', 'stdio://']);
  });

  it('disables inherited MCP servers, tools, hooks, skills, and project instructions', () => {
    const config = buildCodexAppServerThreadConfig(['zeta', 'alpha', 'alpha']);

    expect(config.project_doc_max_bytes).toBe(0);
    expect(config.include_environment_context).toBe(false);
    expect(config.hooks).toEqual({
      PreToolUse: [], PermissionRequest: [], PostToolUse: [], PreCompact: [], PostCompact: [],
      SessionStart: [], UserPromptSubmit: [], SubagentStart: [], SubagentStop: [], Stop: [],
    });
    expect(config.mcp_servers).toEqual({ alpha: { enabled: false }, zeta: { enabled: false } });
    expect(config['features.shell_tool']).toBe(false);
    expect(config['features.unified_exec']).toBe(false);
    expect(config['features.web_search_request']).toBe(false);
    expect(config['skills.include_instructions']).toBe(false);
  });

  it('passes only the OS and Codex paths needed for ChatGPT login', () => {
    const env = buildCodexAppServerEnv({
      PATH: '/usr/bin', HOME: '/home/tester', CODEX_HOME: '/home/tester/.codex', LANG: 'C.UTF-8',
      OPENROUTER_API_KEY: 'secret', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret',
      SSH_AUTH_SOCK: '/tmp/agent.sock', CUSTOM_TOKEN: 'secret',
    }, '/tmp/claude-mem-private-codex');

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/tester', CODEX_HOME: '/tmp/claude-mem-private-codex', LANG: 'C.UTF-8' });
  });
});

const itPosix = process.platform === 'win32' ? it.skip : it;

describe('CodexAppServerClient transport', () => {
  itPosix('reaps a rejected handshake and initializes a fresh supervised child', async () => {
    const fake = createFakeCodex({ mode: 'reject-first-init' });
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    const register = spyOn(getSupervisor(), 'registerProcess');
    const unregister = spyOn(getSupervisor(), 'unregisterProcess');
    const options = { codexPath: fake.executable, model: '', reasoningEffort: null,
      prompt: 'Summarize.', timeoutMs: 5000 };
    try {
      await expect(client.runTurn(options)).rejects.toThrow('initialize rejected');
      expect((client as any).child).toBeNull();
      expect((client as any).privateRoot).toBeNull();
      const firstPid = readTrace(fake.trace).find(entry => entry.method === 'process/start')!.pid;
      expect(() => process.kill(firstPid, 0)).toThrow();
      expect((await client.runTurn(options)).content).toContain('Captured.');
      const starts = readTrace(fake.trace).filter(entry => entry.method === 'process/start');
      expect(starts).toHaveLength(2);
      expect(starts[1].pid).not.toBe(firstPid);
      expect(getSupervisor().getRegistry().getRuntimeProcess(`codex-app-server:${starts[1].pid}`)).toBe((client as any).child);
      expect(readTrace(fake.trace).filter(entry => entry.method === 'initialize')).toHaveLength(2);
      expect(register).toHaveBeenCalledTimes(2);
      await (client as any).invalidate(new Error('late old-child failure'), register.mock.calls[0][2]);
      expect((client as any).child.pid).toBe(starts[1].pid);
      await client.close();
      await Bun.sleep(20);
      for (const start of starts) {
        expect(unregister).toHaveBeenCalledWith(`codex-app-server:${start.pid}`);
        expect(getSupervisor().getRegistry().getAll().some(entry => entry.pid === start.pid)).toBe(false);
        expect(existsSync(start.codexHome)).toBe(false);
      }
    } finally {
      await client.close();
      register.mockRestore();
      unregister.mockRestore();
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  itPosix('does not spawn while the supervisor is shutting down', async () => {
    const fake = createFakeCodex();
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    const guard = spyOn(getSupervisor(), 'assertCanSpawn').mockImplementation(() => {
      throw new Error('Supervisor is shutting down');
    });
    try {
      await expect(client.runTurn({ codexPath: fake.executable, model: '', reasoningEffort: null,
        prompt: 'Summarize.', timeoutMs: 5000 })).rejects.toThrow('Supervisor is shutting down');
      expect(guard).toHaveBeenCalledWith('codex');
      expect(readTrace(fake.trace)).toHaveLength(0);
      expect((client as any).privateRoot).toBeNull();
    } finally {
      guard.mockRestore();
      await client.close();
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  itPosix('reuses one process while isolating and validating every turn', async () => {
    const fake = createFakeCodex();
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    try {
      const options = {
        codexPath: fake.executable,
        model: 'test-model',
        reasoningEffort: 'low',
        prompt: 'Return one durable observation.',
        timeoutMs: 5_000,
      };
      const first = await client.runTurn(options);
      const second = await client.runTurn({ ...options, prompt: 'Return the next durable observation.' });
      const trace = readTrace(fake.trace);

      expect(first.content).toContain('<title>Turn 1</title>');
      expect(first).toMatchObject({ inputTokens: 12, outputTokens: 4, tokensUsed: 16 });
      expect(second.content).toContain('<title>Turn 2</title>');
      expect(trace.filter(entry => entry.method === 'process/start')).toHaveLength(1);
      expect(trace.find(entry => entry.method === 'process/start').codexHome).not.toBe(fake.authHome);
      expect(trace.filter(entry => entry.method === 'initialize')).toHaveLength(1);
      expect(trace.filter(entry => entry.method === 'thread/start')).toHaveLength(2);
      expect(trace.filter(entry => entry.method === 'workspace/attestation').every(entry => entry.mode === 0o700)).toBe(true);

      const threadStart = trace.find(entry => entry.method === 'thread/start');
      expect(threadStart.params.ephemeral).toBe(true);
      expect(threadStart.params.sandbox).toBe('read-only');
      expect(threadStart.params.dynamicTools).toEqual([]);
      expect(threadStart.params.config.mcp_servers.inherited.enabled).toBe(false);

      const turnStart = trace.find(entry => entry.method === 'turn/start');
      expect(turnStart.params.effort).toBe('low');
      expect(turnStart.params.outputSchema.required).toEqual(['content']);
    } finally {
      await client.close();
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  itPosix('rejects any instruction source loaded by Codex', async () => {
    const fake = createFakeCodex({ instructionSources: ['/unexpected/AGENTS.md'] });
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    try {
      await expect(client.runTurn({
        codexPath: fake.executable,
        model: 'test-model',
        reasoningEffort: 'low',
        prompt: 'Return one durable observation.',
        timeoutMs: 5_000,
      })).rejects.toThrow(/unexpected instruction sources/);
    } finally {
      await client.close();
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  itPosix('accepts a terminal turn returned directly by turn/start', async () => {
    const fake = createFakeCodex({ mode: 'terminal-response' });
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    try {
      const result = await client.runTurn({
        codexPath: fake.executable,
        model: 'test-model',
        reasoningEffort: 'low',
        prompt: 'Return one durable observation.',
        timeoutMs: 5_000,
      });
      expect(result.content).toContain('<title>Turn 1</title>');
    } finally {
      await client.close();
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  itPosix('drops an aborted queued turn without restarting the shared process', async () => {
    const fake = createFakeCodex({ mode: 'slow-first-turn' });
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    const options = {
      codexPath: fake.executable,
      model: 'test-model',
      reasoningEffort: 'low',
      prompt: 'Return one durable observation.',
      timeoutMs: 5_000,
    } as const;
    try {
      const first = client.runTurn(options);
      await waitForTrace(fake.trace, trace => trace.some(entry => entry.method === 'turn/start'));
      const controller = new AbortController();
      const queued = client.runTurn({ ...options, signal: controller.signal });
      controller.abort();
      await expect(queued).rejects.toThrow(/aborted while queued/);
      await first;
      await client.runTurn(options);
      expect(readTrace(fake.trace).filter(entry => entry.method === 'process/start')).toHaveLength(1);
    } finally {
      await client.close();
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  itPosix('rechecks caller admission after the queue wait and before turn/start', async () => {
    const fake = createFakeCodex({ mode: 'slow-first-turn' });
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    const options = { codexPath: fake.executable, model: 'test-model', reasoningEffort: 'none',
      prompt: 'Return one durable observation.', timeoutMs: 5_000 };
    let admitted = true;
    try {
      const first = client.runTurn(options);
      await waitForTrace(fake.trace, trace => trace.some(entry => entry.method === 'turn/start'));
      const queued = client.runTurn({ ...options, beforeSend: () => {
        if (!admitted) throw new Error('quota paused while queued');
      } });
      admitted = false;
      await first;
      await expect(queued).rejects.toThrow('quota paused while queued');
      expect(readTrace(fake.trace).filter(entry => entry.method === 'turn/start')).toHaveLength(1);
    } finally {
      await client.close();
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  itPosix('ignores stale close events after a binary replacement', async () => {
    const fake = createFakeCodex();
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    const options = {
      codexPath: fake.executable,
      model: 'test-model',
      reasoningEffort: 'low',
      prompt: 'Return one durable observation.',
      timeoutMs: 5_000,
    } as const;
    try {
      await client.runTurn(options);
      writeFileSync(fake.executable, `${readFileSync(fake.executable, 'utf8')}\n`);
      await client.runTurn(options);
      await Bun.sleep(100);
      await client.runTurn(options);
      expect(readTrace(fake.trace).filter(entry => entry.method === 'process/start')).toHaveLength(2);
    } finally {
      await client.close();
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  itPosix('waits for the persistent child to stop on close', async () => {
    const fake = createFakeCodex();
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    try {
      await client.runTurn({
        codexPath: fake.executable,
        model: 'test-model',
        reasoningEffort: 'low',
        prompt: 'Return one durable observation.',
        timeoutMs: 5_000,
      });
      const pid = Number(readTrace(fake.trace).find(entry => entry.method === 'process/start')?.pid);
      expect(pid).toBeGreaterThan(0);
      await client.close();
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await client.close();
      rmSync(fake.root, { recursive: true, force: true });
    }
  });

  itPosix('rejects queued and future turns without restarting after close', async () => {
    const fake = createFakeCodex({ mode: 'slow-first-turn' });
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    const options = {
      codexPath: fake.executable,
      model: 'test-model',
      reasoningEffort: 'none',
      prompt: 'Return one durable observation.',
      timeoutMs: 5_000,
    } as const;
    try {
      const active = client.runTurn(options);
      await waitForTrace(fake.trace, trace => trace.some(entry => entry.method === 'turn/start'));
      const queued = client.runTurn(options);
      const settled = Promise.allSettled([active, queued]);

      await client.close();
      const [activeResult, queuedResult] = await settled;

      expect(activeResult.status).toBe('rejected');
      expect(queuedResult.status).toBe('rejected');
      if (queuedResult.status === 'rejected') {
        expect(String(queuedResult.reason)).toMatch(/client closed/);
      }
      await expect(client.runTurn(options)).rejects.toThrow(/client closed/);
      expect(readTrace(fake.trace).filter(entry => entry.method === 'process/start')).toHaveLength(1);
    } finally {
      await client.close();
      rmSync(fake.root, { recursive: true, force: true });
    }
  });
});
