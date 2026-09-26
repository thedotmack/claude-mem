import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promptProvider, validateNonInteractiveProvider, type InstallOptions } from '../../src/npx-cli/commands/install.js';
import { createInstallSummary, InstallAbortError } from '../../src/npx-cli/install/error-reporter.js';
import { CMEM_PRO_BASE_URL } from '../../src/npx-cli/cmem-pro-costs.js';
import { USER_SETTINGS_PATH } from '../../src/shared/paths.js';

const credentialPath = join(dirname(USER_SETTINGS_PATH), '.env');
const envKeys = [
  'CLAUDE_MEM_GEMINI_API_KEY',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'OPENROUTER_BASE_URL',
] as const;

function writeSettings(settings: Record<string, string>): void {
  mkdirSync(dirname(USER_SETTINGS_PATH), { recursive: true });
  writeFileSync(USER_SETTINGS_PATH, JSON.stringify(settings));
}

describe('non-interactive persisted provider validation', () => {
  let previousSettings: string | undefined;
  let previousCredentials: string | undefined;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(() => {
    previousSettings = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf-8') : undefined;
    previousCredentials = existsSync(credentialPath) ? readFileSync(credentialPath, 'utf-8') : undefined;
    previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    rmSync(credentialPath, { force: true });
  });

  afterEach(() => {
    if (previousSettings === undefined) rmSync(USER_SETTINGS_PATH, { force: true });
    else writeFileSync(USER_SETTINGS_PATH, previousSettings);
    if (previousCredentials === undefined) rmSync(credentialPath, { force: true });
    else writeFileSync(credentialPath, previousCredentials);
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  it('keeps Gemini when its only usable key is in the worker credential file', () => {
    writeSettings({ CLAUDE_MEM_PROVIDER: 'gemini' });
    writeFileSync(credentialPath, 'GEMINI_API_KEY=file-gemini-key\n');
    const options: InstallOptions = {};
    validateNonInteractiveProvider(options, createInstallSummary());
    expect(options.provider).toBe('gemini');
    expect(options.providerSource).toBe('persisted');
    expect(readFileSync(USER_SETTINGS_PATH, 'utf-8')).not.toContain('file-gemini-key');
  });

  it('rejects a saved CMEM key detached by a personal endpoint override', () => {
    writeSettings({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: CMEM_PRO_BASE_URL,
      CLAUDE_MEM_OPENROUTER_API_KEY: 'gateway-key',
    });
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';
    const original = readFileSync(USER_SETTINGS_PATH, 'utf-8');
    expect(() => validateNonInteractiveProvider({}, createInstallSummary())).toThrow(InstallAbortError);
    expect(readFileSync(USER_SETTINGS_PATH, 'utf-8')).toBe(original);
  });

  it('accepts a personal credential file key for the detached endpoint', () => {
    writeSettings({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: CMEM_PRO_BASE_URL,
      CLAUDE_MEM_OPENROUTER_API_KEY: 'gateway-key',
    });
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';
    writeFileSync(credentialPath, 'OPENROUTER_API_KEY=personal-key\n');
    const options: InstallOptions = {};
    validateNonInteractiveProvider(options, createInstallSummary());
    expect(options.provider).toBe('openrouter');
    expect(options.providerSource).toBe('persisted');
  });

  it('requires a personal key when --provider openrouter detaches a saved gateway tuple', () => {
    writeSettings({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: CMEM_PRO_BASE_URL,
      CLAUDE_MEM_OPENROUTER_API_KEY: 'gateway-key',
    });
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';
    expect(() => validateNonInteractiveProvider({ provider: 'openrouter' }, createInstallSummary())).toThrow(InstallAbortError);
    writeFileSync(credentialPath, 'OPENROUTER_API_KEY=personal-key\n');
    expect(() => validateNonInteractiveProvider({ provider: 'openrouter' }, createInstallSummary())).not.toThrow();
  });

  it('configures explicit Gemini using only a worker credential-file key', async () => {
    writeSettings({ CLAUDE_MEM_PROVIDER: 'claude' });
    writeFileSync(credentialPath, 'GEMINI_API_KEY=file-gemini-key\n');
    const options: InstallOptions = { provider: 'gemini', providerSource: 'flag' };
    validateNonInteractiveProvider(options, createInstallSummary());
    expect(await promptProvider(options, null, 'test')).toBe('gemini');
    const saved = readFileSync(USER_SETTINGS_PATH, 'utf-8');
    expect(JSON.parse(saved).CLAUDE_MEM_PROVIDER).toBe('gemini');
    expect(saved).not.toContain('file-gemini-key');
  });

  it('configures explicit OpenRouter with a personal file key after detaching a saved gateway', async () => {
    writeSettings({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: CMEM_PRO_BASE_URL,
      CLAUDE_MEM_OPENROUTER_API_KEY: 'gateway-key',
    });
    process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = '';
    writeFileSync(credentialPath, 'OPENROUTER_API_KEY=personal-key\n');
    const options: InstallOptions = { provider: 'openrouter', providerSource: 'flag' };
    validateNonInteractiveProvider(options, createInstallSummary());
    expect(await promptProvider(options, null, 'test')).toBe('openrouter');
    expect(readFileSync(USER_SETTINGS_PATH, 'utf-8')).not.toContain('personal-key');
  });

  it('stops on malformed existing settings without replacing them', () => {
    const malformed = '{"CLAUDE_MEM_PROVIDER":"openrouter"';
    writeFileSync(USER_SETTINGS_PATH, malformed);
    expect(() => validateNonInteractiveProvider({}, createInstallSummary())).toThrow(InstallAbortError);
    expect(() => validateNonInteractiveProvider({ provider: 'claude' }, createInstallSummary())).toThrow(InstallAbortError);
    expect(readFileSync(USER_SETTINGS_PATH, 'utf-8')).toBe(malformed);
  });
});
