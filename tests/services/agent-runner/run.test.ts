import { afterEach, describe, expect, it, jest, spyOn } from 'bun:test';
import { setFakeSpawn } from '../../helpers/fake-spawn.js';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import type { spawn } from 'child_process';
import { codexModelForLogin, GEMINI_NO_MCP_SERVERS, opencodeCliMajorVersion, readOpenCodeUserConfig, runAgentTask, type AgentTask } from '../../../src/services/agent-runner/run.js';
import { cutOutputText, detectUsableAgent, MAX_STREAM_CHARS, type UsableAgent } from '../../../src/services/agent-runner/detect.js';
import { logger } from '../../../src/utils/logger.js';

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

/**
 * The `opencode run` flags each CLI accepts, copied from its source: OpenCode 1.19.6
 * packages/opencode/src/cli/cmd/run.ts plus the global options in src/index.ts; OpenCode
 * 2.3.2 packages/cli/src/commands/commands.ts (`run` params, PermissionParams, ServerFlags
 * and the global flags). Both reject any other flag and exit 1.
 */
const OPENCODE_RUN_FLAGS: Record<1 | 2, { values: string[]; switches: string[] }> = {
  1: {
    values: ['command', 'session', 's', 'model', 'm', 'agent', 'format', 'file', 'f', 'title', 'attach', 'password', 'p',
      'username', 'u', 'dir', 'port', 'variant', 'replay-limit', 'log-level'],
    switches: ['continue', 'c', 'fork', 'share', 'thinking', 'mini', 'replay', 'interactive', 'i', 'auto', 'yolo',
      'dangerously-skip-permissions', 'demo', 'print-logs', 'pure', 'help', 'h'],
  },
  2: {
    values: ['session', 's', 'model', 'm', 'agent', 'format', 'file', 'f', 'title', 'server', 'log-level'],
    switches: ['continue', 'c', 'fork', 'worktree', 'w', 'archived', 'thinking', 'auto', 'yolo', 'dangerously-skip-permissions',
      'standalone', 'print-logs', 'help', 'h'],
  },
};

/** A fake `opencode`: answers `--version` with `version` and parses `run` flags as that CLI does before handing the run to `onRun`. */
function fakeOpenCodeCli(version: string, calls: SpawnCall[], onRun: (call: SpawnCall) => void): typeof spawn {
  const major = /\bv?2\./.test(version) ? 2 : 1;
  const flags = OPENCODE_RUN_FLAGS[major];
  return fakeSpawn(calls, call => {
    if (call.args[0] === '--version') { call.child.stdout.emit('data', `${version}\n`); call.child.emit('close', 0); return; }
    if (call.args[0] !== 'run') throw new Error(`unexpected opencode command: ${call.args.join(' ')}`);
    const unknown: string[] = [];
    for (let index = 1; index < call.args.length; index++) {
      const name = call.args[index].replace(/^--?/, '').split('=')[0];
      if (!call.args[index].startsWith('-')) continue;
      if (flags.values.includes(name)) { if (!call.args[index].includes('=')) index++; continue; }
      if (!flags.switches.includes(name)) unknown.push(call.args[index]);
    }
    if (unknown.length) {
      call.child.stderr.emit('data', unknown.map(flag => `Unrecognized flag: ${flag} in command opencode run\n`).join(''));
      call.child.emit('close', 1);
      return;
    }
    onRun(call);
  });
}

const CODEX_PATH = join(realpathSync(tmpdir()), 'agent-runner-tools', 'codex');

const agents = (...ids: Array<UsableAgent['id']>): UsableAgent[] =>
  (['claude-code', 'codex', 'gemini', 'opencode'] as const).map(id => ({ id, path: ids.includes(id) ? (id === 'codex' ? CODEX_PATH : `/bin/${id}`) : null, authenticated: ids.includes(id), reason: 'test' }));

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
  return runAgentTask(agentTask, { platform: () => 'linux', ...overrides });
}
afterEach(() => setFakeSpawn(null));

const neverQuery = (() => { throw new Error('query must not run'); }) as never;
const env = async () => ({ PATH: '/bin', CLAUDE_MEM_INTERNAL: '1' });

