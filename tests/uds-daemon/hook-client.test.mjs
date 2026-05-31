import { test, expect } from 'bun:test';
import { spawn } from 'bun';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = import.meta.dir;
const HOOK_CLIENT = join(HERE, '..', 'src', 'hook-client.mjs');

async function runHook({ event = 'observation', payload, socket }) {
  const proc = spawn({
    cmd: ['bun', HOOK_CLIENT, '--event', event, '--socket', socket],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const t0 = performance.now();
  const code = await proc.exited;
  const t1 = performance.now();
  const out = await new Response(proc.stdout).text();
  return { code, out, ms: t1 - t0 };
}

test('fast-skip: PostToolUse on TodoWrite exits <250ms with ok JSON', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cm-hc-fs-'));
  const sock = join(tmp, 'never.sock'); // intentionally missing → would fail if reached
  const r = await runHook({
    socket: sock,
    payload: { hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: {} },
  });
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/"continue":true/);
  expect(r.ms).toBeLessThan(250); // Bun cold start ~30-50ms + filter
  rmSync(tmp, { recursive: true, force: true });
});

test('auto-spawn: hook-client spawns daemon when socket missing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cm-hc-as-'));
  const sock = join(tmp, 'auto.sock');
  expect(existsSync(sock)).toBe(false);
  const r = await runHook({
    socket: sock,
    payload: {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'true' },
      session_id: 'auto-spawn-test',
    },
  });
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/"continue":true/);
  // After auto-spawn, give the daemon a moment to materialise the socket
  let exists = false;
  for (let i = 0; i < 40; i++) {
    if (existsSync(sock)) { exists = true; break; }
    await Bun.sleep(25);
  }
  expect(exists).toBe(true);

  // Cleanup: kill any process holding the socket
  try {
    const { spawnSync } = await import('child_process');
    spawnSync('pkill', ['-f', `daemon-server.mjs.*${sock}`], { stdio: 'ignore' });
  } catch {}
  rmSync(tmp, { recursive: true, force: true });
});
