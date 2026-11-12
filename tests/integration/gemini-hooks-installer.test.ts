import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import { buildGeminiHooks, geminiSettingsPath, manageGeminiHooks, removeGeminiHooks, resolveGeminiWorkerScript } from '../../src/services/integrations/GeminiHooksInstaller.js';
let scratch: string | undefined;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });
const file = () => { scratch = mkdtempSync(path.join(tmpdir(), 'gemini setup ')); return path.join(scratch, 'settings.json'); };
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
describe('Gemini capture setup', () => {
  it('installs once, preserves MCP and other hooks, backs up and removes only its own entries', () => {
    const p = file();
    const foreign = { hooks: [{ type: 'command', command: 'echo audit' }] };
    const original = { model: { name: 'synthetic' }, mcpServers: { existing: { command: 'existing' } }, hooks: { AfterTool: [foreign] } };
    writeFileSync(p, JSON.stringify(original));
    expect(manageGeminiHooks('install', p)).toBe(0);
    const once = read(p);
    expect(manageGeminiHooks('install', p)).toBe(0);
    expect(read(p)).toEqual(once);
    expect(once.mcpServers).toEqual(original.mcpServers);
    expect(once.hooks.AfterTool).toHaveLength(2);
    expect(existsSync(`${p}.claude-mem.bak`)).toBe(true);
    expect(JSON.parse(readFileSync(`${p}.claude-mem.bak`, 'utf8'))).toEqual(original);
    expect(manageGeminiHooks('status', p)).toBe(0);
    expect(manageGeminiHooks('uninstall', p)).toBe(0);
    expect(read(p)).toEqual(original);
    expect(manageGeminiHooks('status', p)).toBe(1);
  });
  it('handles fresh and absent settings without touching a daily installation', () => {
    const p = file();
    expect(manageGeminiHooks('uninstall', p)).toBe(0);
    expect(existsSync(p)).toBe(false);
    expect(manageGeminiHooks('install', p)).toBe(0);
    expect(manageGeminiHooks('status', p)).toBe(0);
  });
  it.each(['{broken', '[]', '{"hooks":[]}', '{"hooks":{"AfterTool":{}}}'])('refuses invalid settings %s without modifying them', content => {
    const p = file(); writeFileSync(p, content);
    expect(manageGeminiHooks('install', p)).toBe(1);
    expect(readFileSync(p, 'utf8')).toBe(content);
  });
  it('keeps edited commands and quotes paths with spaces', () => {
    const ours = buildGeminiHooks('/runtime space/bun', '/plugin space/scripts/worker-service.cjs');
    expect(ours.AfterTool[0].hooks![0].command).toBe('"/runtime space/bun" "/plugin space/scripts/worker-service.cjs" hook gemini observation');
    const foreign = { ...ours.AfterTool[0].hooks![0], command: 'echo do not remove me' };
    expect(removeGeminiHooks({ AfterTool: [{ hooks: [foreign, ...ours.AfterTool[0].hooks!] }] }))
      .toEqual({ AfterTool: [{ hooks: [foreign] }] });
  });
  it('removes hooks older claude-mem releases wrote, so nothing is captured twice', () => {
    const p = file();
    const legacyGemini = { name: 'claude-mem', type: 'command', timeout: 10000,
      command: '"/Users/me/.bun/bin/bun" "/Users/me/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs" hook gemini-cli observation' };
    const legacyWindows = { name: 'claude-mem', type: 'command', timeout: 10000,
      command: '"C:\\\\Users\\\\me\\\\.bun\\\\bin\\\\bun.exe" "C:\\\\Users\\\\me\\\\plugin\\\\scripts\\\\worker-service.cjs" hook gemini-cli context' };
    const legacyAntigravity = { name: 'claude-mem', type: 'command', timeout: 10000,
      command: '"/opt/bun" "/opt/plugin/scripts/worker-service.cjs" hook antigravity-cli session-init' };
    const user = { type: 'command', command: 'echo audit hook gemini-cli observation' };
    writeFileSync(p, JSON.stringify({ hooks: {
      SessionStart: [{ matcher: '*', hooks: [legacyWindows] }],
      BeforeAgent: [{ matcher: '*', hooks: [legacyAntigravity] }],
      BeforeTool: [{ matcher: '*', hooks: [legacyGemini] }],
      AfterTool: [{ matcher: '*', hooks: [legacyGemini, user] }],
    } }));
    expect(manageGeminiHooks('install', p)).toBe(0);
    const hooks = read(p).hooks;
    const commands = Object.values(hooks).flatMap((rules: any) => rules.flatMap((rule: any) => rule.hooks.map((hook: any) => hook.command)));
    expect(commands.some((command: string) => / hook (gemini-cli|antigravity-cli) /.test(command) && command !== user.command)).toBe(false);
    expect(hooks.BeforeTool).toBeUndefined();
    expect(hooks.AfterTool).toHaveLength(2);
    expect(hooks.AfterTool[0].hooks).toEqual([user]);
    expect(hooks.AfterTool[1].hooks[0].command).toEndWith('hook gemini observation');
    expect(manageGeminiHooks('uninstall', p)).toBe(0);
    expect(read(p).hooks).toEqual({ AfterTool: [{ matcher: '*', hooks: [user] }] });
  });
  it('follows GEMINI_CLI_HOME, which names the parent of .gemini', () => {
    expect(geminiSettingsPath({ GEMINI_CLI_HOME: '/profiles/work' })).toBe(path.join(path.resolve('/profiles/work'), '.gemini', 'settings.json'));
    expect(geminiSettingsPath({})).toBe(path.join(homedir(), '.gemini', 'settings.json'));
    expect(geminiSettingsPath({ GEMINI_CLI_HOME: '  ' })).toBe(path.join(homedir(), '.gemini', 'settings.json'));
  });
  const cachedWorker = (cacheRoot: string, version: string) => {
    const root = path.join(cacheRoot, version);
    mkdirSync(path.join(root, 'scripts'), { recursive: true });
    writeFileSync(path.join(root, 'scripts', 'worker-service.cjs'), '// fixture');
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version, dependencies: {} }));
    return path.join(root, 'scripts', 'worker-service.cjs');
  };
  const bakedWorker = (p: string) => read(p).hooks.AfterTool[0].hooks[0].command as string;

  it('falls back to the plugin cache when no stable plugin path exists', () => {
    const p = file();
    const cacheRoot = path.join(scratch!, 'cache');
    const cached = cachedWorker(cacheRoot, '15.17.0');
    const roots = { cacheRoot, marketplaceRoot: path.join(scratch!, 'absent'), cwd: path.join(scratch!, 'ordinary-project') };
    expect(manageGeminiHooks('install', p, () => resolveGeminiWorkerScript(() => null, roots))).toBe(0);
    expect(bakedWorker(p)).toContain(cached);
  });

  it('bakes the stable marketplace path, not the pruned-later cache copy, when both exist', () => {
    const p = file();
    const cacheRoot = path.join(scratch!, 'cache');
    const cached = cachedWorker(cacheRoot, '15.17.0');
    const marketplaceRoot = path.join(scratch!, 'marketplace');
    const marketplaceWorker = path.join(marketplaceRoot, 'plugin', 'scripts', 'worker-service.cjs');
    mkdirSync(path.dirname(marketplaceWorker), { recursive: true });
    writeFileSync(marketplaceWorker, '// fixture');
    writeFileSync(path.join(marketplaceRoot, 'package.json'), JSON.stringify({ version: '15.17.0', dependencies: {} }));
    const roots = { cacheRoot, marketplaceRoot, cwd: path.join(scratch!, 'ordinary-project') };
    expect(manageGeminiHooks('install', p, () => resolveGeminiWorkerScript(() => marketplaceWorker, roots))).toBe(0);
    expect(bakedWorker(p)).toContain(marketplaceWorker);
    expect(bakedWorker(p)).not.toContain(cached);
  });

  it('fails the install when neither a stable path nor a cache copy exists', () => {
    const p = file();
    const roots = { cacheRoot: path.join(scratch!, 'no-cache'), marketplaceRoot: path.join(scratch!, 'absent'), cwd: path.join(scratch!, 'ordinary-project') };
    expect(manageGeminiHooks('install', p, () => resolveGeminiWorkerScript(() => null, roots))).toBe(1);
    expect(existsSync(p)).toBe(false);
  });

});
