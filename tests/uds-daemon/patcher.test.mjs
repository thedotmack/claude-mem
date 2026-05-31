import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dir;
const PATCHER = join(HERE, '..', 'src', 'plugin-hook-perf-patch.v2.mjs');

function makeHooks(content) {
  const tmp = mkdtempSync(join(tmpdir(), 'cm-patcher-'));
  const path = join(tmp, 'hooks.json');
  writeFileSync(path, JSON.stringify(content, null, 2));
  return { tmp, path };
}

test('--apply-uds rewrites bun worker-service.cjs command to hook-client.mjs', () => {
  const { tmp, path } = makeHooks({
    hooks: {
      PostToolUse: [{
        matcher: 'Bash|Edit|Write|NotebookEdit',
        hooks: [{ type: 'command', shell: 'bash',
          command: 'export PATH=...; bun "$_P/scripts/worker-service.cjs" hook claude-code observation' }],
      }],
    },
  });
  const r = spawnSync('bun', [PATCHER, '--target', path, '--apply-uds'], { stdio: 'pipe' });
  expect(r.status).toBe(0);
  const patched = JSON.parse(readFileSync(path, 'utf-8'));
  const cmd = patched.hooks.PostToolUse[0].hooks[0].command;
  expect(cmd).toMatch(/hook-client\.mjs/);
  expect(cmd).toMatch(/--platform claude-code/);
  expect(cmd).toMatch(/--event observation/);
  expect(existsSync(`${path}.uds-bak`)).toBe(true);
  rmSync(tmp, { recursive: true, force: true });
});

test('--apply-codex-cleanup drops $SHELL prelude + bun-runner.js indirection', () => {
  const { tmp, path } = makeHooks({
    hooks: {
      PostToolUse: [{
        matcher: '.*',
        hooks: [{ type: 'command',
          command: `_HP=$(printenv PATH 2>/dev/null || true); if [ -z "$_HP" ]; then _HP="$SHELL"; fi; export PATH="${'$_HP'}:$PATH"; node "$_P/scripts/bun-runner.js" "$_P/scripts/worker-service.cjs" hook codex observation` }],
      }],
    },
  });
  const r = spawnSync('bun', [PATCHER, '--target', path, '--apply-codex-cleanup'], { stdio: 'pipe' });
  expect(r.status).toBe(0);
  const out = JSON.parse(readFileSync(path, 'utf-8'));
  const cmd = out.hooks.PostToolUse[0].hooks[0].command;
  expect(cmd).not.toMatch(/printenv PATH/);
  expect(cmd).not.toMatch(/bun-runner\.js/);
  expect(out.hooks.PostToolUse[0].matcher).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit|Task|Skill');
  rmSync(tmp, { recursive: true, force: true });
});

test('--rollback restores backup', () => {
  const original = {
    hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bun "$_P/scripts/worker-service.cjs" hook claude-code observation' }] }] },
  };
  const { tmp, path } = makeHooks(original);
  spawnSync('bun', [PATCHER, '--target', path, '--apply-uds'], { stdio: 'pipe' });
  spawnSync('bun', [PATCHER, '--rollback', path], { stdio: 'pipe' });
  const restored = JSON.parse(readFileSync(path, 'utf-8'));
  expect(restored.hooks.PostToolUse[0].hooks[0].command).toMatch(/worker-service\.cjs/);
  rmSync(tmp, { recursive: true, force: true });
});
