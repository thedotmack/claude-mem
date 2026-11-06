import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * #5429: the context reader opens the WAL database read-only. A read-only
 * handle cannot create the -wal or the wal-index (-shm), so when they are
 * missing every read through the worker fails with "unable to open database
 * file" while the writer keeps working. These scenarios drive the real
 * ContextReadWorkerClient against a database in that state, in a data
 * directory the process can write to (the reporter's writer was working).
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

const STORE_OBSERVATION = `
  function storeObservation(store, contentId, memoryId, project, title) {
    const session = store.createSDKSession(contentId, project, 'prompt');
    store.ensureMemorySessionIdRegistered(session, memoryId);
    store.storeObservation(memoryId, project, {
      type: 'discovery', title, subtitle: null,
      facts: [], narrative: 'narrative', concepts: [],
      files_read: [], files_modified: [],
    }, 1, 0, 1_700_000_000_000);
  }
`;

/**
 * A WAL database with one 'app' observation and no -wal or -shm, the state
 * the reporter reproduced with a fresh copy. The last connection's close
 * checkpoints every frame into the database file; some SQLite builds (the
 * macOS system library) still keep the emptied -wal, so remove what is left.
 */
function seedDatabase(dataDir: string): void {
  runChild(`
    import { SessionStore } from './src/services/sqlite/SessionStore.ts';
    ${STORE_OBSERVATION}
    const store = new SessionStore(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
    storeObservation(store, 'seed-content', 'seed-memory', 'app', 'SEEDED_RECORD');
    store.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    store.close();
    console.log(JSON.stringify({ seeded: true }));
  `, dataDir);
  for (const suffix of ['-wal', '-shm']) rmSync(join(dataDir, `claude-mem.db${suffix}`), { force: true });
}

/** Add a 'walonly' observation that exists only in the -wal (writer killed before a checkpoint), then lose the -shm. */
function leaveObservationOnlyInWal(dataDir: string): void {
  const result = Bun.spawnSync([process.execPath, '-e', `
    import { SessionStore } from './src/services/sqlite/SessionStore.ts';
    ${STORE_OBSERVATION}
    const store = new SessionStore(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
    store.db.run('PRAGMA wal_autocheckpoint = 0');
    storeObservation(store, 'wal-content', 'wal-memory', 'walonly', 'WAL_ONLY_RECORD');
    process.kill(process.pid, 'SIGKILL');
  `], {
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_CONFIG_DIR: dataDir, CLAUDE_MEM_TELEMETRY_ENABLED: 'false' },
  });
  if (result.exitCode === 0) throw new Error('writer child should have been killed');
  rmSync(join(dataDir, 'claude-mem.db-shm'), { force: true });
  if (!existsSync(join(dataDir, 'claude-mem.db-wal'))) throw new Error('seed did not leave a -wal behind');
}

/** What a plain read-only open (the reader before #5429) gets from this database. */
function plainReadonlyOpenError(dataDir: string): string | null {
  return runChild(`
    import { Database } from 'bun:sqlite';
    let message = null;
    const db = new Database(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db', { readonly: true, create: false });
    try { db.run('PRAGMA schema_version'); } catch (error) { message = error.message; } finally { db.close(); }
    console.log(JSON.stringify({ message }));
  `, dataDir).message;
}

function readThroughWorker(dataDir: string): any {
  return runChild(`
    import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';
    const reader = new ContextReadWorkerClient();
    const out = {};
    try { out.app = await reader.hasObservations(['app']); } catch (error) { out.appError = error.message; }
    try { out.walonly = await reader.hasObservations(['walonly']); } catch (error) { out.walonlyError = error.message; }
    try { out.search = [
      ...await reader.searchObservations(undefined, { project: 'app', limit: 10, orderBy: 'date_desc' }),
      ...await reader.searchObservations(undefined, { project: 'walonly', limit: 10, orderBy: 'date_desc' }),
    ].map(row => row.title); } catch (error) { out.searchError = error.message; }
    await reader.close();
    console.log(JSON.stringify(out));
  `, dataDir);
}

function withDataDir(prefix: string, body: (dataDir: string) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  try {
    body(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe('context reader when the -wal and wal-index are missing (#5429)', () => {
  it('reads a WAL database that has neither a -wal nor a -shm', () => {
    withDataDir('claude-mem-reader-no-wal-', dataDir => {
      seedDatabase(dataDir);
      // Whether a plain read-only open fails here depends on the SQLite build:
      // the macOS system library (the reporter's, SQLite 3.51.0 on macOS 26)
      // refuses it, while the SQLite Bun embeds on Linux reads it. Where it
      // fails, the fixture must reproduce that, or the read-write recovery
      // below would go unexercised.
      const plainError = plainReadonlyOpenError(dataDir);
      if (process.platform === 'darwin') expect(plainError).toContain('unable to open database file');
      const result = readThroughWorker(dataDir);
      expect(result.appError).toBeUndefined();
      expect(result.app).toBe(true);
      expect(result.walonly).toBe(false);
      expect(result.searchError).toBeUndefined();
      expect(result.search).toContain('SEEDED_RECORD');
    });
  }, 60_000);

  it('reads observations that are only in the -wal when the -shm is gone', () => {
    withDataDir('claude-mem-reader-wal-only-', dataDir => {
      seedDatabase(dataDir);
      leaveObservationOnlyInWal(dataDir);
      const result = readThroughWorker(dataDir);
      expect(result.appError).toBeUndefined();
      expect(result.app).toBe(true);
      // Never checkpointed: only a reader that replays the -wal sees it.
      expect(result.walonlyError).toBeUndefined();
      expect(result.walonly).toBe(true);
      expect(result.searchError).toBeUndefined();
      expect(result.search).toContain('WAL_ONLY_RECORD');
    });
  }, 60_000);

  it('reads a healthy database exactly as before', () => {
    withDataDir('claude-mem-reader-healthy-', dataDir => {
      runChild(`
        import { SessionStore } from './src/services/sqlite/SessionStore.ts';
        import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';
        ${STORE_OBSERVATION}
        const store = new SessionStore(process.env.CLAUDE_MEM_DATA_DIR + '/claude-mem.db');
        storeObservation(store, 'seed-content', 'seed-memory', 'app', 'SEEDED_RECORD');
        const reader = new ContextReadWorkerClient();
        const app = await reader.hasObservations(['app']);
        await reader.close();
        store.close();
        if (app !== true) throw new Error('healthy read missed the seeded observation');
        console.log(JSON.stringify({ app }));
      `, dataDir);
    });
  }, 60_000);

  it('still refuses a missing database without creating it', () => {
    withDataDir('claude-mem-reader-missing-', dataDir => {
      const result = runChild(`
        import { ContextReadWorkerClient } from './src/services/context/ContextReadWorkerClient.ts';
        const reader = new ContextReadWorkerClient();
        const message = await reader.hasObservations(['app']).then(() => null, error => error.message);
        await reader.close();
        console.log(JSON.stringify({ message }));
      `, dataDir);
      expect(result.message).toContain('unable to open database file');
      expect(existsSync(join(dataDir, 'claude-mem.db'))).toBe(false);
    });
  }, 60_000);
});
