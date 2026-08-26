
// Pro-backup plan Phase 3: BackupManager's cloud-upload step. fetch is
// injected (CloudSync options.fetchImpl pattern) so these tests assert the
// wire contract without a network: auth headers ride both requests, the PUT
// body is streamed (never a buffered string), status() gains the upload
// fields, upload is skipped when CLAUDE_MEM_BACKUP_CLOUD is off or the
// credentials are missing, key minting persists to settings.json (legacy
// {env:{}} nesting tolerated), persistence failure fails closed, and the
// token NEVER appears in log output.

import { describe, it, expect, afterEach, beforeEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BackupManager } from '../../src/services/backup/BackupManager.js';
import { decryptFile } from '../../src/services/backup/backup-crypto.js';
import { logger } from '../../src/utils/logger.js';

const TOKEN = 'cm_pro_secret-token-do-not-log';
const USER_ID = 'user-upload-1';
const DEVICE_ID = 'device-upload-1';
const HUB_URL = 'https://sync.test';
const KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');

let tempRoot: string | undefined;
let loggerSpies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  loggerSpies.forEach(spy => spy.mockRestore());
  mock.restore();
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }
  tempRoot = undefined;
});

function createSourceDb(dir: string): string {
  const dbPath = join(dir, 'claude-mem.db');
  const db = new Database(dbPath);
  db.run('CREATE TABLE observations (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO observations (note) VALUES (?)');
  for (let i = 0; i < 10; i++) insert.run(`observation ${i}`);
  db.close();
  return dbPath;
}

function cloudSettings(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    CLAUDE_MEM_BACKUP_CLOUD: 'true',
    CLAUDE_MEM_BACKUP_ENCRYPTION_KEY: KEY_BASE64,
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: TOKEN,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: USER_ID,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: HUB_URL,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: DEVICE_ID,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  init: RequestInit & { duplex?: string };
}

/** Happy-path hub mock: upload-url then PUT. Records every call. */
function makeHubFetch(calls: RecordedCall[], putBodies: Buffer[]): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/backup/upload-url')) {
      return Response.json({
        key: `backups/${USER_ID}/${DEVICE_ID}/1756200000000-abcd1234.db.enc`,
        url: `${HUB_URL}/v1/backup/object/1756200000000-abcd1234`,
      });
    }
    if (url.includes('/v1/backup/object/')) {
      putBodies.push(Buffer.from(await new Response(init.body).arrayBuffer()));
      return Response.json({ key: `backups/${USER_ID}/${DEVICE_ID}/1756200000000-abcd1234.db.enc`, size: putBodies[putBodies.length - 1].length });
    }
    return Response.json({ error: 'unexpected url' }, { status: 500 });
  }) as unknown as typeof fetch;
}

function makeManager(dir: string, settings: Record<string, string>, fetchImpl: typeof fetch, options: Record<string, unknown> = {}): BackupManager {
  return new BackupManager(settings, {
    dbPath: join(dir, 'claude-mem.db'),
    backupsDir: join(dir, 'backups', 'auto'),
    preflightDir: dir,
    fetchImpl,
    settingsPath: join(dir, 'settings.json'),
    ...options,
  });
}

function allLoggedText(): string {
  return JSON.stringify(loggerSpies.flatMap(spy => spy.mock.calls));
}

