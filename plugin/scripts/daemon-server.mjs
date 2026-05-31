#!/usr/bin/env bun
// claude-mem daemon — UDS singleton, NDJSON-framed JSON requests.
// Spec: docs/sprint2/07-tdd-plan-v2.md Phase 1 (P0-Fixes).
//
// Sprint-2 changes vs Sprint-1:
//  - P0-2: UTF-8 multi-byte-safe framing (node:string_decoder)
//  - P0-3: Resolves sdk_sessions FK row before pending_messages insert
//  - P0-4: O_EXCL lock-file gating prevents auto-spawn race / socket-unlink-race
//  - P1: WORKER_HOST != 127.0.0.1 stderr warning
//  - P1: shutdown race-flag, error handler closes socket
//
// NDJSON contract:
//   {"kind":"ping"}                                            → {ok:true,pid,ts,socket}
//   {"kind":"hook","platform":...,"event":"observation"|"summarize"|...,"payload":{...}}
//                                                              → {ok:true,queued:true|false,...}

import { parseArgs } from 'util';
import {
  unlinkSync, existsSync, mkdirSync, openSync, writeSync, closeSync, readFileSync,
  constants as FS_C,
} from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { Database } from 'bun:sqlite';
import { DATA_DIR as DEFAULT_DATA_DIR, DEFAULT_SOCK, DEFAULT_LOCK, DB_PATH as DEFAULT_DB_PATH, SETTINGS_PATH }
  from './lib/paths.mjs';
import { scoreImportance, shouldAutoPin, deriveToolKind, deriveOutcome } from './lib/importance.mjs';

const { values: args } = parseArgs({
  options: {
    socket:     { type: 'string' },
    'data-dir': { type: 'string' },
    lock:       { type: 'string' },
  },
  strict: true,
});

const DATA_DIR = args['data-dir'] || process.env.CLAUDE_MEM_DATA_DIR || DEFAULT_DATA_DIR;
const SOCK = args.socket || process.env.CLAUDE_MEM_SOCK ||
  (args['data-dir'] ? `${args['data-dir']}/daemon.sock` : DEFAULT_SOCK);
// Lock-file is paired with the socket — if --socket points to a custom path, the
// lock lives next to it. Otherwise fall back to --lock / --data-dir / default.
// Prevents test daemons from colliding with the live ~/.claude-mem/daemon.lock.
const LOCK = args.lock
  || (args.socket ? args.socket.replace(/\.sock$/, '.lock') : null)
  || (args['data-dir'] ? `${args['data-dir']}/daemon.lock` : DEFAULT_LOCK);
const DB_PATH = args['data-dir'] ? `${args['data-dir']}/claude-mem.db` : DEFAULT_DB_PATH;

mkdirSync(DATA_DIR, { recursive: true });

// P0-4: O_EXCL lock-file. If another daemon is starting/running, exit cleanly.
try {
  const fd = openSync(LOCK, FS_C.O_CREAT | FS_C.O_EXCL | FS_C.O_WRONLY, 0o600);
  writeSync(fd, String(process.pid));
  closeSync(fd);
} catch (e) {
  if (e.code === 'EEXIST') {
    // Check if the holder is alive; if not, stale lock → take over.
    let alive = false;
    try {
      const heldPid = parseInt(readFileSync(LOCK, 'utf-8').trim(), 10);
      if (heldPid > 0) {
        try { process.kill(heldPid, 0); alive = true; } catch { alive = false; }
      }
    } catch {}
    if (alive) {
      // Another daemon is alive — exit silently, hook-client will connect to it.
      process.exit(0);
    } else {
      // Stale lock — remove and try once more.
      try { unlinkSync(LOCK); } catch {}
      const fd2 = openSync(LOCK, FS_C.O_CREAT | FS_C.O_EXCL | FS_C.O_WRONLY, 0o600);
      writeSync(fd2, String(process.pid));
      closeSync(fd2);
    }
  } else {
    throw e;
  }
}

// Now safe to unlink any stale socket and listen.
if (existsSync(SOCK)) {
  try { unlinkSync(SOCK); } catch {}
}

// Worker-host security warning (per SA-Audit recommendation #7)
try {
  if (existsSync(SETTINGS_PATH)) {
    const s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const host = s.CLAUDE_MEM_WORKER_HOST;
    if (host && host !== '127.0.0.1' && host !== 'localhost') {
      process.stderr.write(
        `[daemon] WARNING: CLAUDE_MEM_WORKER_HOST=${host} — daemon not bound to loopback. ` +
        `Anyone on the network may read/write memory. Set CLAUDE_MEM_WORKER_HOST=127.0.0.1 in ` +
        `${SETTINGS_PATH} to silence this warning.\n`
      );
    }
  }
} catch {}

let _db = null;
let shuttingDown = false;
const inflight = new Set();

function getDB() {
  if (_db) return _db;
  if (!existsSync(DB_PATH)) return null; // best-effort: queue gets dropped silently with reason
  _db = new Database(DB_PATH, { create: false, readwrite: true });
  _db.run('PRAGMA journal_mode = WAL');
  _db.run('PRAGMA synchronous = NORMAL');
  _db.run('PRAGMA temp_store = MEMORY');
  _db.run('PRAGMA mmap_size = 268435456');
  _db.run('PRAGMA cache_size = -64000');
  _db.run('PRAGMA busy_timeout = 5000');
  _db.run('PRAGMA foreign_keys = ON');
  ensureSprint2Columns(_db);
  return _db;
}

