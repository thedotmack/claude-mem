import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MEDIA_LIMITS, MediaError, validateMediaManifest, validateMediaProvenance,
  validateMediaFailure, validateMediaEventIdentity,
} from '../../src/shared/media-contract.js';

export function runContractChecks(): number {
  const golden = JSON.parse(readFileSync(new URL('../../tests/fixtures/media-v1/contracts.json', import.meta.url), 'utf8'));
  let checks = 0;
  for (const [validKey, invalidKey, validate] of [
    ['valid_manifests', 'invalid_manifests', validateMediaManifest],
    ['valid_provenance', 'invalid_provenance', validateMediaProvenance],
    ['valid_failures', 'invalid_failures', validateMediaFailure],
  ] as const) {
    for (const fixture of golden[validKey]) { assert.deepEqual(validate(fixture), fixture); checks++; }
    for (const fixture of golden[invalidKey]) {
      assert.throws(() => validate(fixture), (error: unknown) => error instanceof MediaError && !/private|base64|raw-original/.test(error.message));
      checks++;
    }
  }
  const refs = Array.from({ length: MEDIA_LIMITS.maxObservationRefs }, (_, index) => ({
    id: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
    label: `event${index}_image1`, inspection: 'uninspected',
  }));
  assert.equal(validateMediaManifest({ version: 1, attachments: refs }).attachments.length, 32); checks++;
  assert.throws(() => validateMediaManifest({ version: 1, attachments: [...refs, { ...refs[0], id: 'ffffffff-1111-4111-8111-111111111111' }] }), (error: unknown) => error instanceof MediaError && error.code === 'manifest_too_large'); checks++;
  assert.equal(validateMediaManifest({ version: 1, attachments: [{ ...refs[0], label: 'a'.repeat(64) }] }).attachments[0].label.length, 64); checks++;
  assert.throws(() => validateMediaManifest({ version: 1, attachments: [{ ...refs[0], label: 'a'.repeat(65) }] })); checks++;
  for (const label of ['file.png', '/source', 'data:image', 'private image', 'image\n1']) {
    assert.throws(() => validateMediaManifest({ version: 1, attachments: [{ ...refs[0], label }] })); checks++;
  }
  assert.throws(() => validateMediaManifest(JSON.parse('{"version":1,"attachments":[],"__proto__":{"source":"private"}}'))); checks++;
  assert.throws(() => validateMediaManifest(new Date())); checks++;
  assert.throws(() => validateMediaManifest({ version: 1, attachments: [], data: 'private-pixels'.repeat(100_000) })); checks++;
  assert.throws(() => validateMediaEventIdentity({ kind: 'platform_event', id: 'toolu_1', timestamp: 1 })); checks++;
  assert.throws(() => validateMediaEventIdentity({ kind: 'transcript_event', transcript_id: 's', record_index: -1, record_sha256: 'a'.repeat(64) })); checks++;
  assert.throws(() => validateMediaEventIdentity({ kind: 'platform_event', id: '/private/path' })); checks++;
  const provenance = golden.valid_provenance[1];
  assert.throws(() => validateMediaProvenance({ ...provenance, source_locator: { kind: 'local_file', path: '../private' } })); checks++;
  assert.throws(() => validateMediaProvenance({ ...provenance, source_locator: { kind: 'local_file', path: '/private\u0000source' } })); checks++;
  assert.throws(() => validateMediaProvenance({ ...provenance, source_locator: { kind: 'url', path: 'https://example.test/image' } })); checks++;
  assert.equal(validateMediaProvenance({ ...provenance, source_locator: { kind: 'local_file', path: 'C:\\fixture\\image.png' } }).source_locator?.path, 'C:\\fixture\\image.png'); checks++;
  assert.throws(() => validateMediaManifest(provenance)); checks++;
  assert.deepEqual(validateMediaManifest(golden.valid_manifests[2]), golden.valid_manifests[2]); checks++;
  return checks;
}
