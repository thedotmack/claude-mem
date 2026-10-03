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
  return checks + runInferenceFixtureChecks();
}

/** Phase 4 inference/linkage golden fixtures are self-consistent with the frozen v1 bounds. */
function runInferenceFixtureChecks(): number {
  const fixture = (name: string) => readFileSync(new URL(`../../tests/fixtures/media-v1/inference/${name}`, import.meta.url), 'utf8');
  const json = (name: string) => JSON.parse(fixture(name));
  const labelRef = (label: string) => ({ id: '11111111-1111-4111-8111-111111111111', label, inspection: 'uninspected' });
  const decodedBase64Bytes = (base64: string) => base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  const webpDataUrlPrefix = 'data:image/webp;base64,';
  const maxDataUrlChars = webpDataUrlPrefix.length + 4 * Math.ceil(MEDIA_LIMITS.maxDerivativeBytes / 3);
  let checks = 0;

  const request = json('request-two-images.json');
  const messages = request.body.messages as { role: string; content: unknown }[];
  for (const message of messages.slice(0, -1)) { assert.equal(typeof message.content, 'string'); checks++; }
  const parts = messages.at(-1)!.content as { type: string; text?: string; image_url?: { url: string } }[];
  assert.equal(messages.at(-1)!.role, 'user');
  assert.equal(parts[0].type, 'text'); checks++;
  const images = parts.flatMap((part, index) => part.type === 'image_url' ? [{ part, label: parts[index - 1] }] : []);
  assert.ok(images.length <= MEDIA_LIMITS.maxImagesPerEvent);
  assert.equal(images.length, request.request_labels.length); checks++;
  let aggregateDecodedBytes = 0;
  images.forEach(({ part, label }, index) => {
    const expected = request.request_labels[index];
    assert.equal(label.type, 'text');
    assert.equal(label.text, `[image ${expected.request_label}]`);
    validateMediaManifest({ version: 1, attachments: [labelRef(expected.request_label)] });
    validateMediaManifest({ version: 1, attachments: [{ ...labelRef(expected.event_label), id: expected.attachment_id }] });
    const url = part.image_url!.url;
    assert.ok(url.startsWith(webpDataUrlPrefix) && url.length <= maxDataUrlChars);
    const base64 = url.slice(webpDataUrlPrefix.length);
    const bytes = Buffer.from(base64, 'base64');
    assert.equal(bytes.length, decodedBase64Bytes(base64));
    assert.equal(bytes.length, expected.decoded_bytes);
    assert.ok(bytes.length <= MEDIA_LIMITS.maxDerivativeBytes);
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF');
    assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP');
    aggregateDecodedBytes += bytes.length;
    checks++;
  });
  assert.ok(aggregateDecodedBytes <= MEDIA_LIMITS.maxGatewayImageBytes); checks++;
  assert.ok(!/data:image|base64/i.test(fixture('observation-with-refs.xml'))); checks++;

  const capability = json('capability.json');
  const frozenBounds = {
    max_images_per_request: MEDIA_LIMITS.maxImagesPerEvent,
    max_image_decoded_bytes: MEDIA_LIMITS.maxDerivativeBytes,
    max_aggregate_image_decoded_bytes: MEDIA_LIMITS.maxGatewayImageBytes,
    max_aggregate_image_data_url_bytes: MEDIA_LIMITS.maxImagesPerEvent * maxDataUrlChars,
    max_image_dimension: MEDIA_LIMITS.maxDerivativeDimension,
    max_body_bytes: 4 * 1024 * 1024,
    image_mime_types: ['image/webp'],
  };
  assert.equal(frozenBounds.max_aggregate_image_decoded_bytes, frozenBounds.max_images_per_request * frozenBounds.max_image_decoded_bytes); checks++;
  assert.deepEqual(capability.responses.find((response: { name: string }) => response.name === 'qualified').body.bounds, frozenBounds); checks++;
  const responseText = JSON.stringify(capability.responses);
  for (const key of capability.forbidden_response_keys) { assert.ok(!responseText.includes(`"${key}"`)); checks++; }
  for (const response of capability.responses.filter((candidate: { status: number }) => candidate.status === 200)) {
    assert.ok(response.body.supports_image_input === (response.body.reason === null));
    assert.ok(response.body.supports_image_input === (response.body.bounds !== null));
    assert.ok(response.body.reason === null || capability.reasons.includes(response.body.reason));
    checks++;
  }
  for (const qualification of capability.qualification_cases) {
    assert.ok(qualification.expected.reason === null || capability.reasons.includes(qualification.expected.reason));
    checks++;
  }

  const validator = json('validator-cases.json');
  const { accepted_data_url_mime_types: acceptedMimes, ...validatorBounds } = validator.bounds;
  const { image_mime_types: _clientMimes, max_image_dimension: _dimension, ...capabilityBounds } = frozenBounds;
  assert.deepEqual(validatorBounds, capabilityBounds); checks++;
  assert.deepEqual(acceptedMimes, ['image/webp', 'image/png', 'image/jpeg']); checks++;
  for (const rejection of validator.reject) { assert.ok(validator.reasons.includes(rejection.reason)); checks++; }

  const parser = json('parser-outcomes.json');
  for (const parserCase of parser.cases) {
    const supplied = new Set(parserCase.supplied.map((image: { label: string }) => image.label));
    validateMediaManifest({ version: 1, attachments: [...supplied].map((label, index) => ({ ...labelRef(label as string), id: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111` })) });
    if (parserCase.response_file) fixture(parserCase.response_file);
    const linked = parserCase.expected.observations.flatMap((observation: { refs: string[] }) => observation.refs);
    for (const label of [...linked, ...parserCase.expected.unassigned]) assert.ok(supplied.has(label));
    for (const label of parserCase.expected.unassigned) assert.ok(!linked.includes(label));
    for (const observation of parserCase.expected.observations) {
      for (const rejected of observation.rejected) assert.ok(parser.reasons.includes(rejected.reason));
    }
    checks++;
  }

  const merge = json('manifest-merge.json');
  for (const mergeCase of merge.cases) {
    if (mergeCase.expected_error) {
      assert.throws(() => validateMediaManifest(mergeCase.existing_metadata.cmem_media_v1), (error: unknown) => error instanceof MediaError && error.code === mergeCase.expected_error);
    } else {
      const expected = mergeCase.expected_metadata.cmem_media_v1;
      assert.deepEqual(validateMediaManifest(expected), expected);
      if (mergeCase.existing_metadata.cmem_media_v1) validateMediaManifest(mergeCase.existing_metadata.cmem_media_v1);
      for (const id of mergeCase.expected_event_level ?? []) assert.ok(!expected.attachments.some((ref: { id: string }) => ref.id === id));
      assert.equal(expected.overflow === true, (mergeCase.expected_event_level ?? []).length > 0);
    }
    checks++;
  }
  return checks;
}
