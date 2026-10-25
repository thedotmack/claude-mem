import { afterEach, describe, expect, it } from 'bun:test';
import { setFakeSpawn } from '../../helpers/fake-spawn.js';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { spawn } from 'child_process';
import { GEMINI_NO_MCP_SERVERS, runAgentTask, type AgentTask } from '../../../src/services/agent-runner/run.js';
import type { UsableAgent } from '../../../src/services/agent-runner/detect.js';

class FakeStream extends EventEmitter {
  setEncoding(): this { return this; }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdinText = '';
  killed = false;
  stdin = Object.assign(new EventEmitter(), { end: (text: string) => { this.stdinText = text; } });
  kill() { this.killed = true; return true; }
}

interface SpawnCall { command: string; args: string[]; options: Record<string, unknown>; child: FakeChild }

/** A fake spawn whose children answer through `answer` after they start. */
function fakeSpawn(calls: SpawnCall[], answer: (call: SpawnCall) => void): typeof spawn {
  return ((command: string, args: string[], options: Record<string, unknown>) => {
    const call = { command, args, options, child: new FakeChild() };
    calls.push(call);
    queueMicrotask(() => answer(call));
    return call.child;
  }) as unknown as typeof spawn;
}

const agents = (...ids: Array<UsableAgent['id']>): UsableAgent[] =>
  (['claude-code', 'codex', 'gemini'] as const).map(id => ({ id, path: ids.includes(id) ? `/bin/${id}` : null, authenticated: ids.includes(id), reason: 'test' }));

const LIGHT_MODELS = { 'claude-code': { model: 'haiku' }, codex: { model: 'gpt-6-luna', reasoningEffort: 'low' }, gemini: { model: 'flash-lite' } };

function task(cwd: string, inlineCalls: string[] = [], models: Record<string, unknown> = {}): AgentTask {
  return {
    reason: 'test',
    cwd,
    claudeCode: {
      plugins: [{ type: 'local', path: '/plugin' }],
      tools: ['Read'],
      allowedTools: ['mcp__plugin_claude-mem_mcp-search__search'],
      readableFolders: [cwd],
    },
    run: async (ask, agent) => {
      const answer = await ask(`inline prompt for ${agent}`, models);
      inlineCalls.push(answer);
      return `inline done: ${answer}`;
    },
  };
}

 /** runAgentTask with `spawn` installed as child_process.spawn for the run. */
function runTask(agentTask: AgentTask, { spawn: fake, ...overrides }: { spawn: typeof spawn } & Parameters<typeof runAgentTask>[1]) {
  setFakeSpawn(fake);
  return runAgentTask(agentTask, overrides);
}
afterEach(() => setFakeSpawn(null));

const neverQuery = (() => { throw new Error('query must not run'); }) as never;
const env = async () => ({ PATH: '/bin', CLAUDE_MEM_INTERNAL: '1' });

