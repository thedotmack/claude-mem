import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import type { spawn } from 'child_process';
import { join } from 'node:path';
import {
  detectUsableAgents,
  GEMINI_NO_MCP_SERVERS,
  runCommand,
  type AgentDetectionDependencies,
  type UsableAgent,
} from '../../../src/services/agent-runner/detect.js';
import type { OAuthTokenResult } from '../../../src/shared/oauth-token.js';

type ScriptedOutcome =
  | { exitCode: number; stdout?: string; stderr?: string }
  | { exitCode: number; stdout?: string; stderr?: string; delayMs: number }
  | { spawnError: string };

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
}

/** A fake `spawn` that answers from a script keyed by "command arg arg". */
function fakeSpawn(script: Record<string, ScriptedOutcome>, calls: string[] = []): typeof spawn {
  return ((command: string, args: string[]) => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    const child = new FakeChild();
    const outcome = script[key] ?? { exitCode: 1, stderr: '' };
    const answer = () => {
      if ('spawnError' in outcome) {
        child.emit('error', Object.assign(new Error(outcome.spawnError), { code: 'ENOENT' }));
        return;
      }
      if (outcome.stdout) child.stdout.emit('data', outcome.stdout);
      if (outcome.stderr) child.stderr.emit('data', outcome.stderr);
      child.emit('close', outcome.exitCode);
    };
    if ('delayMs' in outcome) setTimeout(answer, outcome.delayMs);
    else queueMicrotask(answer);
    return child;
  }) as unknown as typeof spawn;
}

const HOME = '/home/tester';
const CLAUDE_PATH = '/usr/local/bin/claude';
const CODEX_PATH = '/usr/local/bin/codex';
const GEMINI_PATH = '/usr/local/bin/gemini';

const WHICH_CODEX = { 'which codex': { exitCode: 0, stdout: `${CODEX_PATH}\n` } };
const WHICH_GEMINI = { 'which gemini': { exitCode: 0, stdout: `${GEMINI_PATH}\n` } };

function dependencies(overrides: Partial<AgentDetectionDependencies>): Partial<AgentDetectionDependencies> {
  return {
    spawn: fakeSpawn({}),
    findClaudeExecutable: () => {
      throw new Error('Claude executable not found.');
    },
    readClaudeOAuthToken: async (): Promise<OAuthTokenResult> => ({ kind: 'absent', reason: 'no credential' }),
    hasAnthropicApiKey: () => false,
    hasAnthropicAuthToken: () => false,
    fileExists: () => false,
    readTextFile: () => {
      throw new Error('ENOENT');
    },
    environment: {},
    homeDirectory: () => HOME,
    platform: () => 'darwin',
    now: () => 1_000_000,
    geminiAccountChecks: new Map(),
    ...overrides,
  };
}

async function detectOne(id: UsableAgent['id'], overrides: Partial<AgentDetectionDependencies>): Promise<UsableAgent> {
  const agents = await detectUsableAgents(dependencies(overrides));
  const agent = agents.find(candidate => candidate.id === id);
  if (!agent) throw new Error(`no ${id} result`);
  return agent;
}

