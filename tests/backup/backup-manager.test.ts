// Pro-backup plan Phase 1 verification: the snapshot engine produces an
// openable, integrity-checked copy of a real bun:sqlite DB; retention keeps
// the N most-recent snapshots; DatabaseManager only constructs a
// BackupManager when CLAUDE_MEM_BACKUP_ENABLED === 'true'. Harness style
// copied from tests/services/*: mkdtempSync temp dirs, rmSync cleanup.

import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BackupManager } from '../../src/services/backup/BackupManager.js';
import { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';
import { USER_SETTINGS_PATH } from '../../src/shared/paths.js';

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

/** A real SQLite DB with a table and rows, so a snapshot has data to verify. */
function createSourceDb(dir: string): string {
  const dbPath = join(dir, 'claude-mem.db');
  const db = new Database(dbPath);
  db.run('PRAGMA journal_mode = WAL');
  db.run('CREATE TABLE observations (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO observations (note) VALUES (?)');
  for (let i = 0; i < 25; i++) {
    insert.run(`observation ${i}`);
  }
  db.close();
  return dbPath;
}

function makeManager(dir: string, settings: Record<string, string> = {}, options: Record<string, unknown> = {}): BackupManager {
  return new BackupManager(settings, {
    dbPath: join(dir, 'claude-mem.db'),
    backupsDir: join(dir, 'backups', 'auto'),
    preflightDir: dir,
    ...options,
  });
}

describe('BackupManager.createSnapshot', () => {
  it('produces an openable snapshot that passes PRAGMA integrity_check', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-'));
    createSourceDb(tempRoot);

    const manager = makeManager(tempRoot);
    const result = await manager.createSnapshot();

    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);

    const snapshot = new Database(result.path, { readonly: true });
    try {
      const integrity = snapshot.query('PRAGMA integrity_check').get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe('ok');
      const count = snapshot.query('SELECT COUNT(*) AS n FROM observations').get() as { n: number };
      expect(count.n).toBe(25);
    } finally {
      snapshot.close();
    }

    const status = manager.status();
    expect(status.configured).toBe(true);
    expect(status.lastSnapshotAt).toBe(result.createdAt);
    expect(status.lastSnapshotBytes).toBe(result.bytes);
    expect(status.snapshotCount).toBe(1);
    expect(status.lastError).toBeNull();
  });

  it('names snapshots by sanitized ISO timestamp so filename order is time order', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-'));
    createSourceDb(tempRoot);

    const manager = makeManager(tempRoot, {}, { now: () => Date.parse('2026-08-26T12:34:56.789Z') });
    const result = await manager.createSnapshot();

    expect(result.path.endsWith('claude-mem-2026-08-26T12-34-56-789Z.db')).toBe(true);
  });
});

describe('BackupManager.applyRetention', () => {
  it('deletes the oldest snapshots beyond the retain count, sidecars included', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-'));
    createSourceDb(tempRoot);
    const backupsDir = join(tempRoot, 'backups', 'auto');
    mkdirSync(backupsDir, { recursive: true });

    // Five pre-existing snapshots, oldest first; the oldest also has the
    // -wal/-shm sidecars a fallback copy leaves behind.
    const names = [
      'claude-mem-2026-08-20T00-00-00-000Z.db',
      'claude-mem-2026-08-21T00-00-00-000Z.db',
      'claude-mem-2026-08-22T00-00-00-000Z.db',
      'claude-mem-2026-08-23T00-00-00-000Z.db',
      'claude-mem-2026-08-24T00-00-00-000Z.db',
    ];
    for (const name of names) {
      writeFileSync(join(backupsDir, name), 'snapshot');
    }
    writeFileSync(join(backupsDir, `${names[0]}-wal`), 'wal');
    writeFileSync(join(backupsDir, `${names[0]}-shm`), 'shm');

    const manager = makeManager(tempRoot, { CLAUDE_MEM_BACKUP_RETAIN_COUNT: '3' });
    await manager.applyRetention();

    const remaining = readdirSync(backupsDir).sort();
    expect(remaining).toEqual([
      'claude-mem-2026-08-22T00-00-00-000Z.db',
      'claude-mem-2026-08-23T00-00-00-000Z.db',
      'claude-mem-2026-08-24T00-00-00-000Z.db',
    ]);
    expect(manager.status().snapshotCount).toBe(3);
  });

  it('is a no-op when at or below the retain count', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-backup-'));
    createSourceDb(tempRoot);
    const backupsDir = join(tempRoot, 'backups', 'auto');
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(join(backupsDir, 'claude-mem-2026-08-24T00-00-00-000Z.db'), 'snapshot');

    const manager = makeManager(tempRoot, { CLAUDE_MEM_BACKUP_RETAIN_COUNT: '7' });
    await manager.applyRetention();

    expect(readdirSync(backupsDir)).toEqual(['claude-mem-2026-08-24T00-00-00-000Z.db']);
  });
});

describe('DatabaseManager backup gate', () => {
  // DATA_DIR (and with it USER_SETTINGS_PATH / DB_PATH) is pinned to a
  // per-run temp dir by tests/preload.ts, so writing the real settings path
  // here never touches ~/.claude-mem. Restore whatever was there so later
  // test files see an unchanged settings file.
  const priorSettings = existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf-8') : null;

  function restoreSettings(): void {
    if (priorSettings === null) {
      if (existsSync(USER_SETTINGS_PATH)) unlinkSync(USER_SETTINGS_PATH);
    } else {
      writeFileSync(USER_SETTINGS_PATH, priorSettings);
    }
  }

  async function initializeWith(backupEnabled: string): Promise<DatabaseManager> {
    writeFileSync(USER_SETTINGS_PATH, JSON.stringify({
      CLAUDE_MEM_CHROMA_ENABLED: 'false',
      CLAUDE_MEM_BACKUP_ENABLED: backupEnabled,
    }));
    const dbManager = new DatabaseManager();
    await dbManager.initialize();
    return dbManager;
  }

  it('does not construct a BackupManager when CLAUDE_MEM_BACKUP_ENABLED is false', async () => {
    const dbManager = await initializeWith('false');
    try {
      expect(dbManager.getBackupManager()).toBeNull();
    } finally {
      await dbManager.close();
      restoreSettings();
    }
  });

  it('constructs a BackupManager when CLAUDE_MEM_BACKUP_ENABLED is true', async () => {
    const dbManager = await initializeWith('true');
    try {
      const manager = dbManager.getBackupManager();
      expect(manager).not.toBeNull();
      expect(manager!.status().configured).toBe(true);
    } finally {
      await dbManager.close();
      restoreSettings();
    }
  });
});
