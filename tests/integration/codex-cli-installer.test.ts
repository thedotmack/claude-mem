import { describe, expect, it } from 'bun:test';
import {
  removeLegacyCodexMcpSearchConfig,
  setTomlFeatureEnabled,
  setTomlPluginEnabled,
} from '../../src/services/integrations/CodexCliInstaller.js';

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

  it('removes stale direct claude-mem mcp-search config', () => {
    const input = [
      'model = "gpt-5.5"',
      '',
      '[mcp_servers.mcp-search]',
      'command = "node"',
      'args = ["/Users/alex/.codex/plugins/cache/claude-mem-local/claude-mem/12.7.5/scripts/mcp-server.cjs"]',
      '',
      '[plugins."claude-mem@claude-mem-local"]',
      'enabled = true',
      '',
    ].join('\n');

    const result = removeLegacyCodexMcpSearchConfig(input);

    expect(result).not.toContain('[mcp_servers.mcp-search]');
    expect(result).not.toContain('12.7.5/scripts/mcp-server.cjs');
    expect(result).toContain('[plugins."claude-mem@claude-mem-local"]');
  });

  it('removes quoted stale claude-mem mcp-search config and child tables', () => {
    const input = [
      '[mcp_servers."mcp-search"]',
      'command = "node"',
      'args = ["/tmp/claude-mem/scripts/mcp-server.cjs"]',
      '',
      '[mcp_servers."mcp-search".env]',
      'CLAUDE_MEM_DATA_DIR = "/tmp/data"',
      '',
      '[mcp_servers.playwright]',
      'command = "npx"',
      '',
    ].join('\n');

    const result = removeLegacyCodexMcpSearchConfig(input);

    expect(result).not.toContain('[mcp_servers."mcp-search"]');
    expect(result).not.toContain('[mcp_servers."mcp-search".env]');
    expect(result).toContain('[mcp_servers.playwright]');
  });

  it('removes unquoted child-table form [mcp_servers.mcp-search.env] for claude-mem', () => {
    const input = [
      '[mcp_servers.mcp-search]',
      'command = "node"',
      'args = ["/Users/alex/.codex/plugins/cache/claude-mem-local/claude-mem/12.7.5/scripts/mcp-server.cjs"]',
      '',
      '[mcp_servers.mcp-search.env]',
      'CLAUDE_MEM_DATA_DIR = "/home/user/.claude-mem"',
      '',
      '[mcp_servers.playwright]',
      'command = "npx"',
      '',
    ].join('\n');

    const result = removeLegacyCodexMcpSearchConfig(input);

    expect(result).not.toContain('[mcp_servers.mcp-search]');
    expect(result).not.toContain('[mcp_servers.mcp-search.env]');
    expect(result).not.toContain('CLAUDE_MEM_DATA_DIR');
    expect(result).toContain('[mcp_servers.playwright]');
  });

  it('preserves unrelated mcp-search config', () => {
    const input = [
      '[mcp_servers.mcp-search]',
      'command = "python"',
      'args = ["search.py"]',
      '',
      '[mcp_servers.playwright]',
      'command = "npx"',
      '',
    ].join('\n');

    const result = removeLegacyCodexMcpSearchConfig(input);

    expect(result).toContain('[mcp_servers.mcp-search]');
    expect(result).toContain('args = ["search.py"]');
    expect(result).toContain('[mcp_servers.playwright]');
  });
});