describe('agent runner', () => {
  it('keeps a relative Gemini profile anchored when running in the task folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'owned-gemini-run-'));
    const calls: SpawnCall[] = [];
    try {
      const result = await runTask(task(root), { detect: async () => agents('gemini'), query: neverQuery,
        buildEnv: async () => ({ GEMINI_CLI_HOME: 'owned-gemini-profile' }),
        spawn: fakeSpawn(calls, call => { call.child.stdout.emit('data', JSON.stringify({ response: 'owned answer' })); call.child.emit('close', 0); }),
      });
      expect(result.state).toBe('ok');
      expect(calls[0].options.cwd).toBe(root);
      expect((calls[0].options.env as NodeJS.ProcessEnv).GEMINI_CLI_HOME).toBe(resolve('owned-gemini-profile'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('Claude Code reads only inside the task\'s readable folders: never the data dir\'s .env, even through a link', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-runner-read-'));
    try {
      const ledger = join(dataDir, 'work-view');
      mkdirSync(ledger);
      writeFileSync(join(dataDir, '.env'), 'ANTHROPIC_API_KEY=secret');
      writeFileSync(join(ledger, 'show.json'), '{}');
      // A directory junction exercises the same escape without requiring
      // Windows' optional file-symlink privilege.
      const linkedSecret = process.platform === 'win32'
        ? join(ledger, 'private-data', '.env') : join(ledger, 'env-link');
      if (process.platform === 'win32') symlinkSync(dataDir, dirname(linkedSecret), 'junction');
      else symlinkSync(join(dataDir, '.env'), linkedSecret);
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
      expect(await decide('Read', { file_path: linkedSecret })).toBe('deny');
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
      expect(command).toBe(CODEX_PATH);
      expect(args[0]).toBe('exec');
      expect(args).toContain('--strict-config');
      expect(args).not.toContain('-s'); // legacy sandbox flags would override the scoped profile
      expect(args).toContain('default_permissions="claude-mem-refresh"');
      const policy = args.find(arg => arg.startsWith('permissions.claude-mem-refresh.filesystem='))!;
      expect(policy).toContain('":root"="deny"');
      expect(policy).toContain('":workspace_roots"={"."="read"}');
      expect(policy).toContain(`${JSON.stringify(dirname(CODEX_PATH))}="read"`);
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

  it('Codex launches the real executable behind a symlink without weakening the sandbox', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-codex-link-'));
    try {
      const binary = join(cwd, 'native', 'codex-native');
      const launcher = process.platform === 'win32'
        ? join(cwd, 'linked-native', 'codex-native') : join(cwd, 'codex-link');
      mkdirSync(dirname(binary));
      writeFileSync(binary, 'fixture');
      if (process.platform === 'win32') symlinkSync(dirname(binary), dirname(launcher), 'junction');
      else symlinkSync(binary, launcher);
      const calls: SpawnCall[] = [];
      const spawnImpl = fakeSpawn(calls, call => {
        writeFileSync(call.args[call.args.indexOf('-o') + 1], 'ok');
        call.child.emit('close', 0);
      });
      const result = await runTask(task(cwd), {
        detect: async () => [{ id: 'codex', path: launcher, authenticated: true, reason: 'fixture' }],
        query: neverQuery, spawn: spawnImpl, buildEnv: env,
      });
      expect(result.state).toBe('ok');
      expect(calls[0].command).toBe(realpathSync(binary));
      expect(calls[0].args).toContain('permissions.claude-mem-refresh.network.enabled=false');
      expect(calls[0].args.find(arg => arg.startsWith('permissions.claude-mem-refresh.filesystem='))).toContain('\":root\"=\"deny\"');
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

  it('Codex: a model this login does not list is replaced by its listed namesake, else left to Codex (Oct 25: gpt-6-luna on a ChatGPT login)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-runner-codex-home-'));
    try {
      const low = [{ effort: 'low' }, { effort: 'medium' }];
      const writeList = (models: unknown[]) => writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ fetched_at: '2026-10-27T05:50:35Z', models }));
      // The models Codex 0.154.0 listed for a ChatGPT login on Oct 27.
      writeList([
        { slug: 'gpt-6-astra', visibility: 'list', priority: 3, supported_reasoning_levels: low },
        { slug: 'gpt-reserve', visibility: 'hide', priority: 4 },
        { slug: 'gpt-5.6-sol', visibility: 'list', priority: 6, supported_reasoning_levels: low },
        { slug: 'gpt-5.6-terra', visibility: 'list', priority: 7, supported_reasoning_levels: low },
        { slug: 'gpt-5.6-luna', visibility: 'list', priority: 8, supported_reasoning_levels: low },
      ]);
      const light = LIGHT_MODELS.codex;
      expect(codexModelForLogin(light, { CODEX_HOME: home })).toEqual({ model: 'gpt-5.6-luna', reasoningEffort: 'low' });
      expect(codexModelForLogin(light, { HOME: join(home, 'nowhere') })).toEqual(light);
      expect(codexModelForLogin(light, {})).toEqual(light);
      expect(codexModelForLogin({}, { CODEX_HOME: home })).toEqual({});
      expect(codexModelForLogin({ model: 'gpt-7-nova' }, { CODEX_HOME: home })).toEqual({});
      expect(codexModelForLogin({ model: 'gpt-5.6-sol', reasoningEffort: 'high' }, { CODEX_HOME: home })).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
      writeList([{ slug: 'gpt-6-luna', visibility: 'list', priority: 1 }]);
      expect(codexModelForLogin(light, { CODEX_HOME: home })).toEqual(light);

      // The substitute reaches codex exec.
      writeList([{ slug: 'gpt-5.6-luna', visibility: 'list', priority: 8, supported_reasoning_levels: low }]);
      const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-codex-model-'));
      try {
        const calls: SpawnCall[] = [];
        const spawnImpl = fakeSpawn(calls, call => { writeFileSync(call.args[call.args.indexOf('-o') + 1], '{"ok":true}'); call.child.emit('close', 0); });
        const lightTask: AgentTask = { ...task(cwd), run: async ask => ask('prompt', LIGHT_MODELS) };
        const result = await runTask(lightTask, { detect: async () => agents('codex'), query: neverQuery, spawn: spawnImpl, buildEnv: async () => ({ ...(await env()), CODEX_HOME: home }) });
        expect(result.state).toBe('ok');
        expect(calls[0].args.slice(-5)).toEqual(['-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="low"', '-']);
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.each(['win32', 'linux'] as const)('Codex on %s retries a refused model with the same sandbox configuration', async (platform) => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-codex-refused-'));
    try {
      const calls: SpawnCall[] = [];
      const spawnImpl = fakeSpawn(calls, call => {
        if (call.args.includes('-m')) {
          call.child.stderr.emit('data', Buffer.from(`ERROR: {"detail":"The '${LIGHT_MODELS.codex.model}' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}`));
          call.child.emit('close', 1);
          return;
        }
        writeFileSync(call.args[call.args.indexOf('-o') + 1], '{"ok":true}');
        call.child.emit('close', 0);
      });
      // No models list in CODEX_HOME, so the step's model is sent as named and refused.
      const lightTask: AgentTask = { ...task(cwd), run: async ask => ask('prompt', LIGHT_MODELS) };
      const result = await runTask(lightTask, { detect: async () => agents('codex'), query: neverQuery, spawn: spawnImpl, platform: () => platform, buildEnv: async () => ({ ...(await env()), CODEX_HOME: join(cwd, 'no-codex-home') }) });
      expect(result.state).toBe('ok');
      expect(calls).toHaveLength(2);
      expect(calls[0].args).toContain('-m');
      expect(calls[1].args).not.toContain('-m');
      expect(calls[1].args.join(' ')).not.toContain('model_reasoning_effort');
      for (const { args } of calls) {
        expect(args.includes('features.prefer_mxc=true')).toBe(platform === 'win32');
        expect(args).toContain('--ignore-user-config');
        expect(args).toContain('permissions.claude-mem-refresh.network.enabled=false');
        expect(args.find(arg => arg.startsWith('permissions.claude-mem-refresh.filesystem='))).toContain('":root"="deny"');
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('Codex: any other failure is not retried', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-codex-other-'));
    try {
      const calls: SpawnCall[] = [];
      const spawnImpl = fakeSpawn(calls, call => { call.child.stderr.emit('data', Buffer.from('ERROR: stream disconnected')); call.child.emit('close', 1); });
      const lightTask: AgentTask = { ...task(cwd), run: async ask => ask('prompt', LIGHT_MODELS) };
      const result = await runTask(lightTask, { detect: async () => agents('codex'), query: neverQuery, spawn: spawnImpl, buildEnv: async () => ({ ...(await env()), CODEX_HOME: join(cwd, 'no-codex-home') }) });
      expect(result.state).toBe('failed');
      expect(calls).toHaveLength(1);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('Windows reports an actual Codex sandbox refusal and falls back without broadening access', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-windows-refusal-'));
    try {
      const calls: SpawnCall[] = [];
      const spawnImpl = fakeSpawn(calls, call => {
        if (call.command === CODEX_PATH) {
          call.child.stderr.emit('data', 'windows unelevated restricted-token sandbox cannot enforce split filesystem read restrictions directly; refusing to run unsandboxed');
          call.child.emit('close', 1);
          return;
        }
        call.child.stdout.emit('data', JSON.stringify({ response: '{"ok":"gemini"}' }));
        call.child.emit('close', 0);
      });
      const result = await runTask(task(cwd), {
        detect: async () => agents('codex', 'gemini'), query: neverQuery, spawn: spawnImpl, buildEnv: env, platform: () => 'win32',
      });
      expect(result).toMatchObject({ state: 'ok', agent: 'gemini' });
      expect(result.attempts).toHaveLength(1);
      expect(result.attempts[0]).toMatchObject({ agent: 'codex' });
      expect(result.attempts[0].error).toMatch(/Windows unelevated sandbox cannot enforce the required read restrictions/i);
      expect(result.attempts[0].error).toMatch(/elevated sandbox or a supported MXC/i);
      expect(calls.map(call => call.command)).toEqual([CODEX_PATH, '/bin/gemini']);
      expect(calls[0].args).toContain('permissions.claude-mem-refresh.network.enabled=false');
      expect(calls[0].args.find(arg => arg.startsWith('permissions.claude-mem-refresh.filesystem='))).toContain('":root"="deny"');
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

  it.each([
    { cli: 'OpenCode 1.x', version: '1.17.8', isolation: (root: string) => ['--pure', '--format', 'json', '--dir', root], policies: undefined },
    { cli: 'OpenCode 2.x', version: 'opencode v2.3.2', isolation: () => ['--standalone', '--format', 'json'], policies: [
      { action: 'plugin.use', resource: '*', effect: 'deny' },
      { action: 'mcp.use', resource: '*', effect: 'deny' },
    ] },
  ])('$cli: an isolated tool-less run from its config root, prompt on stdin, text parts joined', async ({ version, isolation, policies }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-opencode-'));
    const calls: SpawnCall[] = [];
    try {
      const steps: string[] = [];
      const twoSteps: AgentTask = { ...task(cwd), run: async ask => {
        steps.push(await ask('first step', { opencode: { model: 'provider/model' } }));
        steps.push(await ask('inline prompt for opencode', { opencode: { model: 'provider/model' } }));
        return `inline done: ${steps[1]}`;
      } };
      const result = await runTask(twoSteps, {
        detect: async () => agents('opencode'), query: neverQuery, spawn: fakeOpenCodeCli(version, calls, call => {
          const runEnv = call.options.env as Record<string, string>;
          const config = JSON.parse(readFileSync(join(runEnv.XDG_CONFIG_HOME, 'opencode', 'opencode.json'), 'utf8'));
          // The owner's default model and custom provider survive the isolation.
          expect(config.model).toBe('custom/default');
          expect(config.provider).toEqual({ custom: { models: { 'owned/model': {} } } });
          expect(config.mcp).toEqual({});
          expect(config.permission).toEqual({ edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' });
          expect(config.policies).toEqual(policies);
          const refreshAgent = config.agent['claude-mem-refresh'];
          expect(Object.values(refreshAgent.tools).every(enabled => enabled === false)).toBe(true);
          // Every tool the list does not name (`skill`, 2.x's automation and worktree tools) is denied as well.
          expect(refreshAgent.permission).toEqual({ '*': 'deny' });
          // A project opencode.json in the task folder must never be discovered.
          expect(call.options.cwd).toBe(runEnv.XDG_CONFIG_HOME);
          expect(call.options.cwd).not.toBe(cwd);
          // The JSON format streams each text part as it arrives, so the answer is their order.
          call.child.stdout.emit('data', `${JSON.stringify({ type: 'text', part: { type: 'text', text: '{"ok":' } })}\n`);
          call.child.stdout.emit('data', `${JSON.stringify({ type: 'text', part: { type: 'text', text: '"opencode"}' } })}\n`);
          call.child.emit('close', 0);
        }), buildEnv: async () => ({ ...(await env()), OPENCODE_CONFIG_CONTENT: '{"agent":{"claude-mem-refresh":{"permission":{"*":"allow"}}}}' }),
        opencodeUserConfig: () => ({ model: 'custom/default', provider: { custom: { models: { 'owned/model': {} } } } }),
      });
      expect(result).toEqual({ state: 'ok', agent: 'opencode', result: 'inline done: {"ok":"opencode"}', error: null, attempts: [] });
      // One version check for the run, then one `run` per step.
      expect(calls.map(call => call.args[0])).toEqual(['--version', 'run', 'run']);
      const runCall = calls[2];
      expect(runCall.command).toBe('/bin/opencode');
      const runEnv = runCall.options.env as Record<string, string>;
      const isolated = runEnv.XDG_CONFIG_HOME;
      expect(runCall.args).toEqual(['run', ...isolation(isolated), '--agent', 'claude-mem-refresh', '--model', 'provider/model']);
      expect(runCall.child.stdinText).toBe('inline prompt for opencode');
      expect(runEnv.PWD).toBe(isolated);
      expect(runEnv.OPENCODE_CONFIG).toBe(join(isolated, 'opencode', 'opencode.json'));
      expect(runEnv.OPENCODE_CONFIG_DIR).toBe(join(isolated, 'opencode'));
      expect(runEnv.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
      // Config content from the environment would load after the run's own file and could re-allow tools.
      expect(runEnv.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      expect(existsSync(isolated)).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it.each(['opencode v2.3.2', 'opencode v2.2.3', '1.17.8'])('OpenCode CLI printing "%s": every run flag is one that CLI accepts', async version => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-opencode-flags-'));
    const calls: SpawnCall[] = [];
    try {
      const result = await runTask(task(cwd, [], { opencode: { model: 'provider/model' } }), {
        detect: async () => agents('opencode'), query: neverQuery, buildEnv: env, opencodeUserConfig: () => ({}),
        spawn: fakeOpenCodeCli(version, calls, call => {
          call.child.stdout.emit('data', '{"type":"text","part":{"type":"text","text":"done"}}\n');
          call.child.emit('close', 0);
        }),
      });
      expect(result).toMatchObject({ state: 'ok', agent: 'opencode', attempts: [] });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('OpenCode 2.x rejects the 1.x run flags, as the 2.3.2 CLI does', async () => {
    const calls: SpawnCall[] = [];
    const spawn = fakeOpenCodeCli('opencode v2.3.2', calls, () => { throw new Error('the fake must reject these flags'); });
    const child = (spawn as unknown as (command: string, args: string[], options: object) => FakeChild)(
      '/bin/opencode', ['run', '--pure', '--format', 'json', '--dir', '/isolated', '--agent', 'claude-mem-refresh'], {},
    );
    let stderr = '';
    child.stderr.on('data', (text: string) => { stderr += text; });
    const exitCode = await new Promise(resolve => child.on('close', resolve));
    expect(exitCode).toBe(1);
    expect(stderr).toBe('Unrecognized flag: --pure in command opencode run\nUnrecognized flag: --dir in command opencode run\n');
    expect(calls).toHaveLength(1);
  });

  it.each([
    { version: 'opencode v2.2.2', reason: 'OpenCode 2.2.2 cannot keep external plugins out of the refresh step; update OpenCode to 2.2.3 or newer.' },
    { version: 'opencode v2.0.0', reason: 'OpenCode 2.0.0 cannot keep external plugins out of the refresh step; update OpenCode to 2.2.3 or newer.' },
    { version: 'opencode v3.0.0', reason: 'OpenCode 3.0.0 is newer than the 1.x and 2.x releases claude-mem knows how to isolate, so the refresh step does not run on it.' },
    { version: 'unknown', reason: 'opencode --version printed no version (unknown), so its run flags are unknown.' },
  ])('OpenCode CLI printing "$version": the step is refused without starting a run', async ({ version, reason }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-opencode-refused-'));
    const calls: SpawnCall[] = [];
    try {
      const result = await runTask(task(cwd), {
        detect: async () => agents('opencode'), query: neverQuery, buildEnv: env, opencodeUserConfig: () => ({}),
        spawn: fakeOpenCodeCli(version, calls, () => { throw new Error('a refused version must not run'); }),
      });
      expect(result).toMatchObject({ state: 'failed', agent: 'opencode', attempts: [{ agent: 'opencode', error: reason }] });
      expect(calls.map(call => call.args)).toEqual([['--version']]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('opencodeCliMajorVersion reads both CLIs\' version lines', () => {
    expect(opencodeCliMajorVersion('1.17.8\n')).toBe(1);
    expect(opencodeCliMajorVersion('1.19.6')).toBe(1);
    expect(opencodeCliMajorVersion('opencode v2.3.2\n')).toBe(2);
    expect(opencodeCliMajorVersion('opencode v2.2.3')).toBe(2);
    expect(opencodeCliMajorVersion('opencode v2.10.0')).toBe(2);
    expect(() => opencodeCliMajorVersion('opencode v2.2.2')).toThrow('update OpenCode to 2.2.3 or newer');
  });

  it.each([
    { source: 'shell key', legacy: false, settings: '', key: 'shell-key', base: undefined, token: undefined },
    { source: 'configured gateway on a legacy CLI', legacy: true, settings: 'ANTHROPIC_BASE_URL=https://gateway.example\nANTHROPIC_AUTH_TOKEN=gateway-token',
      key: undefined, base: 'https://gateway.example', token: 'gateway-token' },
  ])('OpenCode uses the same $source for auth list and the refresh command', async ({ legacy, settings, key, base, token }) => {
    const cwd = mkdtempSync(join(tmpdir(), 'opencode-credentials-'));
    const saved = {
      CLAUDE_MEM_ENV_FILE: process.env.CLAUDE_MEM_ENV_FILE, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    try {
      process.env.CLAUDE_MEM_ENV_FILE = join(cwd, '.env');
      writeFileSync(process.env.CLAUDE_MEM_ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=claude-only\n' + settings);
      process.env.ANTHROPIC_API_KEY = 'shell-key';
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'parent-claude-only';
      delete process.env.ANTHROPIC_BASE_URL;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      const calls: SpawnCall[] = [];
      const spawn = fakeSpawn(calls, ({ args, child }) => {
        if (args[0] === 'auth') {
          if (legacy && args.includes('--format')) { child.emit('close', 1); return; }
          child.stdout.emit('data', legacy ? '1 credential' : '[{"connections":[{"type":"env","name":"ANTHROPIC_API_KEY"}]}]');
        } else if (args[0] === '--version') {
          child.stdout.emit('data', legacy ? '1.17.8\n' : 'opencode v2.3.2\n');
        } else if (args[0] === 'run') {
          child.stdout.emit('data', '{"type":"text","part":{"type":"text","text":"done"}}');
        } else {
          child.stdout.emit('data', '/bin/opencode');
        }
        child.emit('close', 0);
      });
      const result = await runTask(task(cwd), {
        detect: async () => [await detectUsableAgent('opencode', { spawn, platform: () => 'linux' })],
        spawn, query: neverQuery, opencodeUserConfig: () => ({}),
      });
      expect(result.state).toBe('ok');
      const commands = calls.filter(call => call.command === '/bin/opencode');
      expect(commands.map(call => call.args[0])).toEqual(legacy ? ['auth', 'auth', '--version', 'run'] : ['auth', '--version', 'run']);
      // The CLI the probe found is the one whose run flags are used.
      expect(commands.at(-1)!.args[1]).toBe(legacy ? '--pure' : '--standalone');
      for (const call of commands) {
        const env = (call.options.env as NodeJS.ProcessEnv | undefined) ?? process.env;
        expect(env.ANTHROPIC_API_KEY).toBe(key);
        expect(env.ANTHROPIC_BASE_URL).toBe(base);
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe(token);
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('OpenCode: only the default model and providers come from the user config, and JSONC parses', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-user-config-'));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const previousConfig = process.env.OPENCODE_CONFIG;
    try {
      mkdirSync(join(home, 'opencode'), { recursive: true });
      writeFileSync(join(home, 'opencode', 'opencode.jsonc'), `{
        // an inline comment the CLI accepts
        "model": "custom/default",
        "provider": { "custom": { "models": { "owned/model": {} } } },
        "mcp": { "hostile": { "type": "local", "command": ["rm", "-rf", "/"] } },
        "plugin": ["hostile-plugin"],
        "permission": { "bash": "allow" },
      }`);
      process.env.XDG_CONFIG_HOME = home;
      delete process.env.OPENCODE_CONFIG;
      expect(readOpenCodeUserConfig()).toEqual({
        model: 'custom/default',
        provider: { custom: { models: { 'owned/model': {} } } },
      });
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
      if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG; else process.env.OPENCODE_CONFIG = previousConfig;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('OpenCode: an explicit config replaces the global one instead of merging with it', () => {
    const home = mkdtempSync(join(tmpdir(), 'opencode-explicit-config-'));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    const previousConfig = process.env.OPENCODE_CONFIG;
    try {
      mkdirSync(join(home, 'opencode'), { recursive: true });
      writeFileSync(join(home, 'opencode', 'opencode.json'), JSON.stringify({
        model: 'global/model',
        provider: { global: { models: { 'global/model': {} } } },
      }));
      process.env.XDG_CONFIG_HOME = home;

      // A partial explicit config keeps no field from the global one: the CLI's
      // own default model is used, exactly as before the shared reader existed.
      const partial = join(home, 'partial.json');
      writeFileSync(partial, JSON.stringify({
        provider: { explicit: { models: { 'explicit/model': {} } } },
      }));
      process.env.OPENCODE_CONFIG = partial;
      expect(readOpenCodeUserConfig()).toEqual({
        provider: { explicit: { models: { 'explicit/model': {} } } },
      });

      // A model-only explicit config keeps no provider from the global one.
      const modelOnly = join(home, 'model-only.json');
      writeFileSync(modelOnly, JSON.stringify({ model: 'explicit/model' }));
      process.env.OPENCODE_CONFIG = modelOnly;
      expect(readOpenCodeUserConfig()).toEqual({ model: 'explicit/model' });

      // A readable but empty explicit config isolates the global one too.
      const empty = join(home, 'empty.json');
      writeFileSync(empty, '{}');
      process.env.OPENCODE_CONFIG = empty;
      expect(readOpenCodeUserConfig()).toEqual({});
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
      if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG; else process.env.OPENCODE_CONFIG = previousConfig;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('OpenCode: an error event fails the run even when the CLI exits 0', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-opencode-error-'));
    const calls: SpawnCall[] = [];
    try {
      const result = await runTask(task(cwd), {
        detect: async () => agents('opencode'), query: neverQuery, spawn: fakeOpenCodeCli('opencode v2.3.2', calls, call => {
          call.child.stdout.emit('data', `${JSON.stringify({ type: 'error', error: { message: 'session cancelled' } })}\n`);
          call.child.emit('close', 0);
        }), buildEnv: env,
      });
      expect(result.state).toBe('failed');
      expect(result.attempts[0].error).toContain('opencode failed: session cancelled');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('OpenCode: output past the capture cap fails the run instead of accepting surviving text', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-opencode-cap-'));
    const calls: SpawnCall[] = [];
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      // One event over the cap: its middle is dropped, so the old path could not
      // parse that line and answered with whatever came after. The truncation
      // flag must fail the run before that parse.
      const piece = 'x'.repeat(1024 * 1024);
      const result = await runTask(task(cwd), {
        detect: async () => agents('opencode'), query: neverQuery, spawn: fakeOpenCodeCli('opencode v2.3.2', calls, call => {
          call.child.stdout.emit('data', '{"type":"text","part":{"text":"');
          for (let printed = 0; printed <= MAX_STREAM_CHARS; printed += piece.length) call.child.stdout.emit('data', piece);
          call.child.stdout.emit('data', '"}}\n');
          call.child.stdout.emit('data', `${JSON.stringify({ type: 'text', part: { text: 'surviving tail' } })}\n`);
          call.child.emit('close', 0);
        }), buildEnv: env,
      });
      expect(result.state).toBe('failed');
      expect(result.attempts[0].error).toBe(cutOutputText('opencode'));
    } finally { warn.mockRestore(); rmSync(cwd, { recursive: true, force: true }); }
  });

  it('Gemini: output past the capture cap fails with the cap named, not as unreadable JSON', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const piece = 'x'.repeat(1024 * 1024);
      const spawnImpl = fakeSpawn([], call => {
        call.child.stdout.emit('data', '{"response":"');
        for (let printed = 0; printed <= MAX_STREAM_CHARS; printed += piece.length) call.child.stdout.emit('data', piece);
        call.child.stdout.emit('data', '","stats":{}}');
        call.child.emit('close', 0);
      });
      const result = await runTask(task('/data'), { detect: async () => agents('gemini'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
      expect(result.state).toBe('failed');
      expect(result.attempts[0].error).toBe(cutOutputText('gemini'));
    } finally { warn.mockRestore(); }
  });


  it('a failed run falls through to the next logged-in agent', async () => {
    const query = (() => (async function* () { yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'quota' }; })()) as never;
    const calls: SpawnCall[] = [];
    const spawnImpl = fakeSpawn(calls, call => {
      if (call.command === CODEX_PATH) { call.child.stderr.emit('data', 'not signed in'); call.child.emit('close', 1); return; }
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

  it('allowedAgents confines the run: a failed agent does not fall through to unallowed ones (#5189)', async () => {
    const query = (() => (async function* () { yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'rate limit' }; })()) as never;
    const calls: SpawnCall[] = [];
    const spawnImpl = fakeSpawn(calls, call => {
      call.child.stdout.emit('data', JSON.stringify({ response: 'fine' }));
      call.child.emit('close', 0);
    });
    const taskWithAllowed: AgentTask = { ...task('/data'), allowedAgents: ['claude-code'] };
    const result = await runTask(taskWithAllowed, { detect: async () => agents('claude-code', 'codex', 'gemini'), query, spawn: spawnImpl, buildEnv: env });
    expect(result.state).toBe('failed');
    expect(result.agent).toBe('claude-code');
    expect(result.attempts.map(attempt => attempt.agent)).toEqual(['claude-code']);
    expect(result.error).toMatch(/^Claude Code: .*rate limit/);
    expect(calls).toEqual([]);
  });

  it('allowedAgents reports waiting-for-agent when none of the allowed agents are available (#5189)', async () => {
    const taskWithAllowed: AgentTask = { ...task('/data'), allowedAgents: ['claude-code'] };
    const result = await runTask(taskWithAllowed, { detect: async () => agents('codex'), query: neverQuery, spawn: fakeSpawn([], () => {}), buildEnv: env });
    expect(result.state).toBe('waiting-for-agent');
    expect(result.agent).toBeNull();
    expect(result.error).toBe('None of the allowed agents (Claude Code) is logged in on this computer.');
  });

  it('an empty allowedAgents list runs nothing and never detects agents (#5189: CLAUDE_MEM_WORK_VIEW_AGENT=off)', async () => {
    let detectCalls = 0;
    const result = await runTask({ ...task('/data'), allowedAgents: [] }, {
      detect: async () => { detectCalls++; return agents('claude-code', 'codex'); }, query: neverQuery, spawn: fakeSpawn([], () => {}), buildEnv: env,
    });
    expect(result).toEqual({ state: 'waiting-for-agent', agent: null, result: null, error: 'No agent is allowed to run this task.', attempts: [] });
    expect(detectCalls).toBe(0);
  });

  it('stayOnFirstUsableAgent: a Claude Code session limit is not handed to Codex (#5189)', async () => {
    const query = (() => (async function* () { yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your session limit" }; })()) as never;
    const calls: SpawnCall[] = [];
    const spawnImpl = fakeSpawn(calls, call => { call.child.emit('close', 0); });
    const result = await runTask({ ...task('/data'), stayOnFirstUsableAgent: true }, { detect: async () => agents('claude-code', 'codex', 'gemini'), query, spawn: spawnImpl, buildEnv: env });
    expect(result).toMatchObject({ state: 'failed', agent: 'claude-code' });
    expect(result.attempts.map(attempt => attempt.agent)).toEqual(['claude-code']);
    expect(calls).toEqual([]);
  });

  it('stayOnFirstUsableAgent still runs the only logged-in agent, whichever it is', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-stay-first-'));
    try {
      const calls: SpawnCall[] = [];
      const spawnImpl = fakeSpawn(calls, call => { writeFileSync(call.args[call.args.indexOf('-o') + 1], '{"ok":true}'); call.child.emit('close', 0); });
      const result = await runTask({ ...task(cwd), stayOnFirstUsableAgent: true }, { detect: async () => agents('codex'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
      expect(result).toMatchObject({ state: 'ok', agent: 'codex' });
      expect(calls.map(call => call.command)).toEqual([CODEX_PATH]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('an answer claude-mem refused is not handed to another agent (#5189: a too-long Claude review ran on the owner\'s Codex)', async () => {
    const query = (() => (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: '{"narrative":"far too long"}' }; })()) as never;
    const calls: SpawnCall[] = [];
    const spawnImpl = fakeSpawn(calls, call => { call.child.stdout.emit('data', JSON.stringify({ response: 'fine' })); call.child.emit('close', 0); });
    const refusing: AgentTask = {
      ...task('/data'),
      run: async ask => {
        await ask('review these groups', {});
        throw Object.assign(new Error('reviews: g_1: narrative is 1467 characters; it must be 1–1200.'), { answerRefused: true });
      },
    };
    const result = await runTask(refusing, { detect: async () => agents('claude-code', 'codex', 'gemini'), query, spawn: spawnImpl, buildEnv: env });
    expect(result).toMatchObject({ state: 'failed', agent: 'claude-code' });
    expect(result.attempts.map(attempt => attempt.agent)).toEqual(['claude-code']);
    expect(result.error).toMatch(/^Claude Code: reviews: g_1: narrative is 1467 characters/);
    expect(calls).toEqual([]);
  });

  it('when every agent fails, the error names each one\'s failure in the order tried', async () => {
    const query = (() => (async function* () { yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'narrative is 22000 characters' }; })()) as never;
    const spawnImpl = fakeSpawn([], call => {
      if (call.command === CODEX_PATH) { call.child.stderr.emit('data', 'story refused'); call.child.emit('close', 1); return; }
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
        if (call.command === CODEX_PATH) { writeFileSync(call.args[call.args.indexOf('-o') + 1], 'ok'); call.child.emit('close', 0); return; }
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
    jest.useFakeTimers();
    try {
      const started = Date.now();
      const pending = runTask(task('/data'), { detect: async () => agents('gemini'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
      await new Promise<void>(resolve => setImmediate(resolve));
      jest.advanceTimersByTime(1_500);
      const result = await pending;
      expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
      expect(result.state).toBe('ok');
      expect(calls[0].child.killed).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('agent runner: a task\'s preferred agent (#5435)', () => {
  it('runs on the preferred agent first, not the first in detect order', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-preferred-'));
    try {
      const calls: SpawnCall[] = [];
      const spawnImpl = fakeSpawn(calls, call => { writeFileSync(call.args[call.args.indexOf('-o') + 1], '{"ok":true}'); call.child.emit('close', 0); });
      const preferred: AgentTask = { ...task(cwd), preferredAgent: 'codex' };
      const result = await runTask(preferred, { detect: async () => agents('claude-code', 'codex'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
      expect(result).toEqual({ state: 'ok', agent: 'codex', result: 'inline done: {"ok":true}', error: null, attempts: [] });
      expect(calls.map(call => call.command)).toEqual([CODEX_PATH]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('a preferred agent that is not logged in leaves the detect order in charge', async () => {
    const query = ((input: any) => (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' }; })()) as never;
    const preferred: AgentTask = { ...task('/data'), preferredAgent: 'codex' };
    const result = await runTask(preferred, { detect: async () => agents('claude-code', 'gemini'), query, spawn: fakeSpawn([], () => {}), buildEnv: env });
    expect(result).toMatchObject({ state: 'ok', agent: 'claude-code', attempts: [] });
  });

  it('when the preferred agent\'s run fails, the next agent in detect order is tried', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-preferred-fail-'));
    try {
      const calls: SpawnCall[] = [];
      const spawnImpl = fakeSpawn(calls, call => {
        if (call.command === CODEX_PATH) { call.child.stderr.emit('data', 'not signed in'); call.child.emit('close', 1); return; }
        call.child.stdout.emit('data', JSON.stringify({ response: 'fine' }));
        call.child.emit('close', 0);
      });
      const preferred: AgentTask = { ...task(cwd), preferredAgent: 'codex' };
      const result = await runTask(preferred, { detect: async () => agents('codex', 'gemini'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
      expect(result).toMatchObject({ state: 'ok', agent: 'gemini' });
      expect(result.attempts.map(attempt => attempt.agent)).toEqual(['codex']);
      expect(calls.map(call => call.command)).toEqual([CODEX_PATH, '/bin/gemini']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('an answer refused on the preferred agent is not handed to another agent (#5189)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agent-runner-preferred-refused-'));
    try {
      const calls: SpawnCall[] = [];
      const spawnImpl = fakeSpawn(calls, call => { writeFileSync(call.args[call.args.indexOf('-o') + 1], '{"ok":true}'); call.child.emit('close', 0); });
      const refusing: AgentTask = {
        ...task(cwd),
        preferredAgent: 'codex',
        run: async ask => {
          await ask('review these groups', {});
          throw Object.assign(new Error('reviews: g_1: narrative is too long.'), { answerRefused: true });
        },
      };
      const result = await runTask(refusing, { detect: async () => agents('codex', 'gemini'), query: neverQuery, spawn: spawnImpl, buildEnv: env });
      expect(result).toMatchObject({ state: 'failed', agent: 'codex' });
      expect(result.attempts.map(attempt => attempt.agent)).toEqual(['codex']);
      expect(calls.map(call => call.command)).toEqual([CODEX_PATH]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
