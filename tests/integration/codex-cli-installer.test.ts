import { describe, expect, it } from 'bun:test';
import {
  isStaleLocalMarketplace,
  readRegisteredMarketplace,
  removeLegacyCodexMcpSearchConfig,
  setTomlFeatureEnabled,
  setTomlPluginEnabled,
  stableMarketplaceRoot,
} from '../../src/services/integrations/CodexCliInstaller.js';

describe('Codex marketplace staleness detection', () => {
  const CONFIG = [
    '[marketplaces.claude-mem-local]',
    'last_updated = "2026-06-24T23:24:37Z"',
    'source_type = "local"',
    'source = "/gone/worktrees/night-parsnip"',
    '',
    '[marketplaces.openai-bundled]',
    'source_type = "local"',
    'source = "/present/openai-bundled"',
    '',
  ].join('\n');

  it('reads the registered source and source_type for a marketplace', () => {
    expect(readRegisteredMarketplace(CONFIG, 'claude-mem-local')).toEqual({
      source: '/gone/worktrees/night-parsnip',
      sourceType: 'local',
    });
  });

  it('does not bleed into the next marketplace section', () => {
    expect(readRegisteredMarketplace(CONFIG, 'openai-bundled')).toEqual({
      source: '/present/openai-bundled',
      sourceType: 'local',
    });
  });

  it('returns null when the marketplace is not registered', () => {
    expect(readRegisteredMarketplace(CONFIG, 'never-added')).toBeNull();
  });

  it('reads a quoted marketplace header', () => {
    const quoted = '[marketplaces."claude-mem-local"]\nsource = "/somewhere"\n';
    expect(readRegisteredMarketplace(quoted, 'claude-mem-local')?.source).toBe('/somewhere');
  });

  it('flags a local source whose directory is gone', () => {
    const entry = readRegisteredMarketplace(CONFIG, 'claude-mem-local');
    expect(isStaleLocalMarketplace(entry, () => false)).toBe(true);
  });

  it('leaves a healthy local source alone', () => {
    const entry = readRegisteredMarketplace(CONFIG, 'claude-mem-local');
    expect(isStaleLocalMarketplace(entry, () => true)).toBe(false);
  });

  it('never treats a git source as stale', () => {
    // Git/npm sources are fetched into a cache, so their `source` is a URL that
    // will never exist on disk — removing them would break a working install.
    const gitConfig = [
      '[marketplaces.claude-mem-local]',
      'source_type = "git"',
      'source = "https://github.com/thedotmack/claude-mem.git"',
      '',
    ].join('\n');
    const entry = readRegisteredMarketplace(gitConfig, 'claude-mem-local');

    expect(isStaleLocalMarketplace(entry, () => false)).toBe(false);
  });

  it('is a no-op when the marketplace is absent or sourceless', () => {
    expect(isStaleLocalMarketplace(null, () => false)).toBe(false);
    expect(isStaleLocalMarketplace({ source: null, sourceType: 'local' }, () => false)).toBe(false);
  });

  it('resolves the stable marketplace root under the Claude config directory', () => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude-config';
    try {
      expect(stableMarketplaceRoot()).toBe('/tmp/claude-config/plugins/marketplaces/thedotmack');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
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
});
