// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import {
  normalizeRuntimeFlag,
  planServerRuntimeInstall,
  planServerRuntimeUninstall,
  buildServerRuntimeMcpConfig,
  SERVER_RUNTIME_SETTINGS_KEYS,
} from '../../src/npx-cli/commands/server-runtime-setup.js';
import { DEFAULT_LOCAL_API_KEY_SCOPES } from '../../src/server/auth/sqlite-api-key-service.js';

describe('server-runtime-setup — install planning (#2543)', () => {
  it('normalizeRuntimeFlag accepts worker/server/server-beta and the default', () => {
    expect(normalizeRuntimeFlag(undefined)).toBe('worker');
    expect(normalizeRuntimeFlag('')).toBe('worker');
    expect(normalizeRuntimeFlag('worker')).toBe('worker');
    expect(normalizeRuntimeFlag('server')).toBe('server-beta');
    expect(normalizeRuntimeFlag('server-beta')).toBe('server-beta');
    expect(normalizeRuntimeFlag('SERVER')).toBe('server-beta');
    expect(normalizeRuntimeFlag('bogus')).toBeNull();
  });

  it('plans server setup with key gen and MCP config targeting the server (not the worker path)', () => {
    const plan = planServerRuntimeInstall({
      serverBaseUrl: 'http://127.0.0.1:37877',
      hasDatabaseUrl: true,
    });

    // Settings flip hooks to the server runtime.
    expect(plan.runtime).toBe('server-beta');
    expect(plan.settings.CLAUDE_MEM_RUNTIME).toBe('server-beta');
    expect(plan.settings.CLAUDE_MEM_SERVER_BETA_URL).toBe('http://127.0.0.1:37877');

    // Docker stack brought up by default.
    expect(plan.bringUpDockerStack).toBe(true);

    // Key gen is planned and uses the SAME default scopes the local routes require.
    expect(plan.generateApiKey).toBe(true);
    expect(plan.apiKeyScopes).toEqual(DEFAULT_LOCAL_API_KEY_SCOPES);

    // MCP config targets the SERVER (http transport at <url>/mcp), not stdio worker.
    expect(plan.injectIdeMcpConfig).toBe(true);
    expect(plan.mcpServerConfig.type).toBe('http');
    expect(plan.mcpServerConfig.url).toBe('http://127.0.0.1:37877/mcp');

    expect(plan.notes).toEqual([]);
  });

  it('skips key gen and notes the operator when no database URL is configured', () => {
    const plan = planServerRuntimeInstall({
      serverBaseUrl: 'http://127.0.0.1:37877',
      hasDatabaseUrl: false,
    });
    expect(plan.generateApiKey).toBe(false);
    expect(plan.notes.some(n => n.includes('server keys rotate'))).toBe(true);
  });

  it('honors an externally-managed stack (no Docker bring-up)', () => {
    const plan = planServerRuntimeInstall({
      serverBaseUrl: 'https://mem.example.com',
      hasDatabaseUrl: true,
      manageDockerStack: false,
    });
    expect(plan.bringUpDockerStack).toBe(false);
    expect(plan.mcpServerConfig.url).toBe('https://mem.example.com/mcp');
  });

  it('fails fast on an empty server base URL', () => {
    expect(() => planServerRuntimeInstall({ serverBaseUrl: '  ', hasDatabaseUrl: true })).toThrow();
  });

  it('buildServerRuntimeMcpConfig normalizes trailing slashes', () => {
    expect(buildServerRuntimeMcpConfig('http://host:1/').url).toBe('http://host:1/mcp');
    expect(buildServerRuntimeMcpConfig('http://host:1///').url).toBe('http://host:1/mcp');
  });
});

describe('server-runtime-setup — uninstall planning / runtime dispatch (#2568)', () => {
  it('worker runtime: no server teardown (worker uninstall unchanged)', () => {
    const plan = planServerRuntimeUninstall({ selectedRuntime: 'worker', dockerStackManaged: true });
    expect(plan.isServerRuntime).toBe(false);
    expect(plan.tearDownDockerStack).toBe(false);
    expect(plan.clearServerSettings).toBe(false);
    expect(plan.settingsKeysToClear).toEqual([]);
  });

  it('server runtime with managed stack: tears down Docker and clears server settings', () => {
    const plan = planServerRuntimeUninstall({ selectedRuntime: 'server-beta', dockerStackManaged: true });
    expect(plan.isServerRuntime).toBe(true);
    expect(plan.tearDownDockerStack).toBe(true);
    expect(plan.clearServerSettings).toBe(true);
    expect(plan.settingsKeysToClear).toEqual(SERVER_RUNTIME_SETTINGS_KEYS);
    expect(plan.settingsKeysToClear).toContain('CLAUDE_MEM_SERVER_BETA_API_KEY');
  });

  it('server runtime with externally-managed stack: clears settings but leaves Docker', () => {
    const plan = planServerRuntimeUninstall({ selectedRuntime: 'server-beta', dockerStackManaged: false });
    expect(plan.isServerRuntime).toBe(true);
    expect(plan.tearDownDockerStack).toBe(false);
    expect(plan.clearServerSettings).toBe(true);
  });
});