// Phase-6 additive migration. Idempotent. Never throws on existing column.
function ensureSprint2Columns(db) {
  const cols = db.query("PRAGMA table_info(pending_messages)").all();
  const names = new Set(cols.map(c => c.name));
  if (!names.has('importance')) {
    try { db.run("ALTER TABLE pending_messages ADD COLUMN importance REAL DEFAULT 0.3"); } catch {}
  }
  if (!names.has('pinned')) {
    try { db.run("ALTER TABLE pending_messages ADD COLUMN pinned INTEGER DEFAULT 0"); } catch {}
  }
}

// P0-3: Resolve or insert the sdk_sessions row before pending_messages insert.
// Without this, session_db_id=0 violates the FK constraint and ALL inserts fail.
function resolveSessionDbId(db, contentSessionId, project = 'unknown', platformSource = 'claude') {
  let row = db.prepare(
    'SELECT id, memory_session_id FROM sdk_sessions WHERE content_session_id = ?'
  ).get(contentSessionId);
  if (row) return row.id;
  // Create minimal sdk_sessions row. memory_session_id must be unique — use content_session_id as fallback.
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  try {
    db.run(
      `INSERT INTO sdk_sessions
       (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      contentSessionId, contentSessionId, project, platformSource, nowIso, now,
    );
  } catch (e) {
    if (!/UNIQUE/i.test(e.message)) throw e;
    // Race: another insert won; re-read.
  }
  row = db.prepare(
    'SELECT id FROM sdk_sessions WHERE content_session_id = ?'
  ).get(contentSessionId);
  return row?.id ?? null;
}

async function handle(line) {
  if (shuttingDown) return { ok: false, error: 'shutting-down' };

  let msg;
  try { msg = JSON.parse(line); }
  catch (e) { return { ok: false, error: `invalid JSON: ${e.message}` }; }

  if (msg.kind === 'ping') {
    return { ok: true, pid: process.pid, ts: Date.now(), socket: SOCK };
  }

  if (msg.kind === 'hook') {
    const evt = msg.event || 'observation';
    const payload = msg.payload || {};
    const db = getDB();
    if (!db) return { ok: true, queued: false, reason: 'db-not-initialized' };
    try {
      const contentSessionId = payload.session_id || 'unknown';
      const project = deriveProject(payload.cwd) || 'unknown';
      const platformSource = msg.platform === 'codex' ? 'codex'
        : msg.platform === 'cursor' ? 'cursor' : 'claude';
      const sessionDbId = resolveSessionDbId(db, contentSessionId, project, platformSource);
      if (!sessionDbId) return { ok: true, queued: false, reason: 'session-resolve-failed' };

      const toolName = payload.tool_name || null;
      const toolInput = payload.tool_input ? JSON.stringify(payload.tool_input) : null;
      const toolResponse = payload.tool_response ? JSON.stringify(payload.tool_response) : null;
      const messageType = evt === 'summarize' ? 'summarize' : 'observation';

      // Phase-6: Importance + Auto-Pin heuristic
      const toolKind = deriveToolKind(toolName);
      const outcome = deriveOutcome(payload.tool_response);
      const surfaceText = `${toolInput || ''} ${toolResponse || ''}`;
      const importance = scoreImportance({ toolKind, toolName, outcome, text: surfaceText });
      const pinned = shouldAutoPin(surfaceText) ? 1 : 0;

      db.run(
        `INSERT INTO pending_messages
         (session_db_id, content_session_id, message_type, tool_name, tool_input, tool_response, cwd, status, created_at_epoch, importance, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        sessionDbId, contentSessionId, messageType, toolName, toolInput, toolResponse,
        payload.cwd || null, Date.now(), importance, pinned,
      );
      return { ok: true, queued: true, sessionDbId, importance, pinned };
    } catch (e) {
      return { ok: true, queued: false, reason: e.message };
    }
  }

  return { ok: false, error: `unknown kind: ${msg.kind}` };
}

function deriveProject(cwd) {
  if (!cwd) return null;
  const parts = cwd.split('/').filter(Boolean);
  return parts.pop() || null;
}

const server = Bun.listen({
  unix: SOCK,
  socket: {
    // P0-2: UTF-8 multi-byte safe decoding
    open(s) { s.data = { buf: '', dec: new StringDecoder('utf-8') }; },
    data(s, chunk) {
      s.data.buf += s.data.dec.write(chunk);
      let idx;
      while ((idx = s.data.buf.indexOf('\n')) >= 0) {
        const line = s.data.buf.slice(0, idx);
        s.data.buf = s.data.buf.slice(idx + 1);
        if (!line.trim()) continue;
        const p = handle(line)
          .then(reply => { try { s.write(JSON.stringify(reply) + '\n'); } catch {} })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
    },
    close(s) {
      try { s.data?.dec?.end(); } catch {}
    },
    error(_s, err) {
      process.stderr.write(`[daemon] socket error: ${err?.message || err}\n`);
      try { _s?.end?.(); } catch {} // P1: prevent FD leak
    },
  },
});

async function shutdown() {
  shuttingDown = true;
  // Drain in-flight handlers
  if (inflight.size) {
    try { await Promise.race([Promise.allSettled([...inflight]), Bun.sleep(2000)]); } catch {}
  }
  try { _db?.run('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  try { _db?.close(); } catch {}
  try { server.stop?.(true); } catch {}
  try { unlinkSync(SOCK); } catch {}
  try { unlinkSync(LOCK); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

process.stderr.write(`[daemon] listening on ${SOCK} (pid=${process.pid}, data=${DATA_DIR})\n`);
