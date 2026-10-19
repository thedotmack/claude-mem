import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Warp reads global MCP servers from ~/.warp/.mcp.json (docs.warp.dev,
// "File-based MCP configuration"). The installer resolves the home directory
// when the module loads, so it runs in a child process with HOME set.
describe('Warp install', () => {
  let tmp: string;

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('registers claude-mem in ~/.warp/.mcp.json', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'warp-install-'));
    const home = path.join(tmp, 'home');
    const project = path.join(tmp, 'project');
    const plugin = path.join(tmp, 'plugin');
    mkdirSync(path.join(home, '.warp'), { recursive: true });
    mkdirSync(project);
    mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
    writeFileSync(path.join(plugin, 'scripts', 'mcp-server.cjs'), '');

    const installers = path.resolve(import.meta.dir, '../../src/services/integrations/McpIntegrations.ts');
    const install = Bun.spawnSync(
      [process.execPath, '-e', `const { MCP_IDE_INSTALLERS } = await import(${JSON.stringify(installers)}); process.exit(await MCP_IDE_INSTALLERS.warp());`],
      { cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: plugin } },
    );

    expect(install.exitCode).toBe(0);
    const config = JSON.parse(readFileSync(path.join(home, '.warp', '.mcp.json'), 'utf-8'));
    expect(config.mcpServers['claude-mem'].args).toEqual([path.join(plugin, 'scripts', 'mcp-server.cjs')]);
    expect(existsSync(path.join(home, '.warp', 'mcp.json'))).toBe(false);
  });
});
