import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'bun';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, sockPath, daemon;
const HERE = import.meta.dir;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cm-daemon-test-'));
  sockPath = join(tmp, 'daemon.sock');
  daemon = spawn({
    cmd: ['bun', join(HERE, '..', 'src', 'daemon-server.mjs'),
          '--socket', sockPath, '--data-dir', tmp],
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_MEM_DAEMON: '1' },
  });
  // Wait for socket
  for (let i = 0; i < 80; i++) {
    if (existsSync(sockPath)) break;
    await Bun.sleep(25);
  }
  if (!existsSync(sockPath)) throw new Error('daemon failed to create socket');
});

afterAll(() => {
  try { daemon?.kill('SIGTERM'); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function rpc(payload, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const sock = connect({ path: sockPath });
    let buf = '';
    sock.once('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString();
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        try { sock.end(); } catch {}
        try { resolve(JSON.parse(buf.slice(0, idx))); } catch (e) { reject(e); }
      }
    });
    sock.on('error', reject);
    setTimeout(() => { try { sock.end(); } catch {}; reject(new Error('rpc timeout')); }, timeoutMs);
  });
}

test('daemon answers ping with ok + pid', async () => {
  const reply = await rpc({ kind: 'ping' });
  expect(reply).toMatchObject({ ok: true });
  expect(typeof reply.pid).toBe('number');
  expect(reply.pid).toBeGreaterThan(0);
});

test('daemon returns ok for hook event even without DB initialised', async () => {
  const reply = await rpc({
    kind: 'hook',
    platform: 'claude-code',
    event: 'observation',
    payload: { session_id: 't', tool_name: 'Bash', tool_input: { command: 'echo x' } },
  });
  expect(reply).toMatchObject({ ok: true });
  // queued may be false because we point at an empty tmp data-dir (no DB).
  // The contract is: never error, always ok:true on hook.
});

test('daemon rejects unknown kind cleanly', async () => {
  const reply = await rpc({ kind: 'totally-unknown' });
  expect(reply).toMatchObject({ ok: false });
  expect(reply.error).toMatch(/unknown kind/);
});