describe('detectUsableAgents', () => {
  it('reports all three agents in priority order and never throws', async () => {
    const agents = await detectUsableAgents(dependencies({}));
    expect(agents.map(agent => agent.id)).toEqual(['claude-code', 'codex', 'gemini']);
    expect(agents.every(agent => agent.authenticated === false && agent.path === null)).toBe(true);
  });

  describe('Claude Code', () => {
    const installed = { findClaudeExecutable: () => CLAUDE_PATH };

    it('not installed', async () => {
      const agent = await detectOne('claude-code', {});
      expect(agent).toMatchObject({ path: null, authenticated: false });
      expect(agent.reason).toContain('not installed');
    });

    it('installed but logged out', async () => {
      const calls: string[] = [];
      const agent = await detectOne('claude-code', {
        ...installed,
        spawn: fakeSpawn(
          { [`${CLAUDE_PATH} auth status --json`]: { exitCode: 1, stdout: '{"loggedIn": false, "authMethod": "none"}' } },
          calls,
        ),
      });
      expect(agent).toMatchObject({ path: CLAUDE_PATH, authenticated: false });
      expect(agent.reason).toContain('logged out');
      expect(calls).toContain(`${CLAUDE_PATH} auth status --json`);
    });

    it('logged in through a stored OAuth token, without spawning the CLI', async () => {
      const calls: string[] = [];
      const agent = await detectOne('claude-code', {
        ...installed,
        spawn: fakeSpawn({}, calls),
        readClaudeOAuthToken: async () => ({ kind: 'present', token: 'secret', source: 'keychain', expiresAt: 2_000_000 }),
      });
      expect(agent).toMatchObject({ path: CLAUDE_PATH, authenticated: true });
      expect(agent.reason).not.toContain('secret');
      expect(calls.some(call => call.startsWith(CLAUDE_PATH))).toBe(false);
    });

    it('logged in through an API key', async () => {
      const agent = await detectOne('claude-code', { ...installed, hasAnthropicApiKey: () => true });
      expect(agent).toMatchObject({ authenticated: true });
    });

    it('falls back to `claude auth status` when the stored token is expired', async () => {
      const agent = await detectOne('claude-code', {
        ...installed,
        readClaudeOAuthToken: async () => ({ kind: 'expired', reason: 'expired', expiresAt: 10 }),
        spawn: fakeSpawn({
          [`${CLAUDE_PATH} auth status --json`]: { exitCode: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}' },
        }),
      });
      expect(agent).toMatchObject({ authenticated: true });
      expect(agent.reason).toContain('claude.ai');
    });

    it('a slow `claude auth status` is waited for and still reports logged in', async () => {
      const agent = await detectOne('claude-code', {
        ...installed,
        readClaudeOAuthToken: async () => ({ kind: 'absent', reason: 'no keychain access' }),
        spawn: fakeSpawn({
          [`${CLAUDE_PATH} auth status --json`]: { exitCode: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}', delayMs: 3_500 },
        }),
      });
      expect(agent).toMatchObject({ authenticated: true });
      expect(agent.reason).toContain('claude.ai');
    }, 10_000);
  });

  describe('Codex', () => {
    it('not installed', async () => {
      const agent = await detectOne('codex', { spawn: fakeSpawn({ 'which codex': { exitCode: 1 } }) });
      expect(agent).toMatchObject({ path: null, authenticated: false });
      expect(agent.reason).toContain('not installed');
    });

    it('installed but logged out', async () => {
      const agent = await detectOne('codex', {
        spawn: fakeSpawn({ ...WHICH_CODEX, [`${CODEX_PATH} login status`]: { exitCode: 1, stderr: 'Not logged in\n' } }),
      });
      expect(agent).toMatchObject({ path: CODEX_PATH, authenticated: false });
      expect(agent.reason).toContain('Not logged in');
    });

    it('logged in (status line on stderr, as codex-cli prints it)', async () => {
      const agent = await detectOne('codex', {
        spawn: fakeSpawn({ ...WHICH_CODEX, [`${CODEX_PATH} login status`]: { exitCode: 0, stderr: 'Logged in using ChatGPT\n' } }),
      });
      expect(agent).toMatchObject({ path: CODEX_PATH, authenticated: true, reason: 'Logged in using ChatGPT' });
    });

    it('a slow `codex login status` is waited for and still reports logged in', async () => {
      const agent = await detectOne('codex', {
        spawn: fakeSpawn({
          ...WHICH_CODEX,
          [`${CODEX_PATH} login status`]: { exitCode: 0, stderr: 'Logged in using ChatGPT\n', delayMs: 3_500 },
        }),
      });
      expect(agent).toMatchObject({ path: CODEX_PATH, authenticated: true, reason: 'Logged in using ChatGPT' });
    }, 10_000);

    it('uses where.exe on Windows', async () => {
      const calls: string[] = [];
      await detectOne('codex', { platform: () => 'win32', spawn: fakeSpawn({}, calls) });
      expect(calls).toContain(`${join('C:\\Windows', 'System32', 'where.exe')} codex`);
    });
  });

  describe('Gemini', () => {
    const settingsPath = join(HOME, '.gemini', 'settings.json');
    const credentialsPath = join(HOME, '.gemini', 'oauth_creds.json');
    const settings = JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } });

    it('not installed', async () => {
      const agent = await detectOne('gemini', { spawn: fakeSpawn({ 'which gemini': { spawnError: 'spawn which ENOENT' } }) });
      expect(agent).toMatchObject({ path: null, authenticated: false });
      expect(agent.reason).toContain('not installed');
    });

    it('installed but logged out (auth type named, no OAuth credentials)', async () => {
      const agent = await detectOne('gemini', {
        spawn: fakeSpawn(WHICH_GEMINI),
        fileExists: path => path === settingsPath,
        readTextFile: () => settings,
      });
      expect(agent).toMatchObject({ path: GEMINI_PATH, authenticated: false });
      expect(agent.reason).toContain('oauth_creds.json');
    });

    const PROBE = [GEMINI_PATH, '--skip-trust', '-e', 'none', '--allowed-mcp-server-names', GEMINI_NO_MCP_SERVERS, '-o', 'json'].join(' ');
    const NO_INPUT = 'No input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option.\n';
    const INELIGIBLE = 'Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google\n'
      + '    at throwIneligibleOrProjectIdError (file:///gemini/bundle/chunk.js:300912:11)\n  ineligibleTiers: [ { reasonCode: \'UNSUPPORTED_CLIENT\' } ]\n' + NO_INPUT;
    const signedIn = (probe: ScriptedOutcome, credentials = () => JSON.stringify({ refresh_token: 'refresh-1', access_token: 'a' }), calls: string[] = []) => ({
      spawn: fakeSpawn({ ...WHICH_GEMINI, [PROBE]: probe }, calls),
      fileExists: (path: string) => path === settingsPath || path === credentialsPath,
      readTextFile: (path: string) => (path === settingsPath ? settings : credentials()),
    });

    it('usable: the account probe signs in and stops for lack of a prompt (exit 42, no generation)', async () => {
      const calls: string[] = [];
      const agent = await detectOne('gemini', signedIn({ exitCode: 42, stderr: NO_INPUT }, undefined, calls));
      expect(agent).toMatchObject({ path: GEMINI_PATH, authenticated: true });
      expect(agent.reason).toContain('oauth-personal');
      expect(calls).toContain(PROBE);
      expect(calls.join(' ')).not.toMatch(/ -p |--prompt|yolo|bypass/);
    });

    it('ineligible tier: installed, credentials on disk, but Google refuses the account', async () => {
      const agent = await detectOne('gemini', signedIn({ exitCode: 42, stderr: INELIGIBLE }));
      expect(agent).toMatchObject({ path: GEMINI_PATH, authenticated: false });
      expect(agent.reason).toBe("Gemini is installed, but this Google account can't use it: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google");
    });

    it('not logged in: stale credentials whose sign-in fails are reported, not trusted', async () => {
      const agent = await detectOne('gemini', signedIn({ exitCode: 41, stderr: 'Error authenticating: Error: invalid_grant\n' }));
      expect(agent).toMatchObject({ path: GEMINI_PATH, authenticated: false, reason: 'Gemini is installed, but its Google sign-in failed: invalid_grant' });
    });

    it('a probe that exits with another error is not usable', async () => {
      const agent = await detectOne('gemini', signedIn({ exitCode: 1, stderr: 'boom\n' }));
      expect(agent).toMatchObject({ authenticated: false, reason: '`gemini (account check)` exited 1: boom' });
    });

    it('caches the probe per login and probes again when the refresh token changes', async () => {
      const calls: string[] = [];
      let refreshToken = 'refresh-1';
      const geminiAccountChecks = new Map();
      const overrides = { ...signedIn({ exitCode: 42, stderr: NO_INPUT }, () => JSON.stringify({ refresh_token: refreshToken }), calls), geminiAccountChecks };
      const [first, second] = await Promise.all([detectOne('gemini', overrides), detectOne('gemini', overrides)]);
      expect(await detectOne('gemini', overrides)).toEqual(first);
      expect(second).toEqual(first);
      expect(calls.filter(call => call === PROBE)).toHaveLength(1);
      refreshToken = 'refresh-2';
      const relogged = await detectOne('gemini', { ...overrides, spawn: fakeSpawn({ ...WHICH_GEMINI, [PROBE]: { exitCode: 42, stderr: NO_INPUT } }, calls) });
      expect(relogged.authenticated).toBe(true);
      expect(calls.filter(call => call === PROBE)).toHaveLength(2);
      expect([...geminiAccountChecks.keys()].join(' ')).not.toContain('refresh-');
    });

    it('retries a transient failed account probe without requiring a new login', async () => {
      const geminiAccountChecks = new Map();
      const failed = await detectOne('gemini', { ...signedIn({ exitCode: 1, stderr: 'network unavailable' }), geminiAccountChecks });
      expect(failed.authenticated).toBe(false);
      const retry = await detectOne('gemini', { ...signedIn({ exitCode: 42, stderr: NO_INPUT }), geminiAccountChecks });
      expect(retry.authenticated).toBe(true);
    });

    it('logged in through GEMINI_API_KEY', async () => {
      const agent = await detectOne('gemini', { spawn: fakeSpawn(WHICH_GEMINI), environment: { GEMINI_API_KEY: 'key' } });
      expect(agent).toMatchObject({ authenticated: true, reason: 'GEMINI_API_KEY is set' });
    });

    it('a slow `which gemini` is waited for and still reports logged in', async () => {
      const agent = await detectOne('gemini', {
        spawn: fakeSpawn({ 'which gemini': { exitCode: 0, stdout: `${GEMINI_PATH}\n`, delayMs: 3_500 } }),
        environment: { GEMINI_API_KEY: 'key' },
      });
      expect(agent).toMatchObject({ path: GEMINI_PATH, authenticated: true });
    }, 10_000);

    it('unreadable settings.json is reported, not thrown', async () => {
      const agent = await detectOne('gemini', {
        spawn: fakeSpawn(WHICH_GEMINI),
        fileExists: () => true,
        readTextFile: () => '{not json',
      });
      expect(agent.authenticated).toBe(false);
      expect(agent.reason).toContain('unreadable');
    });
  });
});

describe('runCommand', () => {
  it('waits for a slow command to finish instead of giving up', async () => {
    const result = await runCommand(fakeSpawn({ 'codex login status': { exitCode: 0, stderr: 'Logged in', delayMs: 3_500 } }), 'codex', ['login', 'status']);
    expect(result).toMatchObject({ exitCode: 0, stderr: 'Logged in' });
  }, 10_000);

  it('reports a spawn error instead of rejecting', async () => {
    const result = await runCommand(fakeSpawn({ 'nope': { spawnError: 'spawn nope ENOENT' } }), 'nope', []);
    expect(result.spawnError?.message).toContain('ENOENT');
    expect(result.exitCode).toBeNull();
  });

  it('a spawn that throws synchronously is reported, not thrown', async () => {
    const throwingSpawn = (() => {
      throw new Error('EINVAL');
    }) as unknown as typeof spawn;
    const result = await runCommand(throwingSpawn, 'x', []);
    expect(result.spawnError?.message).toBe('EINVAL');
  });
});
