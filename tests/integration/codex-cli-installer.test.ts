import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  installCodexPluginCache,
  removeLegacyCodexMcpSearchConfig,
  resolveCodexPluginCacheDirectory,
  setTomlFeatureEnabled,
  setTomlPluginEnabled,
} from '../../src/services/integrations/CodexCliInstaller.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Codex CLI installer config repair', () => {
  it('adds claude-mem plugin enablement when missing', () => {
    const result = setTomlPluginEnabled('model = "gpt-5.5"\n', 'claude-mem@claude-mem-local', true);

    expect(result).toContain('[plugins."claude-mem@claude-mem-local"]');
    expect(result).toContain('enabled = true');
  });

  it('updates existing plugin enablement in place', () => {
    const input = [
      '[plugins."claude-mem@thedotmack"]',
      'enabled = true',
      '',
      '[marketplaces.claude-mem-local]',
      'source_type = "git"',
      '',
    ].join('\n');

    const result = setTomlPluginEnabled(input, 'claude-mem@thedotmack', false);

    expect(result).toContain('[plugins."claude-mem@thedotmack"]\nenabled = false');
    expect(result).toContain('[marketplaces.claude-mem-local]');
  });

  it('inserts enabled into an existing plugin section without touching the next section', () => {
    const input = [
      '[plugins."claude-mem@claude-mem-local"]',
      '',
      '[hooks.state]',
      '',
    ].join('\n');

    const result = setTomlPluginEnabled(input, 'claude-mem@claude-mem-local', true);

    expect(result).toContain('[plugins."claude-mem@claude-mem-local"]\nenabled = true\n');
    expect(result).toContain('[hooks.state]');
  });

  it('enables the current Codex hooks feature flag', () => {
    const input = [
      '[features]',
      'shell_snapshot = true',
      '',
      '[plugins."claude-mem@claude-mem-local"]',
      'enabled = true',
      '',
    ].join('\n');

    const result = setTomlFeatureEnabled(input, 'hooks', true);

    expect(result).toContain('[features]\nhooks = true\nshell_snapshot = true');
    expect(result).toContain('[plugins."claude-mem@claude-mem-local"]');
    expect(result).not.toContain('codex_hooks');
  });

  it('removes stale legacy claude-mem mcp-search config', () => {
    const input = [
      'model = "gpt-5.5"',
      '',
      '[mcp_servers.playwright]',
      'command = "npx"',
      '',
      '[mcp_servers.mcp-search]',
      'command = "node"',
      'args = ["/Users/alexnewman/.codex/plugins/cache/claude-mem-local/claude-mem/12.7.5/scripts/mcp-server.cjs"]',
      '',
      '[plugins."claude-mem@claude-mem-local"]',
      'enabled = true',
      '',
    ].join('\n');

    const result = removeLegacyCodexMcpSearchConfig(input);

    expect(result).toContain('[mcp_servers.playwright]');
    expect(result).toContain('[plugins."claude-mem@claude-mem-local"]');
    expect(result).not.toContain('[mcp_servers.mcp-search]');
    expect(result).not.toContain('12.7.5/scripts/mcp-server.cjs');
  });

  it('removes child tables for the stale legacy mcp-search config', () => {
    const input = [
      '[mcp_servers.mcp-search]',
      'command = "node"',
      'args = ["/tmp/claude-mem/scripts/mcp-server.cjs"]',
      '',
      '[mcp_servers.mcp-search.tools.search]',
      'approval_mode = "approve"',
      '',
      '[features]',
      'hooks = true',
      '',
    ].join('\n');

    const result = removeLegacyCodexMcpSearchConfig(input);

    expect(result).not.toContain('mcp-search');
    expect(result).toContain('[features]\nhooks = true');
  });

  it('does not add a leading newline when the stale config starts the file', () => {
    const input = [
      '[mcp_servers.mcp-search]',
      'command = "node"',
      'args = ["/tmp/claude-mem/scripts/mcp-server.cjs"]',
      '',
      '[features]',
      'hooks = true',
      '',
    ].join('\n');

    const result = removeLegacyCodexMcpSearchConfig(input);

    expect(result.startsWith('\n')).toBe(false);
    expect(result).toStartWith('[features]');
  });

  it('preserves non-claude-mem mcp-search config', () => {
    const input = [
      '[mcp_servers.mcp-search]',
      'command = "python"',
      'args = ["server.py"]',
      '',
    ].join('\n');

    expect(removeLegacyCodexMcpSearchConfig(input)).toBe(input);
  });

  it('resolves the Codex cache from the marketplace manifest version', () => {
    const root = join(tmpdir(), `codex-marketplace-${Date.now()}-${Math.random()}`);
    const codexDir = join(root, 'codex-home');
    const manifestDir = join(root, 'plugin', '.codex-plugin');
    tempDirs.push(root);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'plugin.json'), JSON.stringify({ version: '13.9.1+codex.test' }));

    expect(resolveCodexPluginCacheDirectory(root, codexDir)).toBe(
      join(
        codexDir,
        'plugins',
        'cache',
        'claude-mem-local',
        'claude-mem',
        '13.9.1+codex.test',
      ),
    );
  });

  it('installs directly from the local marketplace and provisions its runtime', async () => {
    const root = join(tmpdir(), `codex-marketplace-${Date.now()}-${Math.random()}`);
    const codexDir = join(root, 'codex-home');
    const manifestDir = join(root, 'plugin', '.codex-plugin');
    tempDirs.push(root);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'plugin.json'), JSON.stringify({ version: '13.9.1' }));
    const cacheDir = join(codexDir, 'plugins', 'cache', 'claude-mem-local', 'claude-mem', '13.9.1');
    const commands: string[][] = [];
    const provisioned: string[] = [];

    await installCodexPluginCache(root, {
      codexDir,
      runBestEffort: (args) => {
        commands.push(args);
        // `codex plugin add` creates the plugin cache directory by copying the plugin.
        mkdirSync(cacheDir, { recursive: true });
        return true;
      },
      ensureRuntime: async (targetDir) => {
        provisioned.push(targetDir);
      },
    });

    expect(commands).toEqual([
      ['plugin', 'add', 'claude-mem@claude-mem-local'],
    ]);
    expect(provisioned).toEqual([cacheDir]);
    // The install marker is written only after provisioning succeeds, into the
    // Codex cache dir — a truthful "runtime ready" signal for version-check.js.
    const marker = join(cacheDir, '.install-version');
    expect(existsSync(marker)).toBe(true);
    expect(JSON.parse(readFileSync(marker, 'utf-8')).version).toBe('13.9.1');
  });

  it('fails without provisioning when Codex cannot install the local plugin', async () => {
    const root = join(tmpdir(), `codex-marketplace-${Date.now()}-${Math.random()}`);
    const manifestDir = join(root, 'plugin', '.codex-plugin');
    tempDirs.push(root);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'plugin.json'), JSON.stringify({ version: '13.9.1' }));
    let provisioned = false;

    await expect(installCodexPluginCache(root, {
      runBestEffort: () => false,
      ensureRuntime: async () => {
        provisioned = true;
      },
    })).rejects.toThrow(/cache could not be installed/);
    expect(provisioned).toBe(false);
  });
});
