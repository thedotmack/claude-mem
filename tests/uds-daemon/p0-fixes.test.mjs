import { test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'bun';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

const HERE = import.meta.dir;
const SRC = join(HERE, '..', 'src');

function rpc(sockPath, payload, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = connect({ path: sockPath });
    let buf = '';
    sock.once('connect', () => sock.write(JSON.stringify(payload) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString();
      const idx = buf.indexOf('\n');
      if (idx >= 0) { sock.end(); resolve(JSON.parse(buf.slice(0, idx))); }
    });
    sock.on('error', reject);
    setTimeout(() => { try { sock.end(); } catch {}; reject(new Error('rpc timeout')); }, timeoutMs);
  });
}

// Seed a minimal DB with the schema the daemon needs (sdk_sessions + pending_messages + FK).
function seedDb(dbPath) {
  const db = new Database(dbPath, { create: true });
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE sdk_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_session_id TEXT UNIQUE NOT NULL,
    memory_session_id TEXT UNIQUE,
    project TEXT NOT NULL,
    platform_source TEXT NOT NULL DEFAULT 'claude',
    started_at TEXT NOT NULL,
    started_at_epoch INTEGER NOT NULL,
    status TEXT CHECK(status IN ('active','completed','failed')) NOT NULL DEFAULT 'active'
  )`);
  db.run(`CREATE TABLE pending_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_db_id INTEGER NOT NULL,
    content_session_id TEXT NOT NULL,
    message_type TEXT NOT NULL CHECK(message_type IN ('observation','summarize')),
    tool_name TEXT,
    tool_input TEXT,
    tool_response TEXT,
    cwd TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at_epoch INTEGER NOT NULL,
    FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
  )`);
  db.close();
}

let tmp, sockPath, dbPath, daemon;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cm-p0-'));
  sockPath = join(tmp, 'd.sock');
  dbPath = join(tmp, 'claude-mem.db');
  seedDb(dbPath);
  daemon = spawn({
    cmd: ['bun', join(SRC, 'daemon-server.mjs'),
          '--socket', sockPath, '--data-dir', tmp, '--lock', join(tmp, 'd.lock')],
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: tmp }, // override $HOME/.claude-mem reads
  });
  for (let i = 0; i < 120; i++) {
    if (existsSync(sockPath)) break;
    await Bun.sleep(25);
  }
  if (!existsSync(sockPath)) throw new Error('daemon failed to bind');
  await Bun.sleep(100); // settle: ensure socket accept loop is running
});

afterAll(() => {
  try { daemon?.kill('SIGTERM'); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// P0-3 — FK sentinel resolves and inserts pending_messages successfully
test('P0-3: hook event creates sdk_sessions row and pending_messages row (FK fix)', async () => {
  const reply = await rpc(sockPath, {
    kind: 'hook',
    platform: 'claude-code',
    event: 'observation',
    payload: {
      session_id: 'p0-3-test',
      cwd: '/tmp/proj-x',
      tool_name: 'Bash',
      tool_input: { command: 'true' },
      tool_response: { exitCode: 0 },
    },
  });
  expect(reply.ok).toBe(true);
  expect(reply.queued).toBe(true);

  const db = new Database(dbPath, { readonly: true });
  const sess = db.prepare('SELECT id, project FROM sdk_sessions WHERE content_session_id = ?').get('p0-3-test');
  expect(sess).toBeTruthy();
  expect(sess.project).toBe('proj-x'); // derived from cwd basename
  const pm = db.prepare('SELECT * FROM pending_messages WHERE content_session_id = ?').get('p0-3-test');
  expect(pm).toBeTruthy();
  expect(pm.message_type).toBe('observation');
  expect(pm.session_db_id).toBe(sess.id);
  db.close();
});

// P0-2 — UTF-8 multi-byte payload roundtrip
test('P0-2: UTF-8 multi-byte payload survives framing (emoji + umlauts + chinese)', async () => {
  const reply = await rpc(sockPath, {
    kind: 'hook',
    platform: 'claude-code',
    event: 'observation',
    payload: {
      session_id: 'p0-2-utf8',
      cwd: '/tmp/proj-utf',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/möchte.ts', text: 'Bär 🐛 测试' },
      tool_response: { result: 'ok' },
    },
  });
  expect(reply.ok).toBe(true);
  expect(reply.queued).toBe(true);

  const db = new Database(dbPath, { readonly: true });
  const pm = db.prepare('SELECT tool_input FROM pending_messages WHERE content_session_id = ?').get('p0-2-utf8');
  expect(pm).toBeTruthy();
  const parsed = JSON.parse(pm.tool_input);
  expect(parsed.file_path).toBe('src/möchte.ts');
  expect(parsed.text).toBe('Bär 🐛 测试');
  db.close();
});

// P0-1 — Client write-drain: 50 concurrent hook-client invocations → 50 rows queued
test('P0-1: 50 concurrent hook-client calls produce 50 pending_messages rows (no drain race)', async () => {
  const before = countPending();
  const N = 50;
  const procs = [];
  for (let i = 0; i < N; i++) {
    const p = spawn({
      cmd: ['bun', join(SRC, 'hook-client.mjs'), '--event', 'observation', '--socket', sockPath],
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    p.stdin.write(JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: `echo ${i}` },
      tool_response: { stdout: `${i}\n`, exitCode: 0 },
      cwd: '/tmp/proj-drain',
      session_id: `drain-${i}`,
    }));
    p.stdin.end();
    procs.push(p.exited);
  }
  await Promise.all(procs);
  await Bun.sleep(200); // small drain window for daemon-side inserts
  const after = countPending();
  expect(after - before).toBe(N);
});

function countPending() {
  const db = new Database(dbPath, { readonly: true });
  const r = db.prepare('SELECT COUNT(*) AS c FROM pending_messages').get();
  db.close();
  return r.c;
}
