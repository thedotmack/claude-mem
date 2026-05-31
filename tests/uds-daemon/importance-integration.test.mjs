// Integration: daemon writes importance + pinned columns correctly.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'bun';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

const HERE = import.meta.dir;
const SRC = join(HERE, '..', 'src');
let tmp, sockPath, dbPath, daemon;

function seedDb(dbPath) {
  const db = new Database(dbPath, { create: true });
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE sdk_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT UNIQUE NOT NULL,
    memory_session_id TEXT UNIQUE,
    project TEXT NOT NULL,
    platform_source TEXT NOT NULL DEFAULT 'claude',
    started_at TEXT NOT NULL, started_at_epoch INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active')`);
  db.run(`CREATE TABLE pending_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_db_id INTEGER NOT NULL,
    content_session_id TEXT NOT NULL,
    message_type TEXT NOT NULL,
    tool_name TEXT, tool_input TEXT, tool_response TEXT, cwd TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at_epoch INTEGER NOT NULL,
    FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id))`);
  db.close();
}

function rpc(payload) {
  return new Promise((resolve, reject) => {
    const sock = connect({ path: sockPath });
    let buf = '';
    sock.once('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', d => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) { sock.end(); resolve(JSON.parse(buf.slice(0, i))); }
    });
    sock.on('error', reject);
    setTimeout(() => { try { sock.end(); } catch {}; reject(new Error('timeout')); }, 3000);
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cm-imp-'));
  sockPath = join(tmp, 'd.sock');
  dbPath = join(tmp, 'claude-mem.db');
  seedDb(dbPath);
  daemon = spawn({
    cmd: ['bun', join(SRC, 'daemon-server.mjs'), '--socket', sockPath, '--data-dir', tmp, '--lock', join(tmp, 'd.lock')],
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: tmp },
  });
  for (let i = 0; i < 80; i++) { if (existsSync(sockPath)) break; await Bun.sleep(25); }
  await Bun.sleep(100);
});

afterAll(() => { try { daemon?.kill('SIGTERM'); } catch {}; try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

test('Phase 6: failure observation gets high importance', async () => {
  const r = await rpc({
    kind: 'hook', platform: 'claude-code', event: 'observation',
    payload: {
      session_id: 'imp-fail', cwd: '/tmp/p1',
      tool_name: 'Bash', tool_input: { command: 'cat /missing' },
      tool_response: { exitCode: 1, error: 'No such file or directory' },
    },
  });
  expect(r.ok).toBe(true);
  expect(r.importance).toBeGreaterThan(0.7);

  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT importance, pinned FROM pending_messages WHERE content_session_id = ?').get('imp-fail');
  expect(row.importance).toBeGreaterThan(0.7);
  expect(row.pinned).toBe(0);
  db.close();
});

test('Phase 6: ADR-like decision text triggers auto-pin', async () => {
  const r = await rpc({
    kind: 'hook', platform: 'claude-code', event: 'observation',
    payload: {
      session_id: 'imp-pin', cwd: '/tmp/p2',
      tool_name: 'Write',
      tool_input: { file_path: 'docs/decisions.md', content: 'decision: we use UDS sockets over TCP for daemon transport' },
      tool_response: { result: 'ok' },
    },
  });
  expect(r.ok).toBe(true);
  expect(r.pinned).toBe(1);

  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT pinned, importance FROM pending_messages WHERE content_session_id = ?').get('imp-pin');
  expect(row.pinned).toBe(1);
  db.close();
});

test('Phase 6: plain read gets low importance, no pin', async () => {
  const r = await rpc({
    kind: 'hook', platform: 'claude-code', event: 'observation',
    payload: {
      session_id: 'imp-read', cwd: '/tmp/p3',
      tool_name: 'Bash', tool_input: { command: 'ls' },
      tool_response: { stdout: 'a b c', exitCode: 0 },
    },
  });
  expect(r.ok).toBe(true);
  expect(r.importance).toBeLessThan(0.5);
  expect(r.pinned).toBe(0);
});
