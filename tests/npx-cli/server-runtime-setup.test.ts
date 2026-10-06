// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeRuntimeFlag } from '../../src/npx-cli/commands/server-runtime-setup.js';

const repoRoot = join(__dirname, '..', '..');

describe('server-runtime-setup — install planning (#2543)', () => {
  it('normalizeRuntimeFlag accepts worker/server/server-beta and the default', () => {
    expect(normalizeRuntimeFlag(undefined)).toBe('worker');
    expect(normalizeRuntimeFlag('')).toBe('worker');
    expect(normalizeRuntimeFlag('worker')).toBe('worker');
    expect(normalizeRuntimeFlag('server')).toBe('server');
    // Phase 1d: legacy literal accepted, normalized to canonical 'server'.
    expect(normalizeRuntimeFlag('server-beta')).toBe('server');
    expect(normalizeRuntimeFlag('SERVER')).toBe('server');
    expect(normalizeRuntimeFlag('bogus')).toBeNull();
  });
});

// #4131 — the help line must describe what `install --runtime server` does.
describe('install --runtime server help text (#4131)', () => {
  const cli = readFileSync(join(repoRoot, 'src/npx-cli/index.ts'), 'utf-8');
  const install = readFileSync(join(repoRoot, 'src/npx-cli/commands/install.ts'), 'utf-8');
  const helpLine = cli.split('\n').find(line => line.includes('install --runtime worker|server'));
  const explanation = helpLine?.match(/\)\}\s{3}(.+)$/)?.[1] ?? '';

  function functionBody(name: string): string {
    const start = install.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    return install.slice(start, install.indexOf('\n}\n', start));
  }

  it('says the Docker stack is printed, not started, because the installer only logs the command', () => {
    const setup = functionBody('setupServerRuntimeNonInteractive');
    expect(setup).toContain('docker compose up -d postgres valkey');
    expect(setup).not.toMatch(/spawn|exec/);

    expect(helpLine).toBeDefined();
    expect(helpLine).not.toContain('brings up Docker');
    expect(helpLine).toContain('prints the docker compose command');
  });

  it('says an API key is provisioned only when CLAUDE_MEM_SERVER_DATABASE_URL is set', () => {
    expect(functionBody('maybeBootstrapServerApiKey')).toContain('if (!process.env.CLAUDE_MEM_SERVER_DATABASE_URL)');

    expect(helpLine).not.toContain('generates an API key');
    expect(explanation).toContain('only when CLAUDE_MEM_SERVER_DATABASE_URL is set');
    expect(explanation).toContain('set CLAUDE_MEM_SERVER_DATABASE_URL before running npx claude-mem server keys rotate');
  });

  it('does not claim to inject the IDE MCP config, which the installer only prints', () => {
    expect(functionBody('setupServerRuntimeNonInteractive')).toContain('IDE MCP config target for the server runtime');

    expect(helpLine).not.toContain('injects the IDE MCP config');
  });
});

// #4131 — the cmem.ai sign-in the reporter hit comes from the provider, not the
// runtime: runInstallCommand runs requireInstallerOAuthLogin whenever
// providerNeedsAccount() is true, unless a non-interactive run keeps the
// provider already in settings.
describe('install --provider help text names the cmem.ai sign-in (#4131)', () => {
  const cli = readFileSync(join(repoRoot, 'src/npx-cli/index.ts'), 'utf-8');
  const helpLine = cli.split('\n').find(line => line.includes("'npx claude-mem install --provider "));
  const explanation = helpLine?.match(/\)\}\s{3}(.+)$/)?.[1] ?? '';

  it('lists the providers that need a cmem.ai account', async () => {
    const { providerNeedsAccount } = await import('../../src/npx-cli/commands/install.js');
    expect(helpLine).toBeDefined();
    expect(explanation).toContain('cmem.ai');

    for (const provider of ['codex', 'gemini', 'openrouter'] as const) {
      expect(providerNeedsAccount(provider)).toBe(true);
      expect(explanation).toContain(provider);
    }
    for (const provider of ['claude', 'host'] as const) {
      expect(providerNeedsAccount(provider)).toBe(false);
    }
    expect(explanation).toContain('claude and host need no account');
  });

  it('says an interactive install without --provider signs in too', async () => {
    const { providerNeedsAccount } = await import('../../src/npx-cli/commands/install.js');
    expect(providerNeedsAccount(undefined)).toBe(true);

    expect(explanation).toContain('interactive install without --provider');
  });
});
