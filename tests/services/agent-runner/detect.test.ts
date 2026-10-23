import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import * as realOs from 'os';
import { join } from 'path';
import type { spawn } from 'child_process';
import { setFakeSpawn } from '../../helpers/fake-spawn.js';
import * as realFinder from '../../../src/shared/find-claude-executable.js';
import * as realOAuth from '../../../src/shared/oauth-token.js';
import * as realEnvManager from '../../../src/shared/EnvManager.js';
import type { OAuthTokenResult } from '../../../src/shared/oauth-token.js';

// What a test says about the machine. Each module mock hands calls to the real
// function when the test set nothing, so other test files in this process are unaffected.
interface Machine {
  findClaudeExecutable?: () => string;
  readClaudeOAuthToken?: () => Promise<OAuthTokenResult>;
  hasAnthropicApiKey?: () => boolean;
  hasAnthropicAuthToken?: () => boolean;
}
let machine: Machine | null = null;
const finder = { ...realFinder }, oauth = { ...realOAuth }, envManager = { ...realEnvManager }, os = { ...realOs };
// Bun reads the home folder once, so a test's home is mocked rather than set through HOME.
let home = '';
mock.module('os', () => ({ ...os, homedir: () => (machine ? home : os.homedir()) }));
mock.module('../../../src/shared/find-claude-executable.js', () => ({ ...finder, findClaudeExecutable: (...args: Parameters<typeof finder.findClaudeExecutable>) => machine ? (machine.findClaudeExecutable ?? (() => { throw new Error('Claude executable not found.'); }))() : finder.findClaudeExecutable(...args) }));
mock.module('../../../src/shared/oauth-token.js', () => ({ ...oauth, readClaudeOAuthToken: (...args: Parameters<typeof oauth.readClaudeOAuthToken>) => machine ? (machine.readClaudeOAuthToken ?? (async () => ({ kind: 'absent', reason: 'no credential' }) as OAuthTokenResult))() : oauth.readClaudeOAuthToken(...args) }));
mock.module('../../../src/shared/EnvManager.js', () => ({
  ...envManager,
  hasAnthropicApiKey: () => machine ? machine.hasAnthropicApiKey?.() ?? false : envManager.hasAnthropicApiKey(),
  hasAnthropicAuthToken: () => machine ? machine.hasAnthropicAuthToken?.() ?? false : envManager.hasAnthropicAuthToken(),
}));
const { detectUsableAgents, runCommand } = await import('../../../src/services/agent-runner/detect.js');
const { windowsWhereExecutablePath } = await import('../../../src/shared/spawn.js');
type UsableAgent = Awaited<ReturnType<typeof detectUsableAgents>>[number];

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

const CLAUDE_PATH = '/usr/local/bin/claude';
const CODEX_PATH = '/usr/local/bin/codex';
const GEMINI_PATH = '/usr/local/bin/gemini';

const WHICH_CODEX = { 'which codex': { exitCode: 0, stdout: `${CODEX_PATH}\n` } };
const WHICH_GEMINI = { 'which gemini': { exitCode: 0, stdout: `${GEMINI_PATH}\n` } };

interface Scenario extends Machine {
  spawn?: typeof spawn;
  /** Files under a fresh home folder, by path relative to it. */
  homeFiles?: Record<string, string>;
  geminiApiKey?: string;
  platform?: NodeJS.Platform;
}

