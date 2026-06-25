import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dir;
const PATCHER = join(HERE, '..', 'src', 'plugin-hook-perf-patch.v2.mjs');

function makeHooks(content) {
  const tmp = mkdtempSync(join(tmpdir(), 'cm-patcher2-'));
  const path = join(tmp, 'hooks.json');
  writeFileSync(path, JSON.stringify(content, null, 2));
  return { tmp, path };
}

test('--fix-session-start-matcher adds resume when missing', () => {
  const { tmp, path } = makeHooks({
    hooks: { SessionStart: [{ matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: 'true' }] }] },
  });
  const r = spawnSync('bun', [PATCHER, '--target', path, '--fix-session-start-matcher'], { encoding: 'utf-8' });
  expect(r.status).toBe(0);
  const out = JSON.parse(readFileSync(path, 'utf-8'));
  expect(out.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact');
  rmSync(tmp, { recursive: true, force: true });
});

test('--fix-session-start-matcher is idempotent', () => {
  const { tmp, path } = makeHooks({
    hooks: { SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: 'true' }] }] },
  });
  const r1 = spawnSync('bun', [PATCHER, '--target', path, '--fix-session-start-matcher'], { encoding: 'utf-8' });
  const r2 = spawnSync('bun', [PATCHER, '--target', path, '--fix-session-start-matcher'], { encoding: 'utf-8' });
  expect(r1.status).toBe(0);
  expect(r2.status).toBe(0);
  const out = JSON.parse(readFileSync(path, 'utf-8'));
  expect(out.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact');
  rmSync(tmp, { recursive: true, force: true });
});

test('--fix-posttooluse-matcher broadens narrow matcher', () => {
  const { tmp, path } = makeHooks({
    hooks: { PostToolUse: [{ matcher: 'Bash|Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: 'true' }] }] },
  });
  const r = spawnSync('bun', [PATCHER, '--target', path, '--fix-posttooluse-matcher'], { encoding: 'utf-8' });
  expect(r.status).toBe(0);
  const out = JSON.parse(readFileSync(path, 'utf-8'));
  expect(out.hooks.PostToolUse[0].matcher).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit|Task|Skill');
  expect(out.hooks.PostToolUse[0].matcher).not.toMatch(/Read|mcp__/); // no noise/loop
  rmSync(tmp, { recursive: true, force: true });
});

test('--tighten-timeouts reduces Setup 300→30, PostToolUse 120→30', () => {
  const { tmp, path } = makeHooks({
    hooks: {
      Setup:       [{ matcher: '*', hooks: [{ type: 'command', command: 't', timeout: 300 }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 't', timeout: 120 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 't', timeout: 60 }] }],
    },
  });
  const r = spawnSync('bun', [PATCHER, '--target', path, '--tighten-timeouts'], { encoding: 'utf-8' });
  expect(r.status).toBe(0);
  const out = JSON.parse(readFileSync(path, 'utf-8'));
  expect(out.hooks.Setup[0].hooks[0].timeout).toBe(30);
  expect(out.hooks.PostToolUse[0].hooks[0].timeout).toBe(30);
  expect(out.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(10);
  rmSync(tmp, { recursive: true, force: true });
});

test('--all applies every patch in order', () => {
  const { tmp, path } = makeHooks({
    hooks: {
      Setup:       [{ matcher: '*', hooks: [{ type: 'command', command: 't', timeout: 300 }] }],
      SessionStart: [{ matcher: 'startup|clear|compact', hooks: [{ type: 'command', command: 'bun "$_P/scripts/worker-service.cjs" hook claude-code context', timeout: 60 }] }],
      PostToolUse: [{ matcher: 'Bash|Edit|Write|NotebookEdit', hooks: [{ type: 'command', command: 'bun "$_P/scripts/worker-service.cjs" hook claude-code observation', timeout: 120 }] }],
    },
  });
  const r = spawnSync('bun', [PATCHER, '--target', path, '--all'], { encoding: 'utf-8' });
  expect(r.status).toBe(0);
  const out = JSON.parse(readFileSync(path, 'utf-8'));
  expect(out.hooks.SessionStart[0].matcher).toBe('startup|resume|clear|compact');
  expect(out.hooks.PostToolUse[0].matcher).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit|Task|Skill');
  expect(out.hooks.Setup[0].hooks[0].timeout).toBe(30);
  expect(out.hooks.SessionStart[0].hooks[0].command).toMatch(/hook-client\.mjs/);
  expect(out.hooks.PostToolUse[0].hooks[0].command).toMatch(/hook-client\.mjs/);
  rmSync(tmp, { recursive: true, force: true });
});
