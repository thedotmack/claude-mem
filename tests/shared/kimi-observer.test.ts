import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  configureKimiObserver,
  isKimiObserverConfigured,
  removeKimiObserverConfiguration,
  KIMI_OBSERVER_BASE_URL,
  KIMI_OBSERVER_MODEL,
} from '../../src/shared/kimi-observer.js';
import {
  buildIsolatedEnv,
  buildIsolatedEnvWithFreshOAuth,
  loadClaudeMemEnv,
  saveClaudeMemEnv,
} from '../../src/shared/EnvManager.js';

/**
 * Kimi observer provider tests. The .env file is redirected via
 * CLAUDE_MEM_ENV_FILE (resolved lazily by EnvManager) and settings.json is a
 * plain temp path, so neither the real ~/.claude-mem/.env nor the real
 * settings.json is touched.
 */

const TEST_DIR = fs.mkdtempSync(join(tmpdir(), 'kimi-observer-'));
const TEST_ENV_FILE = join(TEST_DIR, '.env');
const TEST_SETTINGS_FILE = join(TEST_DIR, 'settings.json');

const ORIGINAL_ENV_FILE = process.env.CLAUDE_MEM_ENV_FILE;
const ORIGINAL_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

function clearAnthropicProcessEnv(): void {
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
}

beforeEach(() => {
  process.env.CLAUDE_MEM_ENV_FILE = TEST_ENV_FILE;
  for (const file of [TEST_ENV_FILE, TEST_SETTINGS_FILE]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  clearAnthropicProcessEnv();
});

afterAll(() => {
  if (ORIGINAL_ENV_FILE === undefined) {
    delete process.env.CLAUDE_MEM_ENV_FILE;
  } else {
    process.env.CLAUDE_MEM_ENV_FILE = ORIGINAL_ENV_FILE;
  }
  if (ORIGINAL_BASE_URL !== undefined) process.env.ANTHROPIC_BASE_URL = ORIGINAL_BASE_URL;
  if (ORIGINAL_API_KEY !== undefined) process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
  if (ORIGINAL_OAUTH_TOKEN !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = ORIGINAL_OAUTH_TOKEN;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('configureKimiObserver', () => {
  it('writes the Kimi endpoint and API key to the claude-mem .env file', () => {
    configureKimiObserver('sk-kimi-test', TEST_SETTINGS_FILE);

    const env = loadClaudeMemEnv();
    expect(env.ANTHROPIC_BASE_URL).toBe(KIMI_OBSERVER_BASE_URL);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-kimi-test');
  });

  it('pins CLAUDE_MEM_MODEL to kimi-for-coding in settings.json', () => {
    fs.writeFileSync(TEST_SETTINGS_FILE, JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '37777' }));

    configureKimiObserver('sk-kimi-test', TEST_SETTINGS_FILE);

    const settings = JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf-8'));
    expect(settings.CLAUDE_MEM_MODEL).toBe(KIMI_OBSERVER_MODEL);
    expect(settings.CLAUDE_MEM_WORKER_PORT).toBe('37777');
  });

  it('creates settings.json when missing', () => {
    configureKimiObserver('sk-kimi-test', TEST_SETTINGS_FILE);

    const settings = JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf-8'));
    expect(settings.CLAUDE_MEM_MODEL).toBe(KIMI_OBSERVER_MODEL);
  });
});

describe('isolated env passthrough (observer spawn path)', () => {
  it('re-injects the Kimi endpoint credentials from the .env file', () => {
    configureKimiObserver('sk-kimi-test', TEST_SETTINGS_FILE);

    const isolated = buildIsolatedEnv();
    expect(isolated.ANTHROPIC_BASE_URL).toBe(KIMI_OBSERVER_BASE_URL);
    expect(isolated.ANTHROPIC_API_KEY).toBe('sk-kimi-test');
  });

  it('a shell-leaked ANTHROPIC_BASE_URL cannot override the .env value', () => {
    configureKimiObserver('sk-kimi-test', TEST_SETTINGS_FILE);
    process.env.ANTHROPIC_BASE_URL = 'https://evil.example.com/';
    process.env.ANTHROPIC_API_KEY = 'sk-leaked';

    const isolated = buildIsolatedEnv();
    expect(isolated.ANTHROPIC_BASE_URL).toBe(KIMI_OBSERVER_BASE_URL);
    expect(isolated.ANTHROPIC_API_KEY).toBe('sk-kimi-test');
  });

  it('buildIsolatedEnvWithFreshOAuth does not clobber Kimi vars or inject OAuth', async () => {
    configureKimiObserver('sk-kimi-test', TEST_SETTINGS_FILE);

    const isolated = await buildIsolatedEnvWithFreshOAuth();
    expect(isolated.ANTHROPIC_BASE_URL).toBe(KIMI_OBSERVER_BASE_URL);
    expect(isolated.ANTHROPIC_API_KEY).toBe('sk-kimi-test');
    // The custom-gateway branch must short-circuit before the OAuth lookup,
    // so no Anthropic OAuth token is ever sent to the Kimi endpoint.
    expect(isolated.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('isKimiObserverConfigured / removeKimiObserverConfiguration', () => {
  it('reports unconfigured by default', () => {
    expect(isKimiObserverConfigured()).toBe(false);
  });

  it('round-trips: configured after configure, cleared after remove', () => {
    configureKimiObserver('sk-kimi-test', TEST_SETTINGS_FILE);
    expect(isKimiObserverConfigured()).toBe(true);

    expect(removeKimiObserverConfiguration()).toBe(true);
    expect(isKimiObserverConfigured()).toBe(false);

    const env = loadClaudeMemEnv();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('does not remove credentials when BASE_URL was re-pointed elsewhere', () => {
    configureKimiObserver('sk-kimi-test', TEST_SETTINGS_FILE);
    saveClaudeMemEnv({ ANTHROPIC_BASE_URL: 'https://other-gateway.example.com/' });

    expect(removeKimiObserverConfiguration()).toBe(false);
    expect(loadClaudeMemEnv().ANTHROPIC_BASE_URL).toBe('https://other-gateway.example.com/');
  });
});
