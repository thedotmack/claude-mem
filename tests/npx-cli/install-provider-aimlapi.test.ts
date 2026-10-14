// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { USER_SETTINGS_PATH } from '../../src/shared/paths.js';
import { promptProvider, type InstallOptions } from '../../src/npx-cli/commands/install.js';

// `npx claude-mem install --provider aimlapi` is an advertised flag
// (src/npx-cli/index.ts), but promptProvider had no aimlapi branch: it fell
// through to a tail that resolved the label to "OpenRouter" and the key
// setting to CLAUDE_MEM_OPENROUTER_API_KEY. So an aimlapi install was asked
// for an "OpenRouter API key", wrote the aimlapi.com key into OpenRouter's
// field, never set CLAUDE_MEM_AIMLAPI_API_KEY — and, with an OpenRouter key
// already present, short-circuited and set no aimlapi key at all while
// reporting provider=aimlapi. These pin each half of that.

const ENV_KEYS = [
  'CLAUDE_MEM_ENV_FILE',
  'CLAUDE_MEM_AIMLAPI_API_KEY',
  'AIMLAPI_API_KEY',
  'CLAUDE_MEM_OPENROUTER_API_KEY', 'CLAUDE_MEM_OPENROUTER_API_KEYS', 'CLAUDE_MEM_OPENROUTER_BASE_URL',
];

function writeSettings(settings: Record<string, unknown>): string {
  mkdirSync(dirname(USER_SETTINGS_PATH), { recursive: true });
  const text = JSON.stringify(settings, null, 2);
  writeFileSync(USER_SETTINGS_PATH, text);
  return text;
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(readFileSync(USER_SETTINGS_PATH, 'utf-8'));
}

describe('npx claude-mem install --provider aimlapi', () => {
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
    envDir = mkdtempSync(join(tmpdir(), 'claude-mem-aimlapi-install-'));
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

  it('accepts an existing aimlapi key and persists provider=aimlapi', async () => {
    writeSettings({ CLAUDE_MEM_AIMLAPI_API_KEY: 'owned-personal-aimlapi-key' });

    const options: InstallOptions = { provider: 'aimlapi' };
    expect(await promptProvider(options, null, '0.0.0-test')).toBe('aimlapi');

    const after = readSettings();
    expect(after.CLAUDE_MEM_PROVIDER).toBe('aimlapi');
    expect(after.CLAUDE_MEM_AIMLAPI_API_KEY).toBe('owned-personal-aimlapi-key');
    expect(after.CLAUDE_MEM_OPENROUTER_API_KEY).toBeUndefined();
  });

  it('does not accept an OpenRouter key in place of an aimlapi one', async () => {
    const before = writeSettings({ CLAUDE_MEM_OPENROUTER_API_KEY: 'owned-personal-openrouter-key' });

    const options: InstallOptions = { provider: 'aimlapi' };
    await expect(promptProvider(options, null, '0.0.0-test')).rejects.toThrow(/AI\/ML API/);

    // The key setting it names is ours, so nothing was persisted and no
    // aimlapi.com key could have landed in OpenRouter's field.
    expect(readFileSync(USER_SETTINGS_PATH, 'utf-8')).toBe(before);
  });

  it('names AI/ML API, not OpenRouter, when the key is missing', async () => {
    writeSettings({});

    const options: InstallOptions = { provider: 'aimlapi' };
    await expect(promptProvider(options, null, '0.0.0-test')).rejects.toThrow(
      'Non-interactive AI/ML API configuration is missing a personal API key.',
    );
  });
});
