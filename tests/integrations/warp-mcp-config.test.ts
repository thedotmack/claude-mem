import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Warp reads global MCP servers from ~/.warp/.mcp.json (docs.warp.dev,
// "File-based MCP configuration") and starts them on its own. The installer
// resolves the home directory when the module loads, so each call runs in a
// child process with HOME set.
const integrations = path.resolve(import.meta.dir, '../../src/services/integrations/McpIntegrations.ts');

describe('Warp MCP config', () => {
  let tmp: string;
  let home: string;
  let plugin: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'warp-mcp-'));
    home = path.join(tmp, 'home');
    plugin = path.join(tmp, 'plugin');
    configPath = path.join(home, '.warp', '.mcp.json');
    mkdirSync(path.join(home, '.warp'), { recursive: true });
    mkdirSync(path.join(tmp, 'project'));
    mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
    writeFileSync(path.join(plugin, 'scripts', 'mcp-server.cjs'), '');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Calls `call` on McpIntegrations in a child process and returns its exit code and stderr. */
  function run(call: string): { exitCode: number | null; stderr: string } {
    const child = Bun.spawnSync(
      [process.execPath, '-e', `const integrations = await import(${JSON.stringify(integrations)}); process.exit(await integrations.${call});`],
      { cwd: path.join(tmp, 'project'), env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: plugin } },
    );
    return { exitCode: child.exitCode, stderr: child.stderr.toString() };
  }
  const install = () => run('MCP_IDE_INSTALLERS.warp()');
  const uninstall = () => run('uninstallWarpMcpIntegration()');

  // The user's own server, from the example on Warp's MCP page.
  const filesystem = { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/notes'] };

  it('registers claude-mem in ~/.warp/.mcp.json', () => {
    expect(install().exitCode).toBe(0);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers['claude-mem'].args).toEqual([path.join(plugin, 'scripts', 'mcp-server.cjs')]);
    expect(existsSync(path.join(home, '.warp', 'mcp.json'))).toBe(false);
  });

  it('uninstall removes claude-mem and leaves the rest of .mcp.json as it was', () => {
    const original = JSON.stringify({ mcpServers: { filesystem } }, null, 2) + '\n';
    writeFileSync(configPath, original);
    expect(install().exitCode).toBe(0);

    expect(uninstall()).toEqual({ exitCode: 0, stderr: '' });
    expect(readFileSync(configPath, 'utf-8')).toBe(original);

    // Nothing left to remove: a second run says so and leaves the file alone.
    expect(uninstall()).toEqual({ exitCode: 1, stderr: '' });
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('uninstall creates no .mcp.json when there is none', () => {
    expect(uninstall()).toEqual({ exitCode: 1, stderr: '' });
    expect(existsSync(configPath)).toBe(false);
  });

  it('uninstall leaves an .mcp.json that does not parse as it is', () => {
    writeFileSync(configPath, '{ not json');

    const result = uninstall();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Corrupt JSON file, refusing to overwrite');
    expect(readFileSync(configPath, 'utf-8')).toBe('{ not json');
  });
});