describe('BackupManager cloud upload', () => {
  it('encrypts + uploads after a snapshot: auth headers, streamed body, status fields', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-upload-'));
    createSourceDb(tempRoot);
    const calls: RecordedCall[] = [];
    const putBodies: Buffer[] = [];
    const manager = makeManager(tempRoot, cloudSettings(), makeHubFetch(calls, putBodies));

    const snapshot = await manager.runNow();
    expect(snapshot).not.toBeNull();
    expect(calls.length).toBe(2);

    // Request 1: POST upload-url with the CloudSync auth header set.
    const [uploadUrlCall, putCall] = calls;
    expect(uploadUrlCall.url).toBe(`${HUB_URL}/v1/backup/upload-url`);
    expect(uploadUrlCall.init.method).toBe('POST');
    const headers1 = uploadUrlCall.init.headers as Record<string, string>;
    expect(headers1['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers1['X-User-Id']).toBe(USER_ID);
    expect(headers1['X-Device-Id']).toBe(DEVICE_ID);

    // Request 2: PUT to the returned url, body STREAMED (never a string/Buffer).
    expect(putCall.url).toBe(`${HUB_URL}/v1/backup/object/1756200000000-abcd1234`);
    expect(putCall.init.method).toBe('PUT');
    expect(putCall.init.body instanceof ReadableStream).toBe(true);
    expect(putCall.init.duplex).toBe('half');
    const headers2 = putCall.init.headers as Record<string, string>;
    expect(headers2['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers2['X-User-Id']).toBe(USER_ID);
    expect(Number(headers2['Content-Length'])).toBe(putBodies[0].length);

    // The uploaded bytes are real ciphertext: they decrypt back to the snapshot.
    const encCopy = join(tempRoot, 'uploaded.enc');
    const decrypted = join(tempRoot, 'uploaded.db');
    writeFileSync(encCopy, putBodies[0]);
    await decryptFile(encCopy, decrypted, KEY_BASE64);
    expect(readFileSync(decrypted).equals(readFileSync(snapshot!.path))).toBe(true);

    // Status fields updated; temp .enc removed from the backups dir.
    const status = manager.status();
    expect(status.cloudEnabled).toBe(true);
    expect(status.lastUploadAt).not.toBeNull();
    expect(status.lastUploadKey).toBe(`backups/${USER_ID}/${DEVICE_ID}/1756200000000-abcd1234.db.enc`);
    expect(status.addonRequired).toBe(false);
    expect(status.lastError).toBeNull();
    expect(readdirSync(join(tempRoot, 'backups', 'auto')).filter(name => name.endsWith('.enc'))).toEqual([]);

    // The token never reaches the logs (tokenLength-only convention).
    expect(allLoggedText()).not.toContain(TOKEN);
  });

  it('skips upload when CLAUDE_MEM_BACKUP_CLOUD is not "true"', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-upload-'));
    createSourceDb(tempRoot);
    const calls: RecordedCall[] = [];
    const manager = makeManager(tempRoot, cloudSettings({ CLAUDE_MEM_BACKUP_CLOUD: 'false' }), makeHubFetch(calls, []));

    await manager.runNow();
    expect(calls.length).toBe(0);
    expect(manager.status().cloudEnabled).toBe(false);
    expect(manager.status().lastUploadAt).toBeNull();
  });

  it('skips upload when cloud-sync credentials are missing (isConfigured predicate)', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-upload-'));
    createSourceDb(tempRoot);
    const calls: RecordedCall[] = [];
    const manager = makeManager(tempRoot, cloudSettings({ CLAUDE_MEM_CLOUD_SYNC_TOKEN: '' }), makeHubFetch(calls, []));

    await manager.runNow();
    expect(calls.length).toBe(0);
    expect(manager.status().cloudEnabled).toBe(false);
  });

  it('mints and persists a 32-byte base64 key on the first cloud-enabled snapshot', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-upload-'));
    createSourceDb(tempRoot);
    const settingsPath = join(tempRoot, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_WORKER_PORT: '37700' }));
    const calls: RecordedCall[] = [];
    const putBodies: Buffer[] = [];
    const manager = makeManager(
      tempRoot,
      cloudSettings({ CLAUDE_MEM_BACKUP_ENCRYPTION_KEY: '' }),
      makeHubFetch(calls, putBodies),
    );

    const snapshot = await manager.runNow();
    expect(calls.length).toBe(2);

    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const minted = persisted.CLAUDE_MEM_BACKUP_ENCRYPTION_KEY;
    expect(typeof minted).toBe('string');
    expect(Buffer.from(minted, 'base64').length).toBe(32);
    // Existing keys survive the read-mutate-write.
    expect(persisted.CLAUDE_MEM_WORKER_PORT).toBe('37700');

    // The upload was encrypted with the minted key.
    const encCopy = join(tempRoot, 'minted.enc');
    const decrypted = join(tempRoot, 'minted.db');
    writeFileSync(encCopy, putBodies[0]);
    await decryptFile(encCopy, decrypted, minted);
    expect(readFileSync(decrypted).equals(readFileSync(snapshot!.path))).toBe(true);
  });

  it('persists the minted key under the legacy {env:{...}} nesting when present', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-upload-'));
    createSourceDb(tempRoot);
    const settingsPath = join(tempRoot, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_MEM_WORKER_PORT: '37700' } }));
    const manager = makeManager(
      tempRoot,
      cloudSettings({ CLAUDE_MEM_BACKUP_ENCRYPTION_KEY: '' }),
      makeHubFetch([], []),
    );

    await manager.runNow();

    const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(Buffer.from(persisted.env.CLAUDE_MEM_BACKUP_ENCRYPTION_KEY, 'base64').length).toBe(32);
    expect(persisted.CLAUDE_MEM_BACKUP_ENCRYPTION_KEY).toBeUndefined();
  });

  it('fails closed when the minted key cannot be persisted: no upload, this session stays disabled', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-upload-'));
    createSourceDb(tempRoot);
    // settingsPath IS a directory: read/write both fail deterministically.
    const settingsPath = join(tempRoot, 'settings-dir');
    mkdirSync(settingsPath);
    const calls: RecordedCall[] = [];
    const manager = makeManager(
      tempRoot,
      cloudSettings({ CLAUDE_MEM_BACKUP_ENCRYPTION_KEY: '' }),
      makeHubFetch(calls, []),
      { settingsPath },
    );

    const snapshot = await manager.runNow();
    expect(snapshot).not.toBeNull(); // local snapshot unaffected
    expect(calls.length).toBe(0);
    expect(manager.status().lastError).toContain('encryption key');

    // Second cycle: still no upload, and no second minting attempt storm.
    await manager.runNow();
    expect(calls.length).toBe(0);
    expect(allLoggedText()).not.toContain(TOKEN);
  });

  it('records lastError and keeps the local snapshot when the hub rejects the upload', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-upload-'));
    createSourceDb(tempRoot);
    const failingFetch = (async () => Response.json({ error: 'boom' }, { status: 503 })) as unknown as typeof fetch;
    const manager = makeManager(tempRoot, cloudSettings(), failingFetch);

    const snapshot = await manager.runNow();
    expect(snapshot).not.toBeNull();
    expect(existsSync(snapshot!.path)).toBe(true);

    const status = manager.status();
    expect(status.lastError).toContain('upload-url 503');
    expect(status.lastUploadAt).toBeNull();
    expect(status.lastUploadKey).toBeNull();
    // Temp .enc cleaned up even on failure.
    expect(readdirSync(join(tempRoot, 'backups', 'auto')).filter(name => name.endsWith('.enc'))).toEqual([]);
    expect(allLoggedText()).not.toContain(TOKEN);
  });

  it('skips upload (and retries next cycle) while no cloud-sync device id exists yet', async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'claude-mem-upload-'));
    createSourceDb(tempRoot);
    const calls: RecordedCall[] = [];
    const putBodies: Buffer[] = [];
    const manager = makeManager(tempRoot, cloudSettings({ CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '' }), makeHubFetch(calls, putBodies));

    await manager.runNow();
    expect(calls.length).toBe(0);

    // CloudSync mints + persists the device id; the next cycle picks it up
    // from settings.json without a worker restart.
    writeFileSync(join(tempRoot!, 'settings.json'), JSON.stringify({ CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: DEVICE_ID }));
    await manager.runNow();
    expect(calls.length).toBe(2);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Device-Id']).toBe(DEVICE_ID);
  });
});
