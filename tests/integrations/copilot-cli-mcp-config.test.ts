import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Copilot CLI loads user-level MCP servers from the `mcpServers` key of
// mcp-config.json in its config directory: ~/.copilot, or the directory
// COPILOT_HOME names (docs.github.com, "GitHub Copilot CLI configuration
// directory"). The installer resolves that path when the module loads, so each
// call runs in a child process with HOME set and the inherited COPILOT_HOME removed.
const integrations = path.resolve(import.meta.dir, '../../src/services/integrations/McpIntegrations.ts');
const { COPILOT_HOME: _inheritedCopilotHome, ...inheritedEnv } = process.env;

describe('Copilot CLI MCP config', () => {
  let tmp: string;
  let home: string;
  let plugin: string;
  let serverPath: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'copilot-cli-mcp-'));
    home = path.join(tmp, 'home');
    plugin = path.join(tmp, 'plugin');
    serverPath = path.join(plugin, 'scripts', 'mcp-server.cjs');
    configPath = path.join(home, '.copilot', 'mcp-config.json');
    mkdirSync(home);
    mkdirSync(path.join(tmp, 'project'));
    mkdirSync(path.dirname(serverPath), { recursive: true });
    writeFileSync(serverPath, '');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Calls `call` on McpIntegrations in a child process and returns its exit code. */
  function run(call: string, env: Record<string, string> = {}): number | null {
    return Bun.spawnSync(
      [process.execPath, '-e', `const integrations = await import(${JSON.stringify(integrations)}); process.exit(await integrations.${call});`],
      { cwd: path.join(tmp, 'project'), env: { ...inheritedEnv, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: plugin, ...env } },
    ).exitCode;
  }
  const install = (env?: Record<string, string>) => run(`MCP_IDE_INSTALLERS['copilot-cli']()`, env);
  const uninstall = () => run('uninstallCopilotCliMcpIntegration()');
  const readConfig = (file: string) => JSON.parse(readFileSync(file, 'utf-8'));

  // The example server from GitHub's "Adding MCP servers for GitHub Copilot CLI" page.
  const playwright = { type: 'local', command: 'npx', args: ['@playwright/mcp@latest'], env: {}, tools: ['*'] };
  const writeUserConfig = (): string => {
    const content = JSON.stringify({ mcpServers: { playwright } }, null, 2) + '\n';
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, content);
    return content;
  };

  it('registers claude-mem under mcpServers in ~/.copilot/mcp-config.json', () => {
    expect(install()).toBe(0);

    const entry = readConfig(configPath).mcpServers['claude-mem'];
    expect(entry.args).toEqual([serverPath]);
    // Without `tools`, VS Code connects the server but never offers its tools to the model.
    expect(entry.type).toBe('local');
    expect(entry.tools).toEqual(['*']);
    expect(existsSync(path.join(home, '.github', 'copilot', 'mcp.json'))).toBe(false);
  });

  it('copilot-vscode writes the same entry as copilot-cli, with tools exposed', () => {
    expect(run(`MCP_IDE_INSTALLERS['copilot-vscode']()`)).toBe(0);
    const viaVscode = readFileSync(configPath, 'utf-8');

    expect(install()).toBe(0);

    expect(readFileSync(configPath, 'utf-8')).toBe(viaVscode);
    expect(readConfig(configPath).mcpServers['claude-mem'].tools).toEqual(['*']);
  });

  it('copilot-vscode writes only the user-level MCP config, not project instructions', () => {
    expect(run(`MCP_IDE_INSTALLERS['copilot-vscode']()`)).toBe(0);

    expect(existsSync(path.join(tmp, 'project', '.github', 'copilot-instructions.md'))).toBe(false);
  });

  it('uninstall removes an entry that copilot-vscode wrote', () => {
    const original = writeUserConfig();
    expect(run(`MCP_IDE_INSTALLERS['copilot-vscode']()`)).toBe(0);

    expect(uninstall()).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('writes mcp-config.json in the directory COPILOT_HOME names', () => {
    const copilotHome = path.join(tmp, 'copilot-home');

    expect(install({ COPILOT_HOME: copilotHome })).toBe(0);

    expect(readConfig(path.join(copilotHome, 'mcp-config.json')).mcpServers['claude-mem'].args).toEqual([serverPath]);
    expect(existsSync(path.join(home, '.copilot'))).toBe(false);
  });

  it('keeps other servers and writes the same file when installed twice', () => {
    writeUserConfig();
    expect(install()).toBe(0);
    const first = readFileSync(configPath, 'utf-8');

    expect(install()).toBe(0);

    expect(readFileSync(configPath, 'utf-8')).toBe(first);
    expect(readConfig(configPath).mcpServers.playwright).toEqual(playwright);
  });

  it('refuses to overwrite a malformed mcp-config.json', () => {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, '{ not json');

    expect(install()).toBe(1);

    expect(readFileSync(configPath, 'utf-8')).toBe('{ not json');
  });

  it('uninstall removes claude-mem and leaves the rest of mcp-config.json as it was', () => {
    const original = writeUserConfig();
    expect(install()).toBe(0);

    expect(uninstall()).toBe(0);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);

    // Nothing left to remove: a second run says so and leaves the file alone.
    expect(uninstall()).toBe(1);
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  });
});
