import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager } from '../../src/services/backup/BackupManager.js';
import { runSqliteFileJob } from '../../src/services/backup/sqlite-file-job.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'backup-stop-'));
  const dbPath = join(dir, 'live.db');
  const db = new Database(dbPath);
  db.run('CREATE TABLE memories (text TEXT)');
  db.run("INSERT INTO memories VALUES ('retained live memory')");
  db.close();
  const backupsDir = join(dir, 'backups');
  mkdirSync(backupsDir);
  const manager = new BackupManager({ CLAUDE_MEM_BACKUP_RETAIN_COUNT: '1' }, { dbPath, backupsDir });
  return { dir, dbPath, backupsDir, manager };
}

async function waitForFile(file: string) {
  const deadline = Date.now() + 2_000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('snapshot child did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('snapshot child ownership at shutdown', () => {
  it('stop waits for its real child to exit and removes its partial without pruning completed backups', async () => {
    const { dir, backupsDir, manager } = fixture();
    const previous = 'claude-mem-2026-01-01T00-00-00-000Z.db';
    writeFileSync(join(backupsDir, previous), 'previous completed backup');
    const ready = join(dir, 'child-ready');
    const spawn = Bun.spawn;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let childExited = false;
    // The subprocess boundary performs a controlled long-running snapshot.
    // It is a real owned process; production cancellation must kill and reap it.
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((command: any, options: any) => {
      child = spawn([process.execPath, '-e', `
        const fs = require('fs');
        const job = JSON.parse(process.env.CLAUDE_MEM_SQLITE_FILE_JOB);
        for (const suffix of ['', '-wal', '-shm', '-journal']) fs.writeFileSync(job.target + suffix, 'unfinished snapshot');
        fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
        setInterval(() => {}, 1000);
      `], options) as any;
      void child!.exited.then(() => { childExited = true; });
      return child as any;
    });
    let operation: Promise<unknown> | undefined;
    try {
      operation = manager.runNow().then(value => ({ value }), error => ({ error }));
      await waitForFile(ready);
      expect(readdirSync(backupsDir).some(name => name.endsWith('.partial'))).toBe(true);
      await manager.stop();
      expect(childExited).toBe(true);
      const outcome = await operation as { value?: unknown; error?: Error };
      expect(outcome.value).toBeUndefined();
      expect(outcome.error?.message).toContain('stopped');
      expect(readdirSync(backupsDir)).toEqual([previous]);
      expect(manager.status().nextRunAt).toBeNull();
    } finally {
      spawnSpy.mockRestore();
      if (child) { try { child.kill('SIGKILL'); } catch {} await child.exited; }
      await operation;
      await manager.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not start another snapshot after the manager is stopped', async () => {
    const { dir, backupsDir, manager } = fixture();
    try {
      await manager.stop();
      let failure: unknown;
      try { await manager.runNow(); } catch (error) { failure = error; }
      expect(failure instanceof Error).toBe(true);
      expect(readdirSync(backupsDir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('does not spawn a SQLite job whose caller already cancelled it', async () => {
    const { dir, dbPath } = fixture();
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    const spawnSpy = spyOn(Bun, 'spawn');
    try {
      let failure: unknown;
      try { await runSqliteFileJob({ kind: 'standalone', target: dbPath }, controller.signal); }
      catch (error) { failure = error; }
      expect(failure).toBe(reason);
      expect(spawnSpy.mock.calls.length).toBe(0);
    } finally { spawnSpy.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('DatabaseManager waits for backup shutdown before closing its shared database', async () => {
    const manager = new DatabaseManager();
    let finishBackup!: () => void;
    let databaseClosed = false;
    (manager as any).backupManager = { stop: () => new Promise<void>(resolve => { finishBackup = resolve; }) };
    (manager as any).db = { close: () => { databaseClosed = true; } };
    const closing = manager.close();
    try {
      await Promise.resolve();
      expect(databaseClosed).toBe(false);
    } finally {
      finishBackup();
      await closing;
    }
    expect(databaseClosed).toBe(true);
  });

  it('retains a verified completed snapshot when shutdown follows normal completion', async () => {
    const { dir, manager } = fixture();
    try {
      const snapshot = await manager.runNow();
      await manager.stop();
      expect(snapshot).not.toBeNull();
      const db = new Database(snapshot!.path, { readonly: true });
      try {
        expect(db.query('SELECT text FROM memories').get()).toEqual({ text: 'retained live memory' });
        expect(db.query('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' });
      } finally { db.close(); }
      expect(manager.status().snapshotCount).toBe(1);
    } finally { await manager.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
});
