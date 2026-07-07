import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { mergeSettings } from '../src/npx-cli/commands/install.js';
import { persistServerSettings } from '../src/services/hooks/server-bootstrap.js';
import { readFlatSettings } from '../src/npx-cli/utils/settings.js';

describe('settings writes preserve env-nested peers', () => {
  let tempDir: string;
  let userSettingsPath: string;
  let serverSettingsPath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `settings-preservation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    userSettingsPath = join(tempDir, 'user-settings.json');
    serverSettingsPath = join(tempDir, 'server-settings.json');
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(dirname(userSettingsPath), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('installer mergeSettings updates env without dropping top-level peers (#2928)', () => {
    writeFileSync(userSettingsPath, JSON.stringify({
      env: { CLAUDE_MEM_PROVIDER: 'claude' },
      hooks: { SessionStart: [{ command: 'keep-me' }] },
      permissions: { allow: ['Bash(git status)'] },
    }, null, 2));

    expect(mergeSettings({ CLAUDE_MEM_PROVIDER: 'codex' }, userSettingsPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(userSettingsPath, 'utf-8'));
    expect(parsed.env.CLAUDE_MEM_PROVIDER).toBe('codex');
    expect(parsed.hooks.SessionStart[0].command).toBe('keep-me');
    expect(parsed.permissions.allow).toEqual(['Bash(git status)']);
    expect(parsed.CLAUDE_MEM_PROVIDER).toBeUndefined();
  });

  it('installer mergeSettings preserves owner-only mode on existing broad settings files', () => {
    writeFileSync(userSettingsPath, JSON.stringify({ env: { CLAUDE_MEM_PROVIDER: 'claude' } }), { mode: 0o644 });
    if (process.platform !== 'win32') {
      expect(statSync(userSettingsPath).mode & 0o777).toBe(0o644);
    }

    expect(mergeSettings({ CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-test' }, userSettingsPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(userSettingsPath, 'utf-8'));
    expect(parsed.env.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('sk-test');
    if (process.platform !== 'win32') {
      expect(statSync(userSettingsPath).mode & 0o777).toBe(0o600);
    }
  });

  it('flat settings reads strip UTF-8 BOM before parsing', () => {
    writeFileSync(userSettingsPath, `\uFEFF${JSON.stringify({
      env: { CLAUDE_MEM_PROVIDER: 'openrouter' },
    })}`);

    expect(readFlatSettings(userSettingsPath)?.CLAUDE_MEM_PROVIDER).toBe('openrouter');
  });

  it('server API key persistence updates env without dropping top-level peers (#2929)', () => {
    writeFileSync(serverSettingsPath, JSON.stringify({
      env: { CLAUDE_MEM_RUNTIME: 'server' },
      hooks: { PostToolUse: [{ command: 'keep-me-too' }] },
      permissions: { deny: ['WebFetch'] },
    }, null, 2));

    persistServerSettings(serverSettingsPath, {
      apiKey: 'cmem_test',
      projectId: 'project_123',
      serverBaseUrl: 'http://127.0.0.1:37877',
    });

    const parsed = JSON.parse(readFileSync(serverSettingsPath, 'utf-8'));
    expect(parsed.env.CLAUDE_MEM_SERVER_API_KEY).toBe('cmem_test');
    expect(parsed.env.CLAUDE_MEM_SERVER_PROJECT_ID).toBe('project_123');
    expect(parsed.env.CLAUDE_MEM_SERVER_URL).toBe('http://127.0.0.1:37877');
    expect(parsed.hooks.PostToolUse[0].command).toBe('keep-me-too');
    expect(parsed.permissions.deny).toEqual(['WebFetch']);
  });

  it('server API key persistence creates the settings file with owner-only mode', () => {
    persistServerSettings(serverSettingsPath, {
      apiKey: 'cmem_created',
      projectId: 'project_created',
    });

    expect(existsSync(serverSettingsPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(serverSettingsPath).mode & 0o777).toBe(0o600);
    }
  });

  it('server API key persistence tightens existing broad permissions before writing', () => {
    writeFileSync(serverSettingsPath, JSON.stringify({ env: {} }), { mode: 0o644 });
    if (process.platform !== 'win32') {
      expect(statSync(serverSettingsPath).mode & 0o777).toBe(0o644);
    }

    persistServerSettings(serverSettingsPath, {
      apiKey: 'cmem_existing',
      projectId: 'project_existing',
    });

    const parsed = JSON.parse(readFileSync(serverSettingsPath, 'utf-8'));
    expect(parsed.env.CLAUDE_MEM_SERVER_API_KEY).toBe('cmem_existing');
    if (process.platform !== 'win32') {
      expect(statSync(serverSettingsPath).mode & 0o777).toBe(0o600);
    }
  });
});
