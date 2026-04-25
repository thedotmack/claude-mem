/**
 * Happy-path tests for runOneTimeV12_4_3Cleanup.
 *
 * Uses a real on-disk SQLite under a tmpdir so VACUUM INTO, statSync,
 * statfsSync, and marker-file writes all exercise their real code paths.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { runOneTimeV12_4_3Cleanup } from '../../src/services/infrastructure/CleanupV12_4_3.js';
import { ClaudeMemDatabase } from '../../src/services/sqlite/Database.js';
import { OBSERVER_SESSIONS_PROJECT } from '../../src/shared/paths.js';
import { logger } from '../../src/utils/logger.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function silenceLogger(): void {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
}

function restoreLogger(): void {
  loggerSpies.forEach(s => s.mockRestore());
  loggerSpies = [];
}

function seedDatabase(dbPath: string, opts: { observerSessions: number; stuckCount: number }): { observerSessionDbIds: number[]; keepSessionDbId: number } {
  const seed = new ClaudeMemDatabase(dbPath);
  const db = seed.db;
  const now = new Date().toISOString();
  const epoch = Date.now();

  const insertSession = db.prepare(
    `INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, started_at, started_at_epoch)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertPrompt = db.prepare(
    `INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
     VALUES (?, 1, ?, ?, ?)`
  );
  const insertObservation = db.prepare(
    `INSERT INTO observations (memory_session_id, project, type, text, created_at, created_at_epoch)
     VALUES (?, ?, 'discovery', ?, ?, ?)`
  );

  const observerSessionDbIds: number[] = [];
  for (let i = 0; i < opts.observerSessions; i++) {
    const result = insertSession.run(`obs-content-${i}`, `obs-memory-${i}`, OBSERVER_SESSIONS_PROJECT, now, epoch);
    observerSessionDbIds.push(Number(result.lastInsertRowid));
    insertPrompt.run(`obs-content-${i}`, `prompt ${i}`, now, epoch);
    insertObservation.run(`obs-memory-${i}`, OBSERVER_SESSIONS_PROJECT, `obs ${i}`, now, epoch);
  }

  // Real session that should survive
  const keepResult = insertSession.run('keep-content', 'keep-memory', 'real-project', now, epoch);
  const keepSessionDbId = Number(keepResult.lastInsertRowid);
  insertPrompt.run('keep-content', 'survives', now, epoch);

  // Stuck pending_messages tied to the surviving session (so FK passes).
  const insertPending = db.prepare(
    `INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
     VALUES (?, 'keep-content', 'observation', 'failed', ?)`
  );
  for (let i = 0; i < opts.stuckCount; i++) {
    insertPending.run(keepSessionDbId, epoch);
  }

  seed.close();
  return { observerSessionDbIds, keepSessionDbId };
}

describe('runOneTimeV12_4_3Cleanup', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(tmpdir(), 'cleanup-v12_4_3-'));
    silenceLogger();
  });

  afterEach(() => {
    restoreLogger();
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('writes a no-db marker when the DB is missing', () => {
    runOneTimeV12_4_3Cleanup(tmpDataDir);

    const markerPath = path.join(tmpDataDir, '.cleanup-v12.4.3-applied');
    expect(existsSync(markerPath)).toBe(true);

    const payload = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(payload.skipped).toBe('no-db');
    expect(payload.backupPath).toBeNull();
    expect(payload.counts).toEqual({ observerSessions: 0, observerCascadeRows: 0, stuckPendingMessages: 0 });
  });

  it('purges observer-sessions and stuck pending_messages, writes marker, wipes chroma', () => {
    const dbPath = path.join(tmpDataDir, 'claude-mem.db');
    seedDatabase(dbPath, { observerSessions: 3, stuckCount: 12 });

    // chroma artifacts that should be wiped
    mkdirSync(path.join(tmpDataDir, 'chroma'), { recursive: true });
    writeFileSync(path.join(tmpDataDir, 'chroma', 'collection.bin'), 'opaque');
    writeFileSync(path.join(tmpDataDir, 'chroma-sync-state.json'), '{}');

    runOneTimeV12_4_3Cleanup(tmpDataDir);

    const markerPath = path.join(tmpDataDir, '.cleanup-v12.4.3-applied');
    expect(existsSync(markerPath)).toBe(true);
    const payload = JSON.parse(readFileSync(markerPath, 'utf8'));

    expect(payload.counts.observerSessions).toBe(3);
    expect(payload.counts.observerCascadeRows).toBe(6); // 3 user_prompts + 3 observations
    expect(payload.counts.stuckPendingMessages).toBe(12);
    expect(payload.chromaWiped).toBe(true);
    expect(payload.chromaWipeError).toBeUndefined();
    expect(payload.backupPath).toBeTruthy();

    // Backup file is real and non-empty
    expect(existsSync(payload.backupPath)).toBe(true);

    // Chroma artifacts gone
    expect(existsSync(path.join(tmpDataDir, 'chroma'))).toBe(false);
    expect(existsSync(path.join(tmpDataDir, 'chroma-sync-state.json'))).toBe(false);

    // Real session still present; observer rows gone
    const verify = new Database(dbPath, { readonly: true });
    const observerCount = (verify.prepare('SELECT COUNT(*) AS n FROM sdk_sessions WHERE project = ?').get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n;
    const realCount = (verify.prepare(`SELECT COUNT(*) AS n FROM sdk_sessions WHERE project = 'real-project'`).get() as { n: number }).n;
    const survivingPrompts = (verify.prepare('SELECT COUNT(*) AS n FROM user_prompts').get() as { n: number }).n;
    const survivingPending = (verify.prepare('SELECT COUNT(*) AS n FROM pending_messages').get() as { n: number }).n;
    verify.close();

    expect(observerCount).toBe(0);
    expect(realCount).toBe(1);
    expect(survivingPrompts).toBe(1); // only the keep-content prompt
    expect(survivingPending).toBe(0);
  });

  it('preserves pending_messages when stuck count is below the threshold of 10', () => {
    const dbPath = path.join(tmpDataDir, 'claude-mem.db');
    seedDatabase(dbPath, { observerSessions: 0, stuckCount: 9 });

    runOneTimeV12_4_3Cleanup(tmpDataDir);

    const markerPath = path.join(tmpDataDir, '.cleanup-v12.4.3-applied');
    const payload = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(payload.counts.stuckPendingMessages).toBe(0);

    const verify = new Database(dbPath, { readonly: true });
    const survivingPending = (verify.prepare('SELECT COUNT(*) AS n FROM pending_messages').get() as { n: number }).n;
    verify.close();
    expect(survivingPending).toBe(9);
  });

  it('is idempotent: a second invocation does no work and does not create a second backup', () => {
    const dbPath = path.join(tmpDataDir, 'claude-mem.db');
    seedDatabase(dbPath, { observerSessions: 1, stuckCount: 10 });

    runOneTimeV12_4_3Cleanup(tmpDataDir);
    const backupsAfterFirst = readdirSync(path.join(tmpDataDir, 'backups'));
    expect(backupsAfterFirst.length).toBe(1);

    runOneTimeV12_4_3Cleanup(tmpDataDir);
    const backupsAfterSecond = readdirSync(path.join(tmpDataDir, 'backups'));
    expect(backupsAfterSecond).toEqual(backupsAfterFirst);
  });

  it('honors CLAUDE_MEM_SKIP_CLEANUP_V12_4_3=1 by exiting without writing the marker', () => {
    const dbPath = path.join(tmpDataDir, 'claude-mem.db');
    seedDatabase(dbPath, { observerSessions: 1, stuckCount: 10 });

    const original = process.env.CLAUDE_MEM_SKIP_CLEANUP_V12_4_3;
    process.env.CLAUDE_MEM_SKIP_CLEANUP_V12_4_3 = '1';
    try {
      runOneTimeV12_4_3Cleanup(tmpDataDir);
    } finally {
      if (original === undefined) delete process.env.CLAUDE_MEM_SKIP_CLEANUP_V12_4_3;
      else process.env.CLAUDE_MEM_SKIP_CLEANUP_V12_4_3 = original;
    }

    expect(existsSync(path.join(tmpDataDir, '.cleanup-v12.4.3-applied'))).toBe(false);

    const verify = new Database(dbPath, { readonly: true });
    const observerCount = (verify.prepare('SELECT COUNT(*) AS n FROM sdk_sessions WHERE project = ?').get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n;
    verify.close();
    expect(observerCount).toBe(1); // untouched
  });
});
