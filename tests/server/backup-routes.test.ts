// tests/server/backup-routes.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claude-mem-backup-routes-test-'));
const PREVIOUS_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;

const { Server } = await import('../../src/services/server/Server.js');
const { BackupRoutes, BACKUP_ALLOWLIST } = await import('../../src/services/worker/http/routes/BackupRoutes.js');
const { paths } = await import('../../src/shared/paths.js');

/**
 * NOTE ON ISOLATION: the mkdtemp + CLAUDE_MEM_DATA_DIR override above is INERT
 * whenever another test file already imported src/shared/paths.js first —
 * paths.ts freezes DATA_DIR at first module evaluation and bun runs the whole
 * suite in one process. paths.dataDir() here is therefore usually the run-wide
 * dir from tests/preload.ts, SHARED with every other test file. This file
 * resets only the basenames it owns (the BACKUP_ALLOWLIST surface plus their
 * ".importing" staging counterparts) before every test and again at the end,
 * and never asserts that the directory is otherwise empty.
 */
function resetOwnedFiles(): void {
  if (!existsSync(paths.dataDir())) return;
  for (const basename of BACKUP_ALLOWLIST) {
    rmSync(path.join(paths.dataDir(), basename), { force: true });
    rmSync(path.join(paths.dataDir(), `${basename}.importing`), { force: true });
  }
}

beforeEach(() => {
  resetOwnedFiles();
});

/**
 * /api/backup/import now uses flushResponseThen (the /api/admin/restart
 * contract), which calls process.exit(0) once the deferred action settles.
 * Neutralize it for this file so a restore test cannot kill the test runner,
 * and restore the real implementation afterwards.
 */
const realProcessExit = process.exit;
const exitCalls: number[] = [];

beforeAll(() => {
  (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
    exitCalls.push(code ?? 0);
  };
});

afterAll(() => {
  (process as unknown as { exit: typeof realProcessExit }).exit = realProcessExit;
  if (PREVIOUS_DATA_DIR === undefined) {
    delete process.env.CLAUDE_MEM_DATA_DIR;
  } else {
    process.env.CLAUDE_MEM_DATA_DIR = PREVIOUS_DATA_DIR;
  }
  resetOwnedFiles();
  rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function baseOptions() {
  return {
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: () => Promise.resolve(),
    onRestart: () => Promise.resolve(),
    workerPath: '',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
  };
}

/**
 * Bind to port 0 and read back what the OS assigned. The previous
 * `4X000 + random(9000)` scheme reaches into 49152-65535, which is Windows'
 * dynamic/ephemeral range, so it raced live outbound connections and produced
 * real EADDRINUSE failures in a full-suite run. Port 0 cannot collide.
 */
async function listenOnFreePort(server: InstanceType<typeof Server>): Promise<number> {
  await server.listen(0, '127.0.0.1');
  const address = server.getHttpServer()!.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address after listen()');
  }
  return address.port;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      timer.unref?.();
    }),
  ]);
}

describe('BackupRoutes export', () => {
  let server: InstanceType<typeof Server> | null = null;

  afterEach(async () => {
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
    server = null;
  });

  it('zips only the files that exist, skipping missing wal/shm', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(paths.database(), 'fake-db-content');
    writeFileSync(paths.settings(), '{"a":1}');
    // Deliberately no .db-shm / .db-wal / .env — export must not error.

    server = new Server(baseOptions());
    server.registerRoutes(new BackupRoutes(() => Promise.resolve()));
    server.finalizeRoutes();
    const port = await listenOnFreePort(server);

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');

    const buffer = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(buffer);
    const names = zip.getEntries().map(e => e.entryName).sort();
    expect(names).toEqual(['claude-mem.db', 'settings.json']);
    expect(zip.getEntry('claude-mem.db')!.getData().toString()).toBe('fake-db-content');
  });
});

