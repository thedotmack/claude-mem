import { describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function createFakeCodex(instructionSources: string[] = []): FakeCodex {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-fake-codex-'));
  const executable = join(root, 'codex');
  const trace = join(root, 'trace.jsonl');
  const authHome = join(root, 'native-codex-home');
  mkdirSync(authHome, { mode: 0o700 });
  writeFileSync(join(authHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }), { mode: 0o600 });
  const source = [
    '#!/usr/bin/env bun',
    "import { appendFileSync, statSync } from 'node:fs';",
    `const trace = ${JSON.stringify(trace)};`,
    `const instructionSources = ${JSON.stringify(instructionSources)};`,
    "const record = value => appendFileSync(trace, JSON.stringify(value) + '\\n');",
    "record({ method: 'process/start', args: process.argv.slice(2), codexHome: process.env.CODEX_HOME });",
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
    "    if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fake-codex' } });",
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
    '      send({ id: message.id, result: { turn: { id: turnId, status: \'inProgress\' } } });',
    "      send({ method: 'thread/tokenUsage/updated', params: { threadId: message.params.threadId, tokenUsage: { total: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1 } } } });",
    "      const content = JSON.stringify({ content: '<observation><type>discovery</type><title>Turn ' + turn + '</title><narrative>Captured.</narrative></observation>' });",
    "      send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: content } } });",
    "      send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'completed', items: [] } } });",
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
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
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
  itPosix('reuses one process while isolating and validating every turn', async () => {
    const fake = createFakeCodex();
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    try {
      const options = {
        codexPath: fake.executable,
        model: 'gpt-5.6-luna',
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
    const fake = createFakeCodex(['/unexpected/AGENTS.md']);
    const client = new CodexAppServerClient({ nativeCodexHome: fake.authHome });
    try {
      await expect(client.runTurn({
        codexPath: fake.executable,
        model: 'gpt-5.6-luna',
        reasoningEffort: 'low',
        prompt: 'Return one durable observation.',
        timeoutMs: 5_000,
      })).rejects.toThrow(/unexpected instruction sources/);
    } finally {
      await client.close();
      rmSync(fake.root, { recursive: true, force: true });
    }
  });
});
