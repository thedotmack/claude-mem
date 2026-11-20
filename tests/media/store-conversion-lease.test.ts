import { afterEach, beforeEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { MediaStore } from '../../src/services/media/store.js';
import { convertMedia, LOCAL_ADMISSION_WAIT_MS, LOCAL_CONVERSION_DEADLINE_MS } from '../../src/services/media/converter.js';
import { SQLITE_BUSY_TIMEOUT_MS } from '../../src/services/sqlite/connection.js';

const SCRATCH = join(import.meta.dir, '../../.scratch');
let dir: string;
let db: Database;

beforeEach(() => {
  mkdirSync(SCRATCH, { recursive: true });
  dir = realpathSync(mkdtempSync(join(SCRATCH, 'media-lease-')));
  db = new Database(':memory:');
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

it('reconcile leaves a live conversion alone for its whole admission wait and deadline', async () => {
  const sessions = new SessionStore(db);
  const sessionDbId = sessions.createSDKSession('lease-session', 'project', '');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const store = new MediaStore(db, join(dir, 'data'), async (...args: Parameters<typeof convertMedia>) => {
    await held;
    return convertMedia(...args);
  });
  const bytes = await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 9, g: 80, b: 200, alpha: 1 } } }).png().toBuffer();
  const startedAt = Date.now();
  const capture = store.capture({
    sessionDbId,
    label: 'event1_image1',
    bytes,
    mimeType: 'image/png',
    provenance: {
      version: 1,
      platform: 'claude-code',
      event_identity: { kind: 'platform_event', id: 'a'.repeat(64) },
      source_shape: 'anthropic_base64',
      source_pointer: '/content/0',
      source_index: 0,
      source_sha256: createHash('sha256').update(bytes).digest('hex'),
      recipe: 'screenshot-v1',
    },
  });
  await Bun.sleep(20);
  const state = () => (db.prepare(`SELECT state FROM media_attachments`).get() as { state: string }).state;
  expect(state()).toBe('converting');
  // A capture may wait for the slot and then run to its deadline; reconcile
  // must not fail it in that time (it did at 30 s before the local bounds).
  const liveFor = LOCAL_ADMISSION_WAIT_MS + LOCAL_CONVERSION_DEADLINE_MS + 2 * SQLITE_BUSY_TIMEOUT_MS;
  store.reconcile(startedAt + liveFor - 1_000);
  expect(state()).toBe('converting');
  release();
  const ref = await capture;
  expect(store.getMetadata(ref.id).state).toBe('ready');
});
