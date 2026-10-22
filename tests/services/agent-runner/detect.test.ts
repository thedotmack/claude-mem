import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'events';
import type { spawn } from 'child_process';
import {
  detectUsableAgents,
  runCommandWithTimeout,
  type AgentDetectionDependencies,
  type UsableAgent,
} from '../../../src/services/agent-runner/detect.js';
import type { OAuthTokenResult } from '../../../src/shared/oauth-token.js';

type ScriptedOutcome =
  | { exitCode: number; stdout?: string; stderr?: string }
  | { hang: true }
  | { spawnError: string };

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killedWith: string[] = [];
  kill(signal: string): boolean {
    this.killedWith.push(signal);
    // A real child exits on SIGTERM; emit close like Node does.
    queueMicrotask(() => this.emit('close', null));
    return true;
  }
}

/** A fake `spawn` that answers from a script keyed by "command arg arg". */
function fakeSpawn(script: Record<string, ScriptedOutcome>, calls: string[] = []): typeof spawn {
  return ((command: string, args: string[]) => {
    const key = [command, ...args].join(' ');
    calls.push(key);
    const child = new FakeChild();
    const outcome = script[key] ?? { exitCode: 1, stderr: '' };
    queueMicrotask(() => {
      if ('hang' in outcome) return;
      if ('spawnError' in outcome) {
        child.emit('error', Object.assign(new Error(outcome.spawnError), { code: 'ENOENT' }));
        return;
      }
      if (outcome.stdout) child.stdout.emit('data', outcome.stdout);
      if (outcome.stderr) child.stderr.emit('data', outcome.stderr);
      child.emit('close', outcome.exitCode);
    });
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
    timeoutMs: 50,
    now: () => 1_000_000,
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

    it('timeout', async () => {
      const agent = await detectOne('claude-code', {
        ...installed,
        spawn: fakeSpawn({ [`${CLAUDE_PATH} auth status --json`]: { hang: true } }),
      });
      expect(agent.authenticated).toBe(false);
      expect(agent.reason).toContain('timed out');
    });

    it('a hanging token read is bounded by the check timeout', async () => {
      const agent = await detectOne('claude-code', {
        ...installed,
        readClaudeOAuthToken: () => new Promise<OAuthTokenResult>(() => {}),
      });
      expect(agent.authenticated).toBe(false);
      expect(agent.reason).toContain('timed out');
    });
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

    it('timeout', async () => {
      const agent = await detectOne('codex', {
        spawn: fakeSpawn({ ...WHICH_CODEX, [`${CODEX_PATH} login status`]: { hang: true } }),
      });
      expect(agent.authenticated).toBe(false);
      expect(agent.reason).toContain('timed out');
    });

    it('uses where.exe on Windows', async () => {
      const calls: string[] = [];
      await detectOne('codex', { platform: () => 'win32', spawn: fakeSpawn({}, calls) });
      expect(calls).toContain('where.exe codex');
    });
  });

  describe('Gemini', () => {
    const settingsPath = `${HOME}/.gemini/settings.json`;
    const credentialsPath = `${HOME}/.gemini/oauth_creds.json`;
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

    it('logged in through settings.json + oauth_creds.json', async () => {
      const agent = await detectOne('gemini', {
        spawn: fakeSpawn(WHICH_GEMINI),
        fileExists: path => path === settingsPath || path === credentialsPath,
        readTextFile: path => {
          if (path !== settingsPath) throw new Error(`unexpected read ${path}`);
          return settings;
        },
      });
      expect(agent).toMatchObject({ path: GEMINI_PATH, authenticated: true });
      expect(agent.reason).toContain('oauth-personal');
    });

    it('logged in through GEMINI_API_KEY', async () => {
      const agent = await detectOne('gemini', { spawn: fakeSpawn(WHICH_GEMINI), environment: { GEMINI_API_KEY: 'key' } });
      expect(agent).toMatchObject({ authenticated: true, reason: 'GEMINI_API_KEY is set' });
    });

    it('timeout', async () => {
      const agent = await detectOne('gemini', { spawn: fakeSpawn({ 'which gemini': { hang: true } }) });
      expect(agent.authenticated).toBe(false);
      expect(agent.reason).toContain('timed out');
    });

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

describe('runCommandWithTimeout', () => {
  it('kills a hung child and reports timedOut', async () => {
    const children: FakeChild[] = [];
    const spawnImplementation = (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as unknown as typeof spawn;
    const result = await runCommandWithTimeout(spawnImplementation, 'codex', ['login', 'status'], 20);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(children[0].killedWith).toContain('SIGTERM');
  });

  it('reports a spawn error instead of rejecting', async () => {
    const result = await runCommandWithTimeout(fakeSpawn({ 'nope': { spawnError: 'spawn nope ENOENT' } }), 'nope', [], 50);
    expect(result.spawnError?.message).toContain('ENOENT');
    expect(result.exitCode).toBeNull();
  });

  it('a spawn that throws synchronously is reported, not thrown', async () => {
    const throwingSpawn = (() => {
      throw new Error('EINVAL');
    }) as unknown as typeof spawn;
    const result = await runCommandWithTimeout(throwingSpawn, 'x', [], 50);
    expect(result.spawnError?.message).toBe('EINVAL');
  });
});
