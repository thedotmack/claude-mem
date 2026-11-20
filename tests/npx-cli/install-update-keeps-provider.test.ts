// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { USER_SETTINGS_PATH } from '../../src/shared/paths.js';
import { promptProvider, validateNonInteractiveProvider, type InstallOptions } from '../../src/npx-cli/commands/install.js';
import { createInstallSummary, InstallAbortError } from '../../src/npx-cli/install/error-reporter.js';

// `npx claude-mem update` runs the install command with no options, and an
// agent shell has no TTY (nor does bun test). These tests drive the provider
// step that update runs, validateNonInteractiveProvider then promptProvider,
// against a real settings.json.
//
// Wave 3 gate R4-1: openai-compatible (#3942) was missing from the keep-list,
// so update defaulted it to claude, and the claude branch rewrote settings.json
// with the account, gateway and sync settings blanked.
// R4-8: a rotation pool with the single key left empty (#3941, documented)
// aborted the update.

const ACCOUNT_SETTINGS = {
  CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1',
  CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_0123456789abcdef01234567',
  CLAUDE_MEM_OPENROUTER_MODEL: 'cmem-observer',
  CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'sync-token',
  CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user-1',
  CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.example.test',
  CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'device-1',
};

const ENV_KEYS = [
  'CLAUDE_MEM_ENV_FILE',
  'CLAUDE_MEM_GEMINI_API_KEY', 'CLAUDE_MEM_GEMINI_API_KEYS',
  'CLAUDE_MEM_OPENROUTER_API_KEY', 'CLAUDE_MEM_OPENROUTER_API_KEYS', 'CLAUDE_MEM_OPENROUTER_BASE_URL',
];

/** The provider step of `npx claude-mem update`. */
async function runUpdateProviderStep(): Promise<{ provider: string; options: InstallOptions }> {
  const options: InstallOptions = {};
  validateNonInteractiveProvider(options, createInstallSummary());
  const provider = await promptProvider(options, null, '0.0.0-test');
  return { provider, options };
}

function writeSettings(settings: Record<string, unknown>): string {
  mkdirSync(dirname(USER_SETTINGS_PATH), { recursive: true });
  const text = JSON.stringify(settings, null, 2);
  writeFileSync(USER_SETTINGS_PATH, text);
  return text;
}

describe('npx claude-mem update keeps the configured provider', () => {
  let priorSettings: string | undefined;
  let savedEnv: Record<string, string | undefined>;
  let envDir: string;

  beforeEach(() => {
    priorSettings = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf-8') : undefined;
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    envDir = mkdtempSync(join(tmpdir(), 'claude-mem-update-env-'));
    process.env.CLAUDE_MEM_ENV_FILE = join(envDir, '.env');
  });

  afterEach(() => {
    if (priorSettings === undefined) rmSync(USER_SETTINGS_PATH, { force: true });
    else writeFileSync(USER_SETTINGS_PATH, priorSettings, 'utf-8');
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(envDir, { recursive: true, force: true });
  });

  it('keeps openai-compatible and leaves the account, gateway and sync settings untouched', async () => {
    const before = writeSettings({
      ...ACCOUNT_SETTINGS,
      CLAUDE_MEM_PROVIDER: 'openai-compatible',
      CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'nvidia-nim',
      CLAUDE_MEM_OPENAI_COMPAT_API_KEY: 'nvapi-test',
    });

    const { provider, options } = await runUpdateProviderStep();

    expect(provider).toBe('openai-compatible');
    expect(options.providerSource).toBe('persisted');
    expect(readFileSync(USER_SETTINGS_PATH, 'utf-8')).toBe(before);
    expect(existsSync(process.env.CLAUDE_MEM_ENV_FILE!)).toBe(false);
  });

  it('keeps openai-compatible without a key: a local server may take none', async () => {
    const before = writeSettings({
      CLAUDE_MEM_PROVIDER: 'openai-compatible',
      CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'ollama',
    });

    const { provider } = await runUpdateProviderStep();

    expect(provider).toBe('openai-compatible');
    expect(readFileSync(USER_SETTINGS_PATH, 'utf-8')).toBe(before);
  });

  it('keeps a gateway account untouched', async () => {
    const before = writeSettings({ ...ACCOUNT_SETTINGS, CLAUDE_MEM_PROVIDER: 'openrouter' });

    const { provider } = await runUpdateProviderStep();

    expect(provider).toBe('openrouter');
    expect(readFileSync(USER_SETTINGS_PATH, 'utf-8')).toBe(before);
  });

  it('keeps codex, which signs in with its own login', async () => {
    writeSettings({ ...ACCOUNT_SETTINGS, CLAUDE_MEM_PROVIDER: 'codex' });
    expect((await runUpdateProviderStep()).provider).toBe('codex');
  });

  for (const [provider, poolKey] of [
    ['gemini', 'CLAUDE_MEM_GEMINI_API_KEYS'],
    ['openrouter', 'CLAUDE_MEM_OPENROUTER_API_KEYS'],
  ] as const) {
    it(`keeps ${provider} whose keys are all in the rotation pool`, async () => {
      const before = writeSettings({ ...ACCOUNT_SETTINGS, CLAUDE_MEM_OPENROUTER_BASE_URL: '', CLAUDE_MEM_OPENROUTER_API_KEY: '', CLAUDE_MEM_PROVIDER: provider, [poolKey]: 'key-one\nkey-two' });

      const { provider: kept } = await runUpdateProviderStep();

      expect(kept).toBe(provider);
      expect(readFileSync(USER_SETTINGS_PATH, 'utf-8')).toBe(before);
    });
  }

  it('counts a pool kept in ~/.claude-mem/.env, as the worker does', async () => {
    writeFileSync(process.env.CLAUDE_MEM_ENV_FILE!, 'GEMINI_API_KEYS=key-one,key-two\n');
    writeSettings({ CLAUDE_MEM_PROVIDER: 'gemini' });

    expect((await runUpdateProviderStep()).provider).toBe('gemini');
  });

  it('counts a single key exported in the environment', async () => {
    process.env.CLAUDE_MEM_GEMINI_API_KEY = 'AIza-exported';
    writeSettings({ CLAUDE_MEM_PROVIDER: 'gemini' });

    expect((await runUpdateProviderStep()).provider).toBe('gemini');
  });

  it('still refuses a personal provider with no key anywhere', async () => {
    const before = writeSettings({ CLAUDE_MEM_PROVIDER: 'gemini' });

    await expect(runUpdateProviderStep()).rejects.toBeInstanceOf(InstallAbortError);
    expect(readFileSync(USER_SETTINGS_PATH, 'utf-8')).toBe(before);
  });

  it('holds the gateway to its saved key: an exported key or a pool does not count', async () => {
    writeSettings({
      ...ACCOUNT_SETTINGS,
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_API_KEY: '',
      CLAUDE_MEM_OPENROUTER_API_KEYS: 'sk-or-v1-personal',
    });
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-or-v1-exported';

    await expect(runUpdateProviderStep()).rejects.toBeInstanceOf(InstallAbortError);
  });

  it('counts an exported key once an exported base URL moves off the gateway', async () => {
    writeSettings({ ...ACCOUNT_SETTINGS, CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEY: '' });
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.CLAUDE_MEM_OPENROUTER_API_KEY = 'sk-or-v1-exported';

    expect((await runUpdateProviderStep()).provider).toBe('openrouter');
  });
});
