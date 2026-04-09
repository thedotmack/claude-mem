/**
 * Node Identity Module Tests
 *
 * Tests for getNodeName(), getInstanceName(), and getNetworkMode().
 * Verifies env var overrides, settings file fallback, and defaults.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { hostname } from 'os';
import { clearNodeNameCache } from '../../src/shared/node-identity.js';

// Store original env values before any test modifies them
const ENV_KEYS = ['CLAUDE_MEM_NODE_NAME', 'CLAUDE_MEM_INSTANCE_NAME', 'CLAUDE_MEM_NETWORK_MODE', 'CLAUDE_MEM_DATA_DIR'] as const;
type EnvKey = typeof ENV_KEYS[number];

function saveEnv(): Record<EnvKey, string | undefined> {
  const saved = {} as Record<EnvKey, string | undefined>;
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  return saved;
}

function restoreEnv(saved: Record<EnvKey, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

describe('node-identity', () => {
  let savedEnv: Record<EnvKey, string | undefined>;

  afterEach(() => {
    if (savedEnv) restoreEnv(savedEnv);
    clearNodeNameCache();
  });

  // Helper: point DATA_DIR at a non-existent temp path so settings file is never found
  function isolateFromSettingsFile(): void {
    process.env.CLAUDE_MEM_DATA_DIR = '/tmp/node-identity-test-nonexistent-' + Date.now();
  }

  describe('getNodeName', () => {
    it('returns env var when CLAUDE_MEM_NODE_NAME is set', async () => {
      savedEnv = saveEnv();
      isolateFromSettingsFile();
      process.env.CLAUDE_MEM_NODE_NAME = 'test-machine';

      // Dynamic import after env is set so module re-evaluates
      const { getNodeName } = await import('../../src/shared/node-identity.js?v=' + Date.now());
      expect(getNodeName()).toBe('test-machine');
    });

    it('falls back to os.hostname() when env var and settings are absent', async () => {
      savedEnv = saveEnv();
      isolateFromSettingsFile();
      delete process.env.CLAUDE_MEM_NODE_NAME;

      const { getNodeName } = await import('../../src/shared/node-identity.js?v=' + Date.now());
      expect(getNodeName()).toBe(hostname());
    });
  });

  describe('getInstanceName', () => {
    it('returns empty string by default when nothing is set', async () => {
      savedEnv = saveEnv();
      isolateFromSettingsFile();
      delete process.env.CLAUDE_MEM_INSTANCE_NAME;

      const { getInstanceName } = await import('../../src/shared/node-identity.js?v=' + Date.now());
      expect(getInstanceName()).toBe('');
    });

    it('returns env var when CLAUDE_MEM_INSTANCE_NAME is set', async () => {
      savedEnv = saveEnv();
      isolateFromSettingsFile();
      process.env.CLAUDE_MEM_INSTANCE_NAME = 'openclaw-legal';

      const { getInstanceName } = await import('../../src/shared/node-identity.js?v=' + Date.now());
      expect(getInstanceName()).toBe('openclaw-legal');
    });
  });

  describe('getNetworkMode', () => {
    it('returns "standalone" by default when nothing is set', async () => {
      savedEnv = saveEnv();
      isolateFromSettingsFile();
      delete process.env.CLAUDE_MEM_NETWORK_MODE;

      const { getNetworkMode } = await import('../../src/shared/node-identity.js?v=' + Date.now());
      expect(getNetworkMode()).toBe('standalone');
    });

    it('returns "server" when CLAUDE_MEM_NETWORK_MODE=server', async () => {
      savedEnv = saveEnv();
      isolateFromSettingsFile();
      process.env.CLAUDE_MEM_NETWORK_MODE = 'server';

      const { getNetworkMode } = await import('../../src/shared/node-identity.js?v=' + Date.now());
      expect(getNetworkMode()).toBe('server');
    });

    it('returns "client" when CLAUDE_MEM_NETWORK_MODE=client', async () => {
      savedEnv = saveEnv();
      isolateFromSettingsFile();
      process.env.CLAUDE_MEM_NETWORK_MODE = 'client';

      const { getNetworkMode } = await import('../../src/shared/node-identity.js?v=' + Date.now());
      expect(getNetworkMode()).toBe('client');
    });

    it('returns "standalone" for unknown values', async () => {
      savedEnv = saveEnv();
      isolateFromSettingsFile();
      process.env.CLAUDE_MEM_NETWORK_MODE = 'unknown-value';

      const { getNetworkMode } = await import('../../src/shared/node-identity.js?v=' + Date.now());
      expect(getNetworkMode()).toBe('standalone');
    });
  });
});
