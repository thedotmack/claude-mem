import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { MediaCloudClient, MediaCloudSync } from '../../src/services/media/cloud.js';

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const bytes = Buffer.from('retained screenshot');
const variant = { width: 1, height: 1, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: 'image/webp' };

function fixture(count = 2) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE media_attachments (
    id TEXT PRIMARY KEY, origin TEXT DEFAULT 'native', state TEXT DEFAULT 'ready',
    upload_state TEXT DEFAULT 'pending', upload_attempts INTEGER DEFAULT 0,
    upload_retry_at INTEGER DEFAULT 0, created_at INTEGER, provenance TEXT,
    encoder_version TEXT, variants TEXT, upload_error TEXT);
    CREATE TABLE media_cloud_deletions (attachment_id TEXT PRIMARY KEY, attempts INTEGER DEFAULT 0,
    retry_at INTEGER DEFAULT 0, last_error TEXT, queued_at INTEGER);`);
  for (const [index, id] of ids.slice(0, count).entries()) {
    const provenance = { version: 1, attachment_id: id, platform: 'claude-code',
      event_identity: { kind: 'platform_event', id: `event-${index}` }, source_shape: 'anthropic_base64',
      source_pointer: '/content/1', source_index: 0, source_sha256: variant.sha256, recipe: 'screenshot-v1' };
    db.prepare('INSERT INTO media_attachments (id,created_at,provenance,encoder_version,variants) VALUES (?,?,?,?,?)')
      .run(id, index, JSON.stringify(provenance), 'sharp-0.35.5/vips-8.17.3', JSON.stringify({ viewer: variant }));
  }
  let enabled = true;
  const uploaded: string[] = [];
  const deleted: string[] = [];
  let onRead = () => {};
  let onUpload = () => {};
  const client = new MediaCloudClient({ baseUrl: 'https://media.test', token: 'test', fetchImpl: (async (_url, init) => {
    if (init?.method === 'DELETE') { deleted.push(String(_url)); return new Response(null, { status: 204 }); }
    const manifest = JSON.parse(String((init?.body as FormData).get('manifest')));
    uploaded.push(manifest.id); onUpload();
    return Response.json({ id: manifest.id, state: 'ready', recipe: 'screenshot-v1', encoder: manifest.encoder, viewer: variant, llm: variant });
  }) as typeof fetch });
  const sync = new MediaCloudSync(db, { readVariant: async () => { onRead(); return bytes; } }, client, { uploadsEnabled: () => enabled, now: () => 100 });
  return { db, sync, uploaded, deleted, setEnabled: (value: boolean) => { enabled = value; },
    onRead: (fn: () => void) => { onRead = fn; }, onUpload: (fn: () => void) => { onUpload = fn; } };
}

test('disabling image uploads during a batch stops the next attachment', async () => {
  const f = fixture();
  try {
    f.onUpload(() => f.setEnabled(false));
    assert.equal((await f.sync.drain()).uploaded, 1);
    assert.deepEqual(f.uploaded, [ids[0]]);
    assert.equal((f.db.prepare('SELECT upload_state FROM media_attachments WHERE id=?').get(ids[1]) as { upload_state: string }).upload_state, 'pending');
    f.onUpload(() => {}); f.setEnabled(true);
    assert.equal((await f.sync.drain()).uploaded, 1);
    assert.deepEqual(f.uploaded, ids);
  } finally { f.db.close(); }
});

test('revoking upload consent during a file read prevents a new network send', async () => {
  const f = fixture(1);
  try {
    f.onRead(() => f.setEnabled(false));
    assert.equal((await f.sync.drain()).uploaded, 0);
    assert.deepEqual(f.uploaded, []);
    f.onRead(() => {}); f.setEnabled(true);
    assert.equal((await f.sync.drain()).uploaded, 1);
  } finally { f.db.close(); }
});

test('queued cloud deletions still complete with uploads disabled', async () => {
  const f = fixture(1);
  try {
    f.setEnabled(false);
    f.db.prepare('INSERT INTO media_cloud_deletions (attachment_id,queued_at) VALUES (?,0)').run(ids[0]);
    const result = await f.sync.drain();
    assert.equal(result.deleted, 1); assert.equal(result.uploaded, 0);
    assert.equal(f.deleted.length, 1); assert.deepEqual(f.uploaded, []);
  } finally { f.db.close(); }
});