const saved = { geminiApiKey: process.env.GEMINI_API_KEY, platform: process.platform };
beforeEach(() => { home = mkdtempSync(join(os.tmpdir(), 'detect-home-')); });
afterEach(() => {
  machine = null;
  setFakeSpawn(null);
  if (saved.geminiApiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.geminiApiKey;
  Object.defineProperty(process, 'platform', { value: saved.platform, configurable: true });
  rmSync(home, { recursive: true, force: true });
});

/** Set up the machine a test describes and run detection on it. */
function detect(scenario: Scenario) {
  machine = scenario;
  setFakeSpawn(scenario.spawn ?? fakeSpawn({}));
  for (const [path, text] of Object.entries(scenario.homeFiles ?? {})) {
    mkdirSync(join(home, path, '..'), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  delete process.env.GEMINI_API_KEY;
  if (scenario.geminiApiKey) process.env.GEMINI_API_KEY = scenario.geminiApiKey;
  if (scenario.platform) Object.defineProperty(process, 'platform', { value: scenario.platform, configurable: true });
  return detectUsableAgents();
}

async function detectOne(id: UsableAgent['id'], scenario: Scenario): Promise<UsableAgent> {
  const agents = await detect(scenario);
  const agent = agents.find(candidate => candidate.id === id);
  if (!agent) throw new Error(`no ${id} result`);
  return agent;
}

describe('detectUsableAgents', () => {
  it('reports all three agents in priority order and never throws', async () => {
    const agents = await detect({});
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
        readClaudeOAuthToken: async () => ({ kind: 'present', token: 'secret', source: 'keychain', expiresAt: Date.now() + 3_600_000 }),
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

    it('uses the system where.exe on Windows, never one from the working folder', async () => {
      const calls: string[] = [];
      await detectOne('codex', { platform: 'win32', spawn: fakeSpawn({}, calls) });
      expect(calls).toContain(`${windowsWhereExecutablePath()} codex`);
    });

    it('on Windows, an npm-installed codex.cmd shim is found and started through cmd.exe', async () => {
      // npm installs an extensionless sh script beside the .cmd shim; where.exe lists it first.
      const bin = mkdtempSync(join(os.tmpdir(), 'detect-npm-bin-'));
      try {
        const script = join(bin, 'codex'), shim = join(bin, 'codex.cmd');
        writeFileSync(script, ''); writeFileSync(shim, '');
        const calls: string[] = [];
        const agent = await detectOne('codex', {
          platform: 'win32',
          spawn: fakeSpawn({
            [`${windowsWhereExecutablePath()} codex`]: { exitCode: 0, stdout: `${script}\r\n${shim}\r\n` },
            [`${process.env.ComSpec ?? 'cmd.exe'} /d /s /c ""${shim}" "login" "status""`]: { exitCode: 0, stderr: 'Logged in using ChatGPT\n' },
          }, calls),
        });
        expect(agent).toMatchObject({ path: shim, authenticated: true, reason: 'Logged in using ChatGPT' });
      } finally { rmSync(bin, { recursive: true, force: true }); }
    });
  });

  describe('Gemini', () => {
    const settings = JSON.stringify({ security: { auth: { selectedType: 'oauth-personal' } } });

    it('not installed', async () => {
      const agent = await detectOne('gemini', { spawn: fakeSpawn({ 'which gemini': { spawnError: 'spawn which ENOENT' } }) });
      expect(agent).toMatchObject({ path: null, authenticated: false });
      expect(agent.reason).toContain('not installed');
    });

    it('installed but logged out (auth type named, no OAuth credentials)', async () => {
      const agent = await detectOne('gemini', {
        spawn: fakeSpawn(WHICH_GEMINI),
        homeFiles: { '.gemini/settings.json': settings },
      });
      expect(agent).toMatchObject({ path: GEMINI_PATH, authenticated: false });
      expect(agent.reason).toContain('oauth_creds.json');
    });

    it('logged in through settings.json + oauth_creds.json', async () => {
      const agent = await detectOne('gemini', {
        spawn: fakeSpawn(WHICH_GEMINI),
        homeFiles: { '.gemini/settings.json': settings, '.gemini/oauth_creds.json': '{}' },
      });
      expect(agent).toMatchObject({ path: GEMINI_PATH, authenticated: true });
      expect(agent.reason).toContain('oauth-personal');
    });

    it('logged in through GEMINI_API_KEY', async () => {
      const agent = await detectOne('gemini', { spawn: fakeSpawn(WHICH_GEMINI), geminiApiKey: 'key' });
      expect(agent).toMatchObject({ authenticated: true, reason: 'GEMINI_API_KEY is set' });
    });

    it('a slow `which gemini` is waited for and still reports logged in', async () => {
      const agent = await detectOne('gemini', {
        spawn: fakeSpawn({ 'which gemini': { exitCode: 0, stdout: `${GEMINI_PATH}\n`, delayMs: 3_500 } }),
        geminiApiKey: 'key',
      });
      expect(agent).toMatchObject({ path: GEMINI_PATH, authenticated: true });
    }, 10_000);

    it('unreadable settings.json is reported, not thrown', async () => {
      const agent = await detectOne('gemini', {
        spawn: fakeSpawn(WHICH_GEMINI),
        homeFiles: { '.gemini/settings.json': '{not json', '.gemini/oauth_creds.json': '{}' },
      });
      expect(agent.authenticated).toBe(false);
      expect(agent.reason).toContain('unreadable');
    });
  });
});

describe('runCommand', () => {
  it('waits for a slow command to finish instead of giving up', async () => {
    setFakeSpawn(fakeSpawn({ 'codex login status': { exitCode: 0, stderr: 'Logged in', delayMs: 3_500 } }));
    const result = await runCommand('codex', ['login', 'status']);
    expect(result).toMatchObject({ exitCode: 0, stderr: 'Logged in' });
  }, 10_000);

  it('reports a spawn error instead of rejecting', async () => {
    setFakeSpawn(fakeSpawn({ 'nope': { spawnError: 'spawn nope ENOENT' } }));
    const result = await runCommand('nope', []);
    expect(result.spawnError?.message).toContain('ENOENT');
    expect(result.exitCode).toBeNull();
  });

  it('a spawn that throws synchronously is reported, not thrown', async () => {
    const throwingSpawn = (() => {
      throw new Error('EINVAL');
    }) as unknown as typeof spawn;
    setFakeSpawn(throwingSpawn);
    const result = await runCommand('x', []);
    expect(result.spawnError?.message).toBe('EINVAL');
  });
});
