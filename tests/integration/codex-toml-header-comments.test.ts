import { expect, it } from 'bun:test';
import { setTomlFeatureEnabled, setTomlPluginEnabled, removeLegacyCodexMcpSearchConfig } from '../../src/services/integrations/CodexCliInstaller.js';

it('updates an existing commented features table without duplicating it', () => {
  const input = '[features] # existing operator config\nhooks = false\nother = true\n';
  const output = setTomlFeatureEnabled(input, 'hooks', true);
  expect(Bun.TOML.parse(output)).toEqual({ features: { hooks: true, other: true } });
});

it('updates an existing commented plugin table and keeps hashes inside quoted IDs', () => {
  const input = '[plugins."fixture#plugin"] # configured seat\nenabled = false\n';
  const output = setTomlPluginEnabled(input, 'fixture#plugin', true);
  expect(Bun.TOML.parse(output)).toEqual({ plugins: { 'fixture#plugin': { enabled: true } } });
});

it('removes a commented legacy claude-mem server table', () => {
  const input = '[mcp_servers."mcp-search"] # installed legacy server\ncommand = "bun"\nargs = ["claude-mem/mcp-server.cjs"]\n[mcp_servers.other] # unrelated\ncommand = "other-server"\n';
  const output = removeLegacyCodexMcpSearchConfig(input);
  expect(Bun.TOML.parse(output)).toEqual({ mcp_servers: { other: { command: 'other-server' } } });
});

it('preserves a commented sibling table while removing the legacy table', () => {
  const input = '[mcp_servers."mcp-search"]\nargs = ["claude-mem/mcp-server.cjs"]\n[mcp_servers.other] # unrelated\ncommand = "other-server"\n';
  expect(Bun.TOML.parse(removeLegacyCodexMcpSearchConfig(input))).toEqual({ mcp_servers: { other: { command: 'other-server' } } });
});