describe('BackupRoutes import', () => {
  let server: InstanceType<typeof Server> | null = null;

  afterEach(async () => {
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
    server = null;
  });

  async function startServer(restartWorker: () => Promise<void>) {
    server = new Server(baseOptions());
    server.registerRoutes(new BackupRoutes(restartWorker));
    server.finalizeRoutes();
    const port = await listenOnFreePort(server);
    return port;
  }

  it('rejects a malformed zip with 400 and does not touch disk', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    const port = await startServer(() => Promise.resolve());

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: Buffer.from('this is not a zip file'),
    });

    expect(res.status).toBe(400);
    expect(existsSync(path.join(paths.dataDir(), 'claude-mem.db.importing'))).toBe(false);
  });

  it('rejects a valid zip with zero recognized entries', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    const port = await startServer(() => Promise.resolve());

    const zip = new AdmZip();
    zip.addFile('unrelated-file.txt', Buffer.from('hello'));

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: zip.toBuffer(),
    });

    expect(res.status).toBe(400);
  });

  it('stages allowlisted entries, backs up existing files, and triggers a restart', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(paths.database(), 'old-db');
    writeFileSync(paths.settings(), '{"old":true}');

    let restartCalled = false;
    let signalRestart: () => void = () => {};
    const restarted = new Promise<void>(resolve => { signalRestart = resolve; });
    const port = await startServer(() => {
      restartCalled = true;
      signalRestart();
      return Promise.resolve();
    });

    const zip = new AdmZip();
    zip.addFile('claude-mem.db', Buffer.from('new-db'));
    zip.addFile('settings.json', Buffer.from('{"new":true}'));
    // Zip-slip attempt: this entry's own path must be ignored — only its
    // basename ("settings.json") is meaningful, and that basename is already
    // present above, so this must not create anything outside DATA_DIR.
    zip.addFile('../../evil.txt', Buffer.from('should never land on disk'));

    // dataDir/.. is the shared OS temp root; clear the exact path first so the
    // absence assertion below is about THIS request, not about the directory
    // happening to be pristine.
    const evilPath = path.join(paths.dataDir(), '..', 'evil.txt');
    rmSync(evilPath, { force: true });

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: zip.toBuffer(),
    });

    expect(res.status).toBe(200);
    await withTimeout(restarted, 5000, 'deferred restart');
    expect(restartCalled).toBe(true);
    expect(existsSync(path.join(paths.dataDir(), 'claude-mem.db.importing'))).toBe(true);
    expect(existsSync(path.join(paths.dataDir(), 'settings.json.importing'))).toBe(true);
    expect(existsSync(evilPath)).toBe(false);

    const backupDirs = readdirSync(path.join(paths.dataDir(), 'backups'));
    expect(backupDirs.some((d: string) => d.startsWith('backup-restore-'))).toBe(true);
  });

  it('defers the restart until the response has been flushed', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });

    const order: string[] = [];
    let signalRestart: () => void = () => {};
    const restarted = new Promise<void>(resolve => { signalRestart = resolve; });

    const port = await startServer(() => {
      order.push('restart');
      signalRestart();
      return Promise.resolve();
    });

    // Observe the real response lifecycle: 'finish' fires once the response has
    // been handed to the socket. Firing restartWorker() inline (the old
    // `res.json(); void this.restartWorker();`) records 'restart' BEFORE
    // 'finish'; flushResponseThen records it after.
    server!.getHttpServer()!.on('request', (_req, res) => {
      res.on('finish', () => order.push('finish'));
    });

    const zip = new AdmZip();
    zip.addFile('settings.json', Buffer.from('{"deferred":true}'));

    const exitCountBefore = exitCalls.length;
    const res = await fetch(`http://127.0.0.1:${port}/api/backup/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: zip.toBuffer(),
    });
    expect(res.status).toBe(200);
    await res.json();

    await withTimeout(restarted, 5000, 'deferred restart');
    expect(order).toEqual(['finish', 'restart']);

    // flushResponseThen's contract also includes exiting once the deferred
    // action settles (process.exit is stubbed for this file).
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(exitCalls.length).toBeGreaterThan(exitCountBefore);
  });
});

describe('BackupRoutes standalone file import', () => {
  let server: InstanceType<typeof Server> | null = null;

  afterEach(async () => {
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
    server = null;
  });

  async function startServer() {
    server = new Server(baseOptions());
    server.registerRoutes(new BackupRoutes(() => Promise.resolve()));
    server.finalizeRoutes();
    const port = await listenOnFreePort(server);
    return port;
  }

  it('writes settings.json directly, no restart, no staging', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    const port = await startServer();

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/import/file?name=settings.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('{"imported":true}'),
    });

    expect(res.status).toBe(200);
    expect(readFileSync(paths.settings(), 'utf-8')).toBe('{"imported":true}');
    expect(existsSync(path.join(paths.dataDir(), 'settings.json.importing'))).toBe(false);
  });

  it('rejects malformed JSON for settings.json without writing', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(paths.settings(), '{"original":true}');
    const port = await startServer();

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/import/file?name=settings.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('{not valid json'),
    });

    expect(res.status).toBe(400);
    expect(readFileSync(paths.settings(), 'utf-8')).toBe('{"original":true}');
  });

  it('rejects an unrecognized name parameter', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    const port = await startServer();

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/import/file?name=claude-mem.db`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('anything'),
    });

    expect(res.status).toBe(400);
  });

  it('writes .env directly without JSON validation', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    const port = await startServer();

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/import/file?name=.env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('SOME_KEY=value\n'),
    });

    expect(res.status).toBe(200);
    expect(readFileSync(paths.envFile(), 'utf-8')).toBe('SOME_KEY=value\n');
  });

  // POSIX-only: Windows has no mode bits beyond the read-only flag.
  it.skipIf(process.platform === 'win32')(
    'writes .env with 0600 permissions, even over a world-readable file',
    async () => {
      mkdirSync(paths.dataDir(), { recursive: true });
      // Pre-existing 0644 file: writeFileSync's `mode` option is ignored when
      // the file already exists, so only an explicit chmod fixes this.
      writeFileSync(paths.envFile(), 'OLD=1\n', { mode: 0o644 });
      const port = await startServer();

      const res = await fetch(`http://127.0.0.1:${port}/api/backup/import/file?name=.env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.from('ANTHROPIC_API_KEY=secret\n'),
      });

      expect(res.status).toBe(200);
      expect(statSync(paths.envFile()).mode & 0o777).toBe(0o600);
    }
  );
});

describe('BackupRoutes localhost enforcement', () => {
  let server: InstanceType<typeof Server> | null = null;

  afterEach(async () => {
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
    server = null;
  });

  /**
   * requireLocalhost reads req.ip. Enabling `trust proxy` makes express derive
   * req.ip from X-Forwarded-For, which is the only way to present a non-local
   * client to a server we can only reach over loopback. The middleware itself
   * is exercised unchanged.
   */
  async function startServerTrustingProxy() {
    server = new Server(baseOptions());
    server.app.set('trust proxy', true);
    server.registerRoutes(new BackupRoutes(() => Promise.resolve()));
    server.finalizeRoutes();
    const port = await listenOnFreePort(server);
    return port;
  }

  const REMOTE = { 'X-Forwarded-For': '203.0.113.9' };

  it('rejects a non-localhost export with 403 and does not leak the backup zip', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(paths.envFile(), 'ANTHROPIC_API_KEY=secret\n');
    const port = await startServerTrustingProxy();

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/export`, { headers: REMOTE });

    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain('ANTHROPIC_API_KEY');
  });

  it('rejects a non-localhost zip import with 403 and stages nothing', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    const port = await startServerTrustingProxy();

    const zip = new AdmZip();
    zip.addFile('claude-mem.db', Buffer.from('attacker-db'));

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', ...REMOTE },
      body: zip.toBuffer(),
    });

    expect(res.status).toBe(403);
    expect(existsSync(path.join(paths.dataDir(), 'claude-mem.db.importing'))).toBe(false);
  });

  it('rejects a non-localhost standalone file import with 403 and writes nothing', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    const port = await startServerTrustingProxy();

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/import/file?name=.env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...REMOTE },
      body: Buffer.from('ANTHROPIC_API_KEY=attacker\n'),
    });

    expect(res.status).toBe(403);
    expect(existsSync(paths.envFile())).toBe(false);
  });

  it('still allows the same requests from loopback', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(paths.settings(), '{"a":1}');
    const port = await startServerTrustingProxy();

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/export`);
    expect(res.status).toBe(200);
  });
});

describe('BackupRoutes export/import round trip', () => {
  let server: InstanceType<typeof Server> | null = null;

  afterEach(async () => {
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
    server = null;
  });

  it('export then import restores byte-identical file content (staged, pre-restart)', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(paths.database(), 'round-trip-db-content');
    writeFileSync(paths.settings(), '{"roundTrip":true}');

    server = new Server(baseOptions());
    server.registerRoutes(new BackupRoutes(() => Promise.resolve()));
    server.finalizeRoutes();
    const port = await listenOnFreePort(server);

    // Export.
    const exportRes = await fetch(`http://127.0.0.1:${port}/api/backup/export`);
    const zipBuffer = Buffer.from(await exportRes.arrayBuffer());

    // Mutate the live files, simulating drift since the export.
    writeFileSync(paths.database(), 'mutated-after-export');
    writeFileSync(paths.settings(), '{"mutated":true}');

    // Import the original export back.
    const importRes = await fetch(`http://127.0.0.1:${port}/api/backup/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: zipBuffer,
    });
    expect(importRes.status).toBe(200);

    // Import only stages — applying happens in the restart handoff (Task 2),
    // which this test does not run end-to-end (no live worker process here).
    // Assert the staged content matches the ORIGINAL export, proving the
    // round trip preserved bytes up to the point where the real restart
    // sequence would apply them.
    const { applyPendingSwaps } = await import('../../src/services/infrastructure/PendingSwap.js');
    const swapped = applyPendingSwaps();

    expect(swapped.sort()).toEqual(['claude-mem.db', 'settings.json']);
    expect(readFileSync(paths.database(), 'utf-8')).toBe('round-trip-db-content');
    expect(readFileSync(paths.settings(), 'utf-8')).toBe('{"roundTrip":true}');
  });

  it('drops a stale -wal left behind when the restored zip has no wal entry', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(paths.database(), 'db-at-export-time');
    writeFileSync(paths.settings(), '{"roundTrip":true}');
    // No -wal at export time, so the zip contains none.

    server = new Server(baseOptions());
    server.registerRoutes(new BackupRoutes(() => Promise.resolve()));
    server.finalizeRoutes();
    const port = await listenOnFreePort(server);

    const exportRes = await fetch(`http://127.0.0.1:${port}/api/backup/export`);
    const zipBuffer = Buffer.from(await exportRes.arrayBuffer());
    expect(new AdmZip(zipBuffer).getEntry('claude-mem.db-wal')).toBeNull();

    // Between export and restore the live db accumulated a WAL.
    writeFileSync(paths.database(), 'db-drifted');
    writeFileSync(`${paths.database()}-wal`, 'frames-for-the-drifted-db');

    const importRes = await fetch(`http://127.0.0.1:${port}/api/backup/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: zipBuffer,
    });
    expect(importRes.status).toBe(200);

    const { applyPendingSwaps } = await import('../../src/services/infrastructure/PendingSwap.js');
    applyPendingSwaps();

    expect(readFileSync(paths.database(), 'utf-8')).toBe('db-at-export-time');
    // The orphaned WAL belongs to the drifted database — SQLite would replay
    // its frames into the restored file.
    expect(existsSync(`${paths.database()}-wal`)).toBe(false);
  });
});
