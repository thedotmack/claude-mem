// tests/server/backup-routes.test.ts
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import AdmZip from 'adm-zip';

const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claude-mem-backup-routes-test-'));
const PREVIOUS_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;

const { Server } = await import('../../src/services/server/Server.js');
const { BackupRoutes, BACKUP_ALLOWLIST } = await import('../../src/services/worker/http/routes/BackupRoutes.js');
const { paths } = await import('../../src/shared/paths.js');

// Every describe below shares this file's module-level TEST_DATA_DIR, and
// several tests intentionally leave allowlisted files (and/or their
// ".importing" staging counterparts) behind on disk as part of what they're
// asserting. Reset the full BACKUP_ALLOWLIST surface before every test in
// this file so no test's leftovers can leak into a later one, regardless of
// run order or what future tests get appended.
beforeEach(() => {
  if (!existsSync(paths.dataDir())) return;
  for (const basename of BACKUP_ALLOWLIST) {
    const target = path.join(paths.dataDir(), basename);
    if (existsSync(target)) rmSync(target, { force: true });
    const staged = path.join(paths.dataDir(), `${basename}.importing`);
    if (existsSync(staged)) rmSync(staged, { force: true });
  }
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

describe('BackupRoutes export', () => {
  let server: InstanceType<typeof Server> | null = null;

  afterEach(async () => {
    if (server?.getHttpServer()) {
      try { await server.close(); } catch { /* ignore */ }
    }
    server = null;
  });

  afterAll(() => {
    if (PREVIOUS_DATA_DIR === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = PREVIOUS_DATA_DIR;
    }
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('zips only the files that exist, skipping missing wal/shm', async () => {
    mkdirSync(paths.dataDir(), { recursive: true });
    writeFileSync(paths.database(), 'fake-db-content');
    writeFileSync(paths.settings(), '{"a":1}');
    // Deliberately no .db-shm / .db-wal / .env — export must not error.

    server = new (await import('../../src/services/server/Server.js')).Server(baseOptions());
    server.registerRoutes(new BackupRoutes(() => Promise.resolve()));
    server.finalizeRoutes();
    const port = 43000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

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
    const { Server } = await import('../../src/services/server/Server.js');
    server = new Server(baseOptions());
    server.registerRoutes(new BackupRoutes(restartWorker));
    server.finalizeRoutes();
    const port = 44000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');
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
    const port = await startServer(() => { restartCalled = true; return Promise.resolve(); });

    const zip = new AdmZip();
    zip.addFile('claude-mem.db', Buffer.from('new-db'));
    zip.addFile('settings.json', Buffer.from('{"new":true}'));
    // Zip-slip attempt: this entry's own path must be ignored — only its
    // basename ("settings.json") is meaningful, and that basename is already
    // present above, so this must not create anything outside DATA_DIR.
    zip.addFile('../../evil.txt', Buffer.from('should never land on disk'));

    const res = await fetch(`http://127.0.0.1:${port}/api/backup/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: zip.toBuffer(),
    });

    expect(res.status).toBe(200);
    expect(restartCalled).toBe(true);
    expect(existsSync(path.join(paths.dataDir(), 'claude-mem.db.importing'))).toBe(true);
    expect(existsSync(path.join(paths.dataDir(), 'settings.json.importing'))).toBe(true);
    expect(existsSync(path.join(paths.dataDir(), '..', 'evil.txt'))).toBe(false);

    const backupDirs = require('fs').readdirSync(path.join(paths.dataDir(), 'backups'));
    expect(backupDirs.some((d: string) => d.startsWith('backup-restore-'))).toBe(true);
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
    const { Server } = await import('../../src/services/server/Server.js');
    server = new Server(baseOptions());
    server.registerRoutes(new BackupRoutes(() => Promise.resolve()));
    server.finalizeRoutes();
    const port = 45000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');
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
    expect(require('fs').readFileSync(paths.settings(), 'utf-8')).toBe('{"imported":true}');
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
    expect(require('fs').readFileSync(paths.settings(), 'utf-8')).toBe('{"original":true}');
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
    expect(require('fs').readFileSync(paths.envFile(), 'utf-8')).toBe('SOME_KEY=value\n');
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
    const port = 46000 + Math.floor(Math.random() * 9000);
    await server.listen(port, '127.0.0.1');

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
    expect(require('fs').readFileSync(paths.database(), 'utf-8')).toBe('round-trip-db-content');
    expect(require('fs').readFileSync(paths.settings(), 'utf-8')).toBe('{"roundTrip":true}');
  });
});
