import { afterEach, beforeEach, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

const script = join(import.meta.dir, '..', '..', 'plugin', 'scripts', 'ensure-launcher.cjs');
let home: string;
let root: string;
let settings: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'skill-hook-'));
  root = join(home, '.claude', 'plugins', 'cache', 'thedotmack', 'claude-mem', '15.15.2');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills', 'do'), { recursive: true });
  mkdirSync(join(home, '.claude-mem'));
  settings = join(home, '.claude-mem', 'settings.json');
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), '{"name":"claude-mem"}');
  writeFileSync(join(root, 'skills', 'do', 'SKILL.md'), '# do');
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
function run(): string {
  // No launcher bundle in the fixture: the pre-existing launcher check reports
  // that failure without compiling a binary, editing shell profiles or networking.
  const child = spawnSync(Bun.which('node')!, [script], {
    cwd: home, encoding: 'utf-8', timeout: 10_000,
    env: { HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin', CLAUDE_PLUGIN_ROOT: root,
      CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_MEM_DATA_DIR: join(home, '.claude-mem') },
  });
  expect(child.status).toBe(0);
  const lines = child.stdout.trim().split('\n');
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0]).systemMessage;
}
it('the built SessionStart hook reapplies selection and reports restart only when changed', () => {
  writeFileSync(settings, '{"CLAUDE_MEM_SKILLS_DISABLED":"do"}');
  expect(run()).toContain('Restart Claude Code to reload the skill listing');
  expect(existsSync(join(root, 'skills', 'do'))).toBe(false);
  expect(run()).not.toContain('bundled skill selection updated');
  writeFileSync(settings, '{"CLAUDE_MEM_SKILLS_DISABLED":""}');
  expect(run()).toContain('Restart Claude Code to reload the skill listing');
  expect(existsSync(join(root, 'skills', 'do', 'SKILL.md'))).toBe(true);
});
it('the built hook reports invalid settings without changing skills or blocking startup', () => {
  writeFileSync(settings, '{"CLAUDE_MEM_SKILLS_DISABLED":"../do"}');
  expect(run()).toContain('could not apply bundled skill selection');
  expect(existsSync(join(root, 'skills', 'do', 'SKILL.md'))).toBe(true);
});

it('keeps the restart instruction when a list also contains an unknown name', () => {
  writeFileSync(settings, '{"CLAUDE_MEM_SKILLS_DISABLED":"do,unknown"}');
  const message = run();
  expect(message).toContain('Restart Claude Code to reload the skill listing');
  expect(message).toContain('Unknown bundled skill: unknown');
});

it('the built hook names a runtime-required skill it refused and leaves it in place', () => {
  mkdirSync(join(root, 'skills', 'mem-search'));
  writeFileSync(join(root, 'skills', 'mem-search', 'SKILL.md'), '# mem-search');
  writeFileSync(settings, '{"CLAUDE_MEM_SKILLS_DISABLED":"mem-search,do"}');
  const message = run();
  expect(message).toContain('Restart Claude Code to reload the skill listing');
  expect(message).toContain('Skill mem-search stays enabled: claude-mem reads it at runtime');
  expect(existsSync(join(root, 'skills', 'mem-search', 'SKILL.md'))).toBe(true);
  expect(existsSync(join(root, 'skills', 'do'))).toBe(false);
});
