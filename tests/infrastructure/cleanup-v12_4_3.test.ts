
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { runOneTimeV12_4_3Cleanup } from '../../src/services/infrastructure/CleanupV12_4_3.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
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

function makeObservation(title: string) {
  return {
    type: 'discovery',
    title,
    subtitle: null,
    facts: [],
    narrative: title,
    concepts: [],
    files_read: [],
    files_modified: [],
  };
}

function seedDatabase(dbPath: string, opts: { observerSessions: number; stuckCount: number }): { observerSessionDbIds: number[]; keepSessionDbId: number } {
  const store = new SessionStore(dbPath);
  const epoch = Date.now();

  const observerSessionDbIds: number[] = [];
  for (let i = 0; i < opts.observerSessions; i++) {
    const sessionDbId = store.createSDKSession(`obs-content-${i}`, OBSERVER_SESSIONS_PROJECT, `prompt ${i}`);
    // Cascade rows depend on memory_session_id being set: createSDKSession inserts NULL.
    store.updateMemorySessionId(sessionDbId, `obs-memory-${i}`);
    observerSessionDbIds.push(sessionDbId);
    store.saveUserPrompt(`obs-content-${i}`, 1, `prompt ${i}`);
    store.storeObservation(`obs-memory-${i}`, OBSERVER_SESSIONS_PROJECT, makeObservation(`obs ${i}`));
  }

  const keepSessionDbId = store.createSDKSession('keep-content', 'real-project', 'survives');
  store.updateMemorySessionId(keepSessionDbId, 'keep-memory');
  store.saveUserPrompt('keep-content', 1, 'survives');

  // pending_messages has no SessionStore store method — seed via the raw handle.
  const insertPending = store.db.prepare(
    `INSERT INTO pending_messages (session_db_id, content_session_id, message_type, status, created_at_epoch)
     VALUES (?, 'keep-content', 'observation', 'processing', ?)`
  );
  for (let i = 0; i < opts.stuckCount; i++) {
    insertPending.run(keepSessionDbId, epoch);
  }

  store.close();
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

    mkdirSync(path.join(tmpDataDir, 'chroma'), { recursive: true });
    writeFileSync(path.join(tmpDataDir, 'chroma', 'collection.bin'), 'opaque');
    writeFileSync(path.join(tmpDataDir, 'chroma-sync-state.json'), '{}');

    runOneTimeV12_4_3Cleanup(tmpDataDir);

    const markerPath = path.join(tmpDataDir, '.cleanup-v12.4.3-applied');
    expect(existsSync(markerPath)).toBe(true);
    const payload = JSON.parse(readFileSync(markerPath, 'utf8'));

    expect(payload.counts.observerSessions).toBe(3);
    expect(payload.counts.observerCascadeRows).toBe(6); 
    expect(payload.counts.stuckPendingMessages).toBe(12);
    expect(payload.chromaWiped).toBe(true);
    expect(payload.chromaWipeError).toBeUndefined();
    expect(payload.backupPath).toBeTruthy();

    expect(existsSync(payload.backupPath)).toBe(true);

    expect(existsSync(path.join(tmpDataDir, 'chroma'))).toBe(false);
    expect(existsSync(path.join(tmpDataDir, 'chroma-sync-state.json'))).toBe(false);

    const verify = new Database(dbPath, { readonly: true });
    const observerCount = (verify.prepare('SELECT COUNT(*) AS n FROM sdk_sessions WHERE project = ?').get(OBSERVER_SESSIONS_PROJECT) as { n: number }).n;
    const realCount = (verify.prepare(`SELECT COUNT(*) AS n FROM sdk_sessions WHERE project = 'real-project'`).get() as { n: number }).n;
    const survivingPrompts = (verify.prepare('SELECT COUNT(*) AS n FROM user_prompts').get() as { n: number }).n;
    const survivingPending = (verify.prepare('SELECT COUNT(*) AS n FROM pending_messages').get() as { n: number }).n;
    verify.close();

    expect(observerCount).toBe(0);
    expect(realCount).toBe(1);
    expect(survivingPrompts).toBe(1); 
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

  it.each([
    { bsize: 0, bavail: 977028249 },
    { bsize: 4096, bavail: -1 },
  ])('proceeds with cleanup for non-credible statfs values %j', values => {
    const dbPath = path.join(tmpDataDir, 'claude-mem.db');
    seedDatabase(dbPath, { observerSessions: 2, stuckCount: 10 });
    const statfsSpy = spyOn(fs, 'statfsSync').mockReturnValue({
      type: 0, blocks: 4096, bfree: 1048576, files: 0, ffree: 0, ...values,
    } as ReturnType<typeof fs.statfsSync>);
    try {
      runOneTimeV12_4_3Cleanup(tmpDataDir);
      expect(statfsSpy).toHaveBeenCalled();
      const payload = JSON.parse(readFileSync(path.join(tmpDataDir, '.cleanup-v12.4.3-applied'), 'utf8'));
      expect(payload.counts.observerSessions).toBe(2);
      expect(payload.counts.stuckPendingMessages).toBe(10);
      expect(payload.backupPath).toBeTruthy();
      expect(existsSync(payload.backupPath)).toBe(true);
    } finally {
      statfsSpy.mockRestore();
    }
  });

  it.each([['absent', false], ['present', true]] as const)('dry-run scans without deleting when marker is %s', (_label, markerExists) => {
    const dbPath = path.join(tmpDataDir, 'claude-mem.db');
    seedDatabase(dbPath, { observerSessions: 2, stuckCount: 10 });
    const markerPath = path.join(tmpDataDir, '.cleanup-v12.4.3-applied');
    if (markerExists) writeFileSync(markerPath, 'already applied');
    mkdirSync(path.join(tmpDataDir, 'chroma'));
    writeFileSync(path.join(tmpDataDir, 'chroma', 'collection.bin'), 'opaque');
    writeFileSync(path.join(tmpDataDir, 'chroma-sync-state.json'), '{}');
    const before = readFileSync(dbPath);
    const runSpy = spyOn(Database.prototype, 'run');
    try {
      expect(runOneTimeV12_4_3Cleanup(tmpDataDir, { dryRun: true })).toEqual({
        observerSessions: 2,
        observerCascadeRows: 4,
        stuckPendingMessages: 10,
      });
      expect(runSpy.mock.calls.some(([sql]) => /^\s*DELETE\b/i.test(String(sql)))).toBe(false);
      expect(readFileSync(dbPath)).toEqual(before);
      expect(existsSync(path.join(tmpDataDir, 'backups'))).toBe(false);
      expect(readFileSync(path.join(tmpDataDir, 'chroma', 'collection.bin'), 'utf8')).toBe('opaque');
      expect(readFileSync(path.join(tmpDataDir, 'chroma-sync-state.json'), 'utf8')).toBe('{}');
      expect(existsSync(markerPath)).toBe(markerExists);
      if (markerExists) expect(readFileSync(markerPath, 'utf8')).toBe('already applied');
    } finally {
      runSpy.mockRestore();
    }
  });

  it('dry-run leaves a missing database and marker absent', () => {
    expect(runOneTimeV12_4_3Cleanup(tmpDataDir, { dryRun: true })).toEqual({
      observerSessions: 0, observerCascadeRows: 0, stuckPendingMessages: 0,
    });
    expect(readdirSync(tmpDataDir)).toEqual([]);
  });

  it.each(['insufficient disk', 'both backups failed'])('returns before any DELETE when %s', failure => {
    const dbPath = path.join(tmpDataDir, 'claude-mem.db');
    seedDatabase(dbPath, { observerSessions: 2, stuckCount: 10 });
    mkdirSync(path.join(tmpDataDir, 'chroma'));
    writeFileSync(path.join(tmpDataDir, 'chroma', 'collection.bin'), 'opaque');
    writeFileSync(path.join(tmpDataDir, 'chroma-sync-state.json'), '{}');
    const before = readFileSync(dbPath);
    const statfsSpy = spyOn(fs, 'statfsSync').mockReturnValue({
      type: 0, bsize: 4096, blocks: 4096, bfree: 1048576,
      bavail: failure === 'insufficient disk' ? 0 : 1048576, files: 0, ffree: 0,
    } as ReturnType<typeof fs.statfsSync>);
    const originalRun = Database.prototype.run;
    const runSpy = spyOn(Database.prototype, 'run').mockImplementation(function(sql, ...bindings) {
      if (failure === 'both backups failed' && /^VACUUM INTO/.test(sql)) throw new Error('backup unavailable');
      return originalRun.call(this, sql, ...bindings);
    });
    const copySpy = spyOn(fs, 'copyFileSync').mockImplementation(() => { throw new Error('copy unavailable'); });
    try {
      runOneTimeV12_4_3Cleanup(tmpDataDir);
      expect(statfsSpy).toHaveBeenCalled();
      expect(runSpy.mock.calls.some(([sql]) => /^\s*DELETE\b/i.test(String(sql)))).toBe(false);
      if (failure === 'both backups failed') {
        expect(runSpy.mock.calls.some(([sql]) => /^VACUUM INTO/.test(String(sql)))).toBe(true);
        expect(copySpy).toHaveBeenCalled();
      } else {
        expect(copySpy).not.toHaveBeenCalled();
      }
      expect(readFileSync(dbPath)).toEqual(before);
      expect(existsSync(path.join(tmpDataDir, '.cleanup-v12.4.3-applied'))).toBe(false);
      expect(readFileSync(path.join(tmpDataDir, 'chroma', 'collection.bin'), 'utf8')).toBe('opaque');
      expect(readFileSync(path.join(tmpDataDir, 'chroma-sync-state.json'), 'utf8')).toBe('{}');
    } finally {
      copySpy.mockRestore();
      runSpy.mockRestore();
      statfsSpy.mockRestore();
    }
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
    expect(observerCount).toBe(1); 
  });
});
