import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { buildGeminiHooks, manageGeminiHooks, removeGeminiHooks } from '../../src/services/integrations/GeminiHooksInstaller.js';
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
});
