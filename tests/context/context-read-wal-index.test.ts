import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * #5429: the context reader opens the WAL database read-only. That open
 * needs the wal-index (-shm file); when the index is missing and the
 * reader cannot establish it, every read through the worker fails with
 * "unable to open database file" while the writer keeps working. These
 * scenarios drive the real ContextReadWorkerClient against a database in
 * that state: committed frames still only in the -wal (the writer was
 * killed before a checkpoint), the -shm removed, and the data directory
 * made unwritable for the reader so no open can establish the index in
 * place (a read-only bind mount when running as root, permissions
 * otherwise).
 */

function runChild(script: string, dataDir: string): any {
  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_MEM_DATA_DIR: dataDir,
      CLAUDE_CONFIG_DIR: dataDir,
      CLAUDE_MEM_TELEMETRY_ENABLED: 'false',
    },
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
}

function seedDatabase(dataDir: string): void {
  runChild(`
    import { SessionStore } from './src/services/sqlite/SessionStore.ts';
    const store = new SessionStore(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
    const session = store.createSDKSession('seed-content', 'app', 'seed prompt');
    store.ensureMemorySessionIdRegistered(session, 'seed-memory');
    store.storeObservation('seed-memory', 'app', {
      type: 'discovery', title: 'SEEDED_RECORD', subtitle: null,
      facts: [], narrative: 'seeded narrative', concepts: [],
      files_read: [], files_modified: [],
    }, 1, 0, 1_700_000_000_000);
    store.close();
    console.log(JSON.stringify({ seeded: true }));
  `, dataDir);
}

/** Add a committed 'walonly' session that exists only in the -wal, then lose the -shm. */
function leaveFramesOnlyInWal(dataDir: string): void {
  const result = Bun.spawnSync([process.execPath, '-e', `
    import { Database } from 'bun:sqlite';
    const db = new Database(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
    db.run('PRAGMA wal_autocheckpoint = 0');
    db.run("INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, user_prompt, started_at, started_at_epoch, status) VALUES ('wal-content', 'wal-memory', 'walonly', 'wal prompt', '2023-11-14', 1700000001000, 'active')");
    process.kill(process.pid, 'SIGKILL');
  `], {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: dataDir },
  });
  if (result.exitCode === 0) throw new Error('writer child should have been killed');
  const shm = join(dataDir, 'claude-mem.db-shm');
  if (existsSync(shm)) rmSync(shm);
  if (!existsSync(join(dataDir, 'claude-mem.db-wal'))) throw new Error('seed did not leave a -wal behind');
}

/** Make the data directory unable to grow a wal-index; returns the undo. */
function blockWalIndexInPlace(dataDir: string): () => void {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    // chmod does not bind root; a read-only bind mount does.
    const mount = Bun.spawnSync(['mount', '--bind', dataDir, dataDir]);
    if (mount.exitCode !== 0) throw new Error('bind mount failed: ' + new TextDecoder().decode(mount.stderr));
    const remount = Bun.spawnSync(['mount', '-o', 'remount,bind,ro', dataDir]);
    if (remount.exitCode !== 0) throw new Error('read-only remount failed: ' + new TextDecoder().decode(remount.stderr));
    return () => { Bun.spawnSync(['umount', dataDir]); };
  }
  for (const entry of readdirSync(dataDir)) chmodSync(join(dataDir, entry), 0o644);
  chmodSync(dataDir, 0o555);
  return () => { chmodSync(dataDir, 0o755); };
}

function readThroughWorker(dataDir: string): any {
  return runChild(`
    import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';
    const reader = new ContextReadWorkerClient();
    const out = {};
    try { out.appKeys = await reader.readKeys(['app']); } catch (error) { out.appKeysError = error.message; }
    try { out.walKeys = await reader.readKeys(['walonly']); } catch (error) { out.walKeysError = error.message; }
    try { out.hasObservations = await reader.hasObservations(['app']); } catch (error) { out.hasObsError = error.message; }
    await reader.close();
    console.log(JSON.stringify(out));
  `, dataDir);
}

describe('context reader when the wal-index cannot be established (#5429)', () => {
  it('still reads, including frames only in the -wal', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-reader-wal-index-'));
    let unblock = () => {};
    try {
      seedDatabase(dataDir);
      leaveFramesOnlyInWal(dataDir);
      unblock = blockWalIndexInPlace(dataDir);
      const result = readThroughWorker(dataDir);
      expect(result.appKeysError).toBeUndefined();
      expect(result.appKeys).toContain('app');
      // 'walonly' was never checkpointed: only a reader that replays the
      // -wal (directly, or via its snapshot) can see it.
      expect(result.walKeysError).toBeUndefined();
      expect(result.walKeys).toContain('walonly');
      expect(result.hasObsError).toBeUndefined();
      expect(result.hasObservations).toBe(true);
    } finally {
      unblock();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('reads a healthy database exactly as before', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-reader-healthy-'));
    try {
      seedDatabase(dataDir);
      const result = readThroughWorker(dataDir);
      expect(result.appKeys).toContain('app');
      expect(result.hasObservations).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('still refuses a missing database without creating it', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'claude-mem-reader-missing-'));
    try {
      const result = runChild(`
        import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';
        const reader = new ContextReadWorkerClient();
        const message = await reader.readKeys(['app']).then(() => null, error => error.message);
        await reader.close();
        console.log(JSON.stringify({ message }));
      `, dataDir);
      expect(result.message).toContain('unable to open database file');
      expect(existsSync(join(dataDir, 'claude-mem.db'))).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