describe('agent runner', () => {
  it('Claude Code reads only inside the task\'s readable folders: never the data dir\'s .env, even through a link', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-runner-read-'));
    try {
      const ledger = join(dataDir, 'work-view');
      mkdirSync(ledger);
      writeFileSync(join(dataDir, '.env'), 'ANTHROPIC_API_KEY=secret');
      writeFileSync(join(ledger, 'show.json'), '{}');
      symlinkSync(join(dataDir, '.env'), join(ledger, 'env-link'));
      const seen: any[] = [];
      const query = ((input: any) => { seen.push(input); return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' }; })(); }) as never;
      const readTask: AgentTask = { ...task(ledger), claudeCode: { plugins: [], tools: ['Read', 'Grep', 'Glob'], allowedTools: [], readableFolders: [ledger] } };
      await runTask(readTask, { detect: async () => agents('claude-code'), query, spawn: fakeSpawn([], () => {}), buildEnv: env });
      const { canUseTool } = seen[0].options;
      const decide = async (tool: string, input: Record<string, unknown>) => (await canUseTool(tool, input, { signal: new AbortController().signal })).behavior;
      expect(await decide('Read', { file_path: join(ledger, 'show.json') })).toBe('allow');
      expect(await decide('Read', { file_path: 'show.json' })).toBe('allow');
      expect(await decide('Read', { file_path: join(dataDir, '.env') })).toBe('deny');
      expect(await decide('Read', { file_path: join(ledger, '..', '.env') })).toBe('deny');
      expect(await decide('Read', { file_path: join(ledger, 'env-link') })).toBe('deny');
      expect(await decide('Grep', { pattern: 'KEY' })).toBe('allow');
      expect(await decide('Grep', { pattern: 'KEY', path: dataDir })).toBe('deny');
      expect(await decide('Glob', { pattern: '*.json' })).toBe('allow');
      expect(await decide('Glob', { pattern: join(dataDir, '*') })).toBe('deny');
      expect(await decide('Glob', { pattern: '../*' })).toBe('deny');
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });

  it('a task that auto-approves Read, Grep or Glob is refused before any agent runs', async () => {
    const autoRead: AgentTask = { ...task('/data'), claudeCode: { plugins: [], tools: ['Read'], allowedTools: ['Read'], readableFolders: ['/data'] } };
    await expect(runTask(autoRead, { detect: async () => agents('claude-code'), query: neverQuery, spawn: fakeSpawn([], () => {}), buildEnv: env })).rejects.toThrow(/Read/);
  });

  it('Claude Code: one SDK query per step, read-only tools only, no bypass and no session persistence', async () => {
    const seen: any[] = [];
    const query = ((input: any) => {
      seen.push(input);
      return (async function* () {
        yield { type: 'assistant', message: { content: [] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: '{"reviews": []}' };
      })();
    }) as never;
    const result = await runTask(task('/data'), { detect: async () => agents('claude-code', 'codex'), query, spawn: fakeSpawn([], () => {}), buildEnv: env });
    expect(result).toEqual({ state: 'ok', agent: 'claude-code', result: 'inline done: {"reviews": []}', error: null, attempts: [] });
    const { prompt, options } = seen[0];
    expect(prompt).toBe('inline prompt for claude-code');
    expect(options.pathToClaudeCodeExecutable).toBe('/bin/claude-code');
    expect(options.cwd).toBe('/data');
    expect(options.persistSession).toBe(false);
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe('default');
    expect(JSON.stringify(options)).not.toMatch(/bypass|dangerous|skip/i);
    expect(options.allowedTools).toEqual(['mcp__plugin_claude-mem_mcp-search__search']);
    expect(options.tools).toEqual(['Read']);
    expect(options.plugins).toEqual([{ type: 'local', path: '/plugin' }]);
    expect(options.env.CLAUDE_MEM_INTERNAL).toBe('1');
    // Anything the allowed list did not approve is denied.
    expect((await options.canUseTool('Bash', { command: 'rm -rf ~' })).behavior).toBe('deny');
    expect((await options.canUseTool('Edit', { file_path: '/x' })).behavior).toBe('deny');
  });

  it('Codex: codex exec read-only, ephemeral and without the user config (no MCP tools), prompt on stdin, answer from the -o file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-codex-'));
    try {
      const calls: SpawnCall[] = [];
      const spawnImpl = fakeSpawn(calls, call => {
        writeFileSync(call.args[call.args.indexOf('-o') + 1], '{"ok":true}');
        call.child.emit('close', 0);
      });
      const inlineCalls: string[] = [];
      const result = await runTask(task(cwd, inlineCalls), { detect: async () => agents('codex', 'gemini'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
      expect(result.state).toBe('ok');
      expect(result.agent).toBe('codex');
      expect(result.result).toBe('inline done: {"ok":true}');
      expect(calls).toHaveLength(1);
      const { command, args, options, child } = calls[0];
      expect(command).toBe('/bin/codex');
      expect(args[0]).toBe('exec');
      expect(args).toContain('--strict-config');
      expect(args).not.toContain('-s'); // legacy sandbox flags would override the scoped profile
      expect(args).toContain('default_permissions="claude-mem-refresh"');
      const policy = args.find(arg => arg.startsWith('permissions.claude-mem-refresh.filesystem='))!;
      expect(policy).toContain('":root"="deny"');
      expect(policy).toContain('":workspace_roots"={"."="read"}');
      expect(policy).toContain('"/bin"="read"');
      expect(args).toContain('permissions.claude-mem-refresh.network.enabled=false');
      expect(args).toContain('--ephemeral');
      expect(args).toContain('--ignore-user-config');
      expect(args[args.indexOf('-C') + 1]).toBe(cwd);
      expect(args[args.indexOf('-o') + 1].startsWith(join(cwd, 'agent-runs'))).toBe(true);
      expect(args.at(-1)).toBe('-');
      expect(args.join(' ')).not.toMatch(/bypass|dangerous|full-auto|yolo/i);
      expect(child.stdinText).toBe('inline prompt for codex');
      expect(options.cwd).toBe(cwd);
      expect((options.env as Record<string, string>).CLAUDE_MEM_INTERNAL).toBe('1');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('Codex: a step with an answer schema passes it as --output-schema, and the schema file is removed after', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-codex-schema-'));
    try {
      const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } };
      const calls: SpawnCall[] = [];
      let schemaSeen: unknown = null;
      const spawnImpl = fakeSpawn(calls, call => {
        schemaSeen = JSON.parse(readFileSync(call.args[call.args.indexOf('--output-schema') + 1], 'utf8'));
        writeFileSync(call.args[call.args.indexOf('-o') + 1], '{"ok":true}');
        call.child.emit('close', 0);
      });
      const schemaTask: AgentTask = { ...task(cwd), run: async ask => ask('prompt', LIGHT_MODELS, schema) };
      const result = await runTask(schemaTask, { detect: async () => agents('codex'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
      expect(result).toMatchObject({ state: 'ok', agent: 'codex', result: '{"ok":true}' });
      const { args } = calls[0];
      const schemaIndex = args.indexOf('--output-schema');
      expect(args[schemaIndex + 1].startsWith(join(cwd, 'agent-runs'))).toBe(true);
      expect(args.slice(schemaIndex + 2)).toEqual(['-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"', '-']);
      expect(schemaSeen).toEqual(schema);
      expect(existsSync(args[schemaIndex + 1])).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('Gemini: gemini -p in plan (read-only) mode, never --skip-trust, no extensions or MCP servers, JSON output, prompt on stdin', async () => {
    const calls: SpawnCall[] = [];
    const spawnImpl = fakeSpawn(calls, call => {
      const policyPath = (call.options.env as Record<string, string>).GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      expect(JSON.parse(readFileSync(policyPath, 'utf8'))).toEqual({
        tools: { core: [] },
        security: { disableYoloMode: true }, hooksConfig: { enabled: false },
      });
      call.child.stdout.emit('data', JSON.stringify({ response: '{"ok":"gemini"}', stats: {} }));
      call.child.emit('close', 0);
    });
    const result = await runTask(task('/data'), { detect: async () => agents('gemini'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
    expect(result).toEqual({ state: 'ok', agent: 'gemini', result: 'inline done: {"ok":"gemini"}', error: null, attempts: [] });
    expect(existsSync((calls[0].options.env as Record<string, string>).GEMINI_CLI_SYSTEM_SETTINGS_PATH)).toBe(false);
    expect(calls[0].command).toBe('/bin/gemini');
    expect(calls[0].args).toEqual(['-p', 'Follow the instructions above.', '--approval-mode', 'plan', '-e', 'none', '--allowed-mcp-server-names', GEMINI_NO_MCP_SERVERS, '-o', 'json']);
    expect(calls[0].args).not.toContain('--skip-trust');
    expect(calls[0].child.stdinText).toBe('inline prompt for gemini');
  });

  it('a failed run falls through to the next logged-in agent', async () => {
    const query = (() => (async function* () { yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'quota' }; })()) as never;
    const calls: SpawnCall[] = [];
    const spawnImpl = fakeSpawn(calls, call => {
      if (call.command === '/bin/codex') { call.child.stderr.emit('data', 'not signed in'); call.child.emit('close', 1); return; }
      call.child.stdout.emit('data', JSON.stringify({ response: 'fine' }));
      call.child.emit('close', 0);
    });
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-fallthrough-'));
    try {
      const result = await runTask(task(cwd), { detect: async () => agents('claude-code', 'codex', 'gemini'), query, spawn: spawnImpl, buildEnv: env });
      expect(result.state).toBe('ok');
      expect(result.agent).toBe('gemini');
      expect(result.attempts.map(attempt => attempt.agent)).toEqual(['claude-code', 'codex']);
      expect(result.attempts[0].error).toMatch(/quota/);
      expect(result.attempts[1].error).toMatch(/codex exec exited 1: not signed in/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('when every agent fails, the error names each one\'s failure in the order tried', async () => {
    const query = (() => (async function* () { yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'narrative is 22000 characters' }; })()) as never;
    const spawnImpl = fakeSpawn([], call => {
      if (call.command === '/bin/codex') { call.child.stderr.emit('data', 'story refused'); call.child.emit('close', 1); return; }
      call.child.stderr.emit('data', 'not running in a trusted directory'); call.child.emit('close', 55);
    });
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-all-fail-'));
    try {
      const result = await runTask(task(cwd), { detect: async () => agents('claude-code', 'codex', 'gemini'), query, spawn: spawnImpl, buildEnv: env });
      expect(result).toMatchObject({ state: 'failed', agent: 'gemini' });
      expect(result.error).toMatch(/^Claude Code: .*narrative is 22000 characters.* · Codex: codex exec exited 1: story refused · Gemini: gemini exited 55: not running in a trusted directory$/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('each step runs on the model its table names, per backend; no entry keeps the CLI default', async () => {
    const seen: any[] = [];
    const query = ((input: any) => { seen.push(input); return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' }; })(); }) as never;
    await runTask(task('/data', [], LIGHT_MODELS), { detect: async () => agents('claude-code'), query, spawn: fakeSpawn([], () => {}), buildEnv: env });
    expect(seen[0].options.model).toBe('haiku');
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-models-'));
    try {
      const calls: SpawnCall[] = [];
      const spawnImpl = fakeSpawn(calls, call => {
        if (call.command === '/bin/codex') { writeFileSync(call.args[call.args.indexOf('-o') + 1], 'ok'); call.child.emit('close', 0); return; }
        call.child.stdout.emit('data', JSON.stringify({ response: 'ok' }));
        call.child.emit('close', 0);
      });
      await runTask(task(cwd, [], LIGHT_MODELS), { detect: async () => agents('codex'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
      await runTask(task(cwd, [], LIGHT_MODELS), { detect: async () => agents('gemini'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
      await runTask(task(cwd, [], {}), { detect: async () => agents('codex'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
      expect(calls[0].args.slice(-5)).toEqual(['-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"', '-']);
      expect(calls[1].args.slice(-2)).toEqual(['-m', 'flash-lite']);
      expect(calls[2].args).not.toContain('-m');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('each step gets a freshly built environment, so a long run never reuses an old OAuth token', async () => {
    let built = 0;
    const query = ((input: any) => (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: input.options.env.TOKEN }; })()) as never;
    const twoSteps: AgentTask = { ...task('/data'), run: async ask => `${await ask('one', {})} ${await ask('two', {})}` };
    const result = await runTask(twoSteps, { detect: async () => agents('claude-code'), query, spawn: fakeSpawn([], () => {}), buildEnv: async () => ({ TOKEN: `t${++built}` }) });
    expect(result.result).toBe('t1 t2');
  });

  it('an auth failure ends the run as failed with the clear error, after one try', async () => {
    let queries = 0;
    const query = (() => { queries++; return (async function* () { yield { type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth token revoked. Please log in again.' }; })(); }) as never;
    const result = await runTask(task('/data'), { detect: async () => agents('claude-code'), query, spawn: fakeSpawn([], () => {}), buildEnv: env });
    expect(result.state).toBe('failed');
    expect(result.error).toMatch(/OAuth token revoked/);
    expect(queries).toBe(1);
  });

  it('no logged-in agent: waiting-for-agent, and nothing runs', async () => {
    const calls: SpawnCall[] = [];
    const result = await runTask(task('/data'), { detect: async () => agents(), query: neverQuery, spawn: fakeSpawn(calls, () => {}), buildEnv: env });
    expect(result.state).toBe('waiting-for-agent');
    expect(calls).toHaveLength(0);
  });

  it('a slow run is never killed: it ends only when the agent does', async () => {
    const calls: SpawnCall[] = [];
    const spawnImpl = fakeSpawn(calls, call => {
      setTimeout(() => { call.child.stdout.emit('data', JSON.stringify({ response: 'slow but done' })); call.child.emit('close', 0); }, 1500);
    });
    const started = Date.now();
    const result = await runTask(task('/data'), { detect: async () => agents('gemini'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(result.state).toBe('ok');
    expect(calls[0].child.killed).toBe(false);
  });
});
