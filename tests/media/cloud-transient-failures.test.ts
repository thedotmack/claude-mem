import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MediaCloudClient, type CloudUploadManifest } from '../../src/services/media/cloud.js';

const id = '11111111-1111-4111-8111-111111111111';
const bytes = Buffer.from('test-image');
const variant = { sha256: createHash('sha256').update(bytes).digest('hex'), width: 1, height: 1, byteLength: bytes.length, mimeType: 'image/webp' as const };
const descriptor = { id, state: 'ready', recipe: 'screenshot-v1', encoder: 'sharp-0.35.5/vips-8.17.3', viewer: variant, llm: variant };
const manifest = { id, canonical: variant } as CloudUploadManifest;
const client = (response: () => Response) => new MediaCloudClient({ baseUrl: 'https://media.test', token: 'test', fetchImpl: (async () => response()) as typeof fetch });

test('HTTP 408 keeps uploads and replica reads eligible for the existing backoff', async () => {
  const timeout = client(() => new Response('Request Timeout', { status: 408 }));
  assert.equal((await timeout.upload(manifest, bytes)).kind, 'retry');
  assert.equal((await timeout.describe(id)).kind, 'retry');
  assert.equal((await timeout.readVariant(id, 'viewer', variant)).kind, 'retry');
});

test('an interrupted descriptor response remains a transient replica failure', async () => {
  const interrupted = client(() => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('socket closed')); } })));
  assert.deepEqual(await interrupted.describe(id), { kind: 'retry', code: 'storage_unavailable' });
});

test('an interrupted image body remains eligible for a later replica read', async () => {
  const interrupted = client(() => new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('deadline expired', 'TimeoutError')); } })));
  assert.deepEqual(await interrupted.readVariant(id, 'viewer', variant), { kind: 'retry', code: 'storage_unavailable' });
});

test('deterministic descriptor, size and checksum failures stay final', async () => {
  assert.deepEqual(await client(() => new Response('{}')).describe(id), { kind: 'final', code: 'invalid_manifest' });
  assert.deepEqual(await client(() => new Response('not JSON')).describe(id), { kind: 'final', code: 'invalid_manifest' });
  assert.deepEqual(await client(() => new Response(bytes, { headers: { 'content-length': '999999999' } })).readVariant(id, 'viewer', variant), { kind: 'final', code: 'source_too_large' });
  assert.deepEqual(await client(() => new Response('wrong bytes')).readVariant(id, 'viewer', variant), { kind: 'final', code: 'checksum_mismatch' });
  assert.equal((await client(() => new Response('{}', { status: 400 })).upload(manifest, bytes)).kind, 'final');
});

test('valid descriptor and image responses preserve their payloads', async () => {
  const described = await client(() => Response.json(descriptor)).describe(id);
  assert.equal(described.kind, 'ok');
  const image = await client(() => new Response(bytes)).readVariant(id, 'viewer', variant);
  assert.equal(image.kind, 'ok');
  if (image.kind === 'ok') assert.deepEqual(image.value, bytes);
});
