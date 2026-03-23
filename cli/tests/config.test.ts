import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

// Config uses process.env and reads ~/.claude-mem/settings.json.
// We test by manipulating env vars, which is safe across test runs.
// The settings file path is ~/. claude-mem/settings.json — in CI that path
// almost certainly does not exist, so defaults are exercised cleanly.

// Import fresh each call by using dynamic import inside tests so env
// changes take effect. However, since Bun caches modules, we instead
// import once and call loadConfig() each time — the function reads
// process.env at call time, so env mutations ARE visible.

import { loadConfig } from '../src/config.ts';
import { homedir } from 'os';
import { join } from 'path';

// Env vars managed by tests
const MANAGED_ENV_KEYS = [
  'CLAUDE_MEM_WORKER_HOST',
  'CLAUDE_MEM_WORKER_PORT',
  'CLAUDE_MEM_DATA_DIR',
] as const;

type ManagedKey = typeof MANAGED_ENV_KEYS[number];

function saveEnv(): Partial<Record<ManagedKey, string | undefined>> {
  const saved: Partial<Record<ManagedKey, string | undefined>> = {};
  for (const key of MANAGED_ENV_KEYS) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreEnv(saved: Partial<Record<ManagedKey, string | undefined>>): void {
  for (const key of MANAGED_ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

// ─── defaults ─────────────────────────────────────────────────────────────

describe('loadConfig — defaults', () => {
  let saved: Partial<Record<ManagedKey, string | undefined>>;

  beforeEach(() => {
    saved = saveEnv();
    // Remove all managed env vars so defaults are used
    for (const key of MANAGED_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it('uses default host 127.0.0.1 when no env var is set', () => {
    const cfg = loadConfig();
    expect(cfg.workerHost).toBe('127.0.0.1');
  });

  it('uses default port 37777 when no env var is set', () => {
    const cfg = loadConfig();
    expect(cfg.workerPort).toBe(37777);
  });

  it('uses default dataDir (~/.claude-mem) when no env var is set', () => {
    const cfg = loadConfig();
    expect(cfg.dataDir).toBe(join(homedir(), '.claude-mem'));
  });

  it('baseUrl is composed from default host and port', () => {
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe('http://127.0.0.1:37777');
  });
});

// ─── env var overrides ────────────────────────────────────────────────────

describe('loadConfig — env var overrides', () => {
  let saved: Partial<Record<ManagedKey, string | undefined>>;

  beforeEach(() => {
    saved = saveEnv();
  });

  afterEach(() => {
    restoreEnv(saved);
  });

  it('uses CLAUDE_MEM_WORKER_HOST when set', () => {
    process.env.CLAUDE_MEM_WORKER_HOST = '0.0.0.0';
    const cfg = loadConfig();
    expect(cfg.workerHost).toBe('0.0.0.0');
  });

  it('uses CLAUDE_MEM_WORKER_PORT when set', () => {
    process.env.CLAUDE_MEM_WORKER_PORT = '9000';
    const cfg = loadConfig();
    expect(cfg.workerPort).toBe(9000);
  });

  it('uses CLAUDE_MEM_DATA_DIR when set', () => {
    process.env.CLAUDE_MEM_DATA_DIR = '/tmp/test-claude-mem';
    const cfg = loadConfig();
    expect(cfg.dataDir).toBe('/tmp/test-claude-mem');
  });

  it('baseUrl reflects env-overridden host and port', () => {
    process.env.CLAUDE_MEM_WORKER_HOST = '192.168.1.5';
    process.env.CLAUDE_MEM_WORKER_PORT = '8888';
    const cfg = loadConfig();
    expect(cfg.baseUrl).toBe('http://192.168.1.5:8888');
  });

  it('env host wins over default when only host is set', () => {
    process.env.CLAUDE_MEM_WORKER_HOST = 'custom-host.local';
    delete process.env.CLAUDE_MEM_WORKER_PORT;
    const cfg = loadConfig();
    expect(cfg.workerHost).toBe('custom-host.local');
    expect(cfg.workerPort).toBe(37777); // port stays default
  });
});

// ─── return shape ─────────────────────────────────────────────────────────

describe('loadConfig — return shape', () => {
  it('always returns an object with all four expected keys', () => {
    const cfg = loadConfig();
    expect(cfg).toHaveProperty('workerHost');
    expect(cfg).toHaveProperty('workerPort');
    expect(cfg).toHaveProperty('baseUrl');
    expect(cfg).toHaveProperty('dataDir');
  });

  it('workerPort is always a number (not a string)', () => {
    const cfg = loadConfig();
    expect(typeof cfg.workerPort).toBe('number');
  });
});
