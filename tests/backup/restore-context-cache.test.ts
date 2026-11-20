import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applyPendingRestore } from '../../src/services/backup/restore-swap.js';
import { stagePendingRestore } from '../../src/services/backup/snapshot-files.js';
import { ContextCacheService } from '../../src/services/worker/ContextCacheService.js';
import { ChromaSyncState } from '../../src/services/sync/ChromaSyncState.js';
import { contextCacheDir, contextCacheFilePath, contextCacheKeys, readContextCache } from '../../src/shared/context-cache.js';
import { paths } from '../../src/shared/paths.js';

function makeDb(path: string, note: string): void {
  const db = new Database(path);
  try {
    db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)');
    db.prepare('INSERT INTO observations (note) VALUES (?)').run(note);
  } finally { db.close(); }
}

function readNote(path: string): string {
  const db = new Database(path, { readonly: true });
  try { return (db.prepare('SELECT note FROM observations').get() as { note: string }).note; }
  finally { db.close(); }
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'restore-context-'));
  const previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  process.env.CLAUDE_MEM_DATA_DIR = dir;
  const pendingSpy = spyOn(paths, 'pendingRestore').mockReturnValue(join(dir, 'restore-pending.json'));
  const resultSpy = spyOn(paths, 'lastRestore').mockReturnValue(join(dir, 'last-restore.json'));
  const rebuildSpy = spyOn(ChromaSyncState, 'markAllForRebuild').mockImplementation(() => {});
  const backupsDir = join(dir, 'backups');
  mkdirSync(backupsDir);
  const dbPath = join(dir, 'live.db');
  const snapshotName = 'claude-mem-2026-10-01T00-00-00-000Z.db';
  makeDb(dbPath, 'memory written after the snapshot');
  makeDb(join(backupsDir, snapshotName), 'memory from the restored snapshot');
  const keys = [contextCacheKeys(['app'], 'claude', false), contextCacheKeys(['other'], 'codex', true, '/repo')];
  const services: ContextCacheService[] = [];
  const newService = () => {
    const service = new ContextCacheService({
      expandProjectReadKeys: projects => projects,
      renderVariant: async () => ({ body: readNote(dbPath), cacheable: true }),
    });
    services.push(service);
    return service;
  };
  const previousWorker = newService();
  for (const key of keys) {
    await previousWorker.recordLiveRender(key, { body: readNote(dbPath), cacheable: true }, Date.now());
  }
  previousWorker.stop();
  const indexPath = join(contextCacheDir(), 'variants.json');
  const indexBefore = readFileSync(indexPath, 'utf8');
  return {
    dbPath, backupsDir, snapshotName, keys, newService, indexPath, indexBefore,
    cleanup() {
      for (const service of services) service.stop();
      rebuildSpy.mockRestore(); resultSpy.mockRestore(); pendingSpy.mockRestore();
      if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('SessionStart cache after a database restore', () => {
  it('expires old blocks at restore commit and relearns their content from the retained variant index', async () => {
    const f = await fixture();
    try {
      for (const key of f.keys) expect(readContextCache(key, Date.now())?.body).toBe('memory written after the snapshot');
      stagePendingRestore(f.snapshotName);
      expect((await applyPendingRestore(f.dbPath, f.backupsDir))?.ok).toBe(true);
      expect(readNote(f.dbPath)).toBe('memory from the restored snapshot');
      // The hook reads these files directly, before the new cache service starts.
      for (const key of f.keys) expect(readContextCache(key, Date.now())).toBeNull();
      expect(readFileSync(f.indexPath, 'utf8')).toBe(f.indexBefore);

      const nextWorker = f.newService();
      nextWorker.start();
      expect(nextWorker.knownVariantCount()).toBe(2);
      await nextWorker.flushPendingRenders();
      for (const key of f.keys) expect(readContextCache(key, Date.now())?.body).toBe('memory from the restored snapshot');
    } finally { f.cleanup(); }
  });

  it('keeps the committed restore successful and clears other blocks if one removal fails', async () => {
    const f = await fixture();
    const blocked = contextCacheFilePath(f.keys[0]);
    const unlink = fs.unlinkSync;
    const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation(path => {
      if (String(path) === blocked) throw Object.assign(new Error('cache file is in use'), { code: 'EACCES' });
      unlink(path);
    });
    try {
      stagePendingRestore(f.snapshotName);
      expect((await applyPendingRestore(f.dbPath, f.backupsDir))?.ok).toBe(true);
      expect(readNote(f.dbPath)).toBe('memory from the restored snapshot');
      expect(readContextCache(f.keys[1], Date.now())).toBeNull();
    } finally { unlinkSpy.mockRestore(); f.cleanup(); }
  });

  for (const stageMissingSnapshot of [false, true]) {
    it(`keeps current blocks when ${stageMissingSnapshot ? 'the restore is rejected' : 'no restore is staged'}`, async () => {
      const f = await fixture();
      try {
        if (stageMissingSnapshot) stagePendingRestore('claude-mem-missing.db');
        const result = await applyPendingRestore(f.dbPath, f.backupsDir);
        if (stageMissingSnapshot) expect(result?.ok).toBe(false);
        else expect(result).toBeNull();
        expect(readNote(f.dbPath)).toBe('memory written after the snapshot');
        for (const key of f.keys) expect(readContextCache(key, Date.now())?.body).toBe('memory written after the snapshot');
        expect(readFileSync(f.indexPath, 'utf8')).toBe(f.indexBefore);
      } finally { f.cleanup(); }
    });
  }
});
