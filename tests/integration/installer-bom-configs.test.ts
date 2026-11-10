import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { deregisterOpenCodePluginFromConfig, registerOpenCodePluginInConfig } from '../../src/services/integrations/OpenCodeInstaller.js';
import { configureKimiMcp, uninstallKimiHooks } from '../../src/services/integrations/KimiHooksInstaller.js';

// Host configs saved by Windows editors (PowerShell 5.1 "UTF8", Notepad) start
// with a UTF-8 BOM. Like the Cursor, Windsurf and Devin installers, these must
// read them instead of failing with "Unrecognized token".
const BOM = '﻿';
const env = { OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME };
const roots: string[] = [];
afterEach(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scratch = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmem-bom-'))); roots.push(root); return root; };

describe('Antigravity installer paths', () => {
  it('installs hooks, both MCP configs and context files under the owned home', () => {
    const home = scratch();
    const plugin = join(home, 'plugin');
    mkdirSync(join(plugin, 'scripts'), { recursive: true });
    writeFileSync(join(plugin, 'scripts', 'worker-service.cjs'), '');
    writeFileSync(join(plugin, 'scripts', 'mcp-server.cjs'), '');
    const installer = new URL('../../src/services/integrations/AntigravityCliHooksInstaller.ts', import.meta.url).href;
    const run = Bun.spawnSync([process.execPath, '-e', `const m = await import(${JSON.stringify(installer)}); process.exitCode = await m.installAntigravityCliHooks();`], {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_MEM_DATA_DIR: join(home, '.claude-mem'), CLAUDE_PLUGIN_ROOT: plugin },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0);
    const hooks = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf-8'));
    expect(hooks['claude-mem'].SessionStart[0].command).toContain('worker-service.cjs hook antigravity-cli context');
    for (const path of ['antigravity', 'config']) {
      const mcp = JSON.parse(readFileSync(join(home, '.gemini', path, 'mcp_config.json'), 'utf-8'));
      expect(mcp.mcpServers['claude-mem'].args).toContain(join(plugin, 'scripts', 'mcp-server.cjs'));
    }
    for (const path of ['.gemini/GEMINI.md', '.agents/rules/claude-mem-context.md']) {
      expect(readFileSync(join(home, path), 'utf-8')).toContain('<claude-mem-context>');
    }
  });
});

describe('installers read BOM-prefixed host configs', () => {
  it('OpenCode: registers and deregisters in a BOM-prefixed opencode.json, keeping other servers', () => {
    const dir = scratch();
    process.env.OPENCODE_CONFIG_DIR = dir;
    writeFileSync(join(dir, 'opencode.json'), BOM + JSON.stringify({ mcp: { context7: { enabled: true } } }));
    expect(registerOpenCodePluginInConfig()).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf-8')).mcp.context7).toEqual({ enabled: true });

    writeFileSync(join(dir, 'opencode.json'), BOM + readFileSync(join(dir, 'opencode.json'), 'utf-8'));
    expect(deregisterOpenCodePluginFromConfig()).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf-8')).mcp).toEqual({ context7: { enabled: true } });
  });

  it('Kimi: configures and removes mcp-search in a BOM-prefixed mcp.json', () => {
    const home = scratch();
    process.env.KIMI_CODE_HOME = home;
    writeFileSync(join(home, 'mcp.json'), BOM + JSON.stringify({ mcpServers: { context7: { url: 'https://mcp.context7.com/mcp' } } }));
    expect(configureKimiMcp()).toBe(0);
    expect(JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf-8')).mcpServers['mcp-search']).toBeDefined();

    writeFileSync(join(home, 'mcp.json'), BOM + readFileSync(join(home, 'mcp.json'), 'utf-8'));
    expect(uninstallKimiHooks()).toBe(0);
    const mcp = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf-8'));
    expect(mcp.mcpServers['mcp-search']).toBeUndefined();
    expect(mcp.mcpServers.context7).toBeDefined();
  });

  it('Antigravity: cleans claude-mem out of BOM-prefixed shared Gemini settings.json and hooks.json', () => {
    // GEMINI_* paths are fixed at import from homedir(), so this runs with an owned HOME.
    const home = scratch();
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    const ours = { name: 'claude-mem', type: 'command', command: 'x' };
    writeFileSync(join(home, '.gemini', 'settings.json'), BOM + JSON.stringify({ theme: 'dark', hooks: { SessionStart: [{ hooks: [ours] }] } }));
    writeFileSync(join(home, '.gemini', 'config', 'hooks.json'), BOM + JSON.stringify({ 'other-tool': { event: 'x' } }));
    const installer = new URL('../../src/services/integrations/AntigravityCliHooksInstaller.ts', import.meta.url).href;
    const run = Bun.spawnSync([process.execPath, '-e', `const m = await import(${JSON.stringify(installer)}); process.exitCode = m.uninstallAntigravityCliHooks();`], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_MEM_DATA_DIR: join(home, '.claude-mem') }, stdout: 'pipe', stderr: 'pipe',
    });
    const output = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
    expect(output).not.toContain('Corrupt JSON');
    expect(run.exitCode).toBe(0);
    const settings = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf-8'));
    expect(settings.theme).toBe('dark');
    expect(settings.hooks?.SessionStart).toBeUndefined();
    expect(JSON.parse(readFileSync(join(home, '.gemini', 'config', 'hooks.json'), 'utf-8'))['other-tool']).toEqual({ event: 'x' });
  }, 30_000);
});
