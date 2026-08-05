// tests/server/backup-routes.test.ts
import { describe, it, expect, afterEach, afterAll } from 'bun:test';
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
