import { describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  assertCanonicalDecimal,
  canonicalJson,
  parseCanonicalOperation,
  sha256Base64Url,
  stableDocumentId,
} from '../../../src/services/sync/CanonicalContent.js';

const fixturePath = join(import.meta.dir, '../../../fixtures/tpuf-content-v2.json');
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as {
  stable_id_vectors: Array<{
    kind: 'observation' | 'summary' | 'prompt';
    origin_device_id: string;
    origin_local_id: string;
    canonical_input: string;
    id: string;
  }>;
  canonical_json_vectors: Array<{ input: unknown; canonical: string }>;
  payload_hash_vectors: Array<{ payload: unknown; payload_json: string; payload_sha256: string }>;
  operation_hash_vectors: Array<{ name: string; body: string; operation_sha256: string }>;
  filterable_non_blank_vectors: Array<{
    name: string;
    operation: string;
    paths: string[];
    value: string;
    accepted: boolean;
  }>;
  mutation_utf8_boundary_vectors: Array<{
    name: string;
    operation: string;
    paths: string[];
    segments: Array<{ value: string; count: number }>;
    utf8_bytes: number;
    accepted: boolean;
  }>;
  byte_boundary_vectors: Array<{ name: string; value?: string; utf8_bytes: number; accepted?: boolean }>;
};

describe('canonical content-v2 shared fixture', () => {
  it('is the byte-identical cross-repository fixture', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex'))
      .toBe('fd3110fe69c4c388901b6f6a9ccb42114a9ca5f5ac23e06380b0689e5c7d9aea');
  });

  it('matches stable IDs, canonical JSON, payload hashes, and operation hashes exactly', () => {
    for (const vector of fixture.stable_id_vectors) {
      expect(canonicalJson([
        'cmem-doc-id-v1',
        'device',
        vector.kind,
        vector.origin_device_id,
        vector.origin_local_id,
      ])).toBe(vector.canonical_input);
      expect(stableDocumentId(vector.kind, vector.origin_device_id, vector.origin_local_id)).toBe(vector.id);
    }
    for (const vector of fixture.canonical_json_vectors) {
      expect(canonicalJson(vector.input)).toBe(vector.canonical);
    }
    for (const vector of fixture.payload_hash_vectors) {
      expect(canonicalJson(vector.payload)).toBe(vector.payload_json);
      expect(sha256Base64Url(vector.payload_json)).toBe(vector.payload_sha256);
    }
    for (const vector of fixture.operation_hash_vectors) {
      expect(sha256Base64Url(vector.body)).toBe(vector.operation_sha256);
      const parsed = parseCanonicalOperation({ body: vector.body, operation_sha256: vector.operation_sha256 });
      expect(canonicalJson(parsed)).toBe(vector.body);
    }
  });

  it('uses UTF-8 bytes and rejects decimal overflow without JS rounding', () => {
    const unicode = fixture.byte_boundary_vectors.find(vector => vector.name === 'unicode-byte-not-code-unit')!;
    expect(Buffer.byteLength(unicode.value!, 'utf8')).toBe(unicode.utf8_bytes);
    expect(assertCanonicalDecimal('18446744073709551615')).toBe('18446744073709551615');
    expect(() => assertCanonicalDecimal('18446744073709551616')).toThrow(/uint64/);
    expect(() => canonicalJson({ value: 9_007_199_254_740_992 })).toThrow(/safe/);
  });

  it('enforces every shared mutation-field boundary in UTF-8 bytes', () => {
    const operations = new Map(fixture.operation_hash_vectors.map(vector => [vector.name, vector]));
    for (const vector of fixture.mutation_utf8_boundary_vectors) {
      const value = vector.segments.map(segment => segment.value.repeat(segment.count)).join('');
      expect(Buffer.byteLength(value, 'utf8')).toBe(vector.utf8_bytes);
      const base = operations.get(vector.operation)!;
      for (const path of vector.paths) {
        const body = JSON.parse(base.body) as Record<string, any>;
        const parts = path.split('.');
        let parent: Record<string, any> = body;
        for (const part of parts.slice(0, -1)) {
          parent[part] ??= {};
          parent = parent[part];
        }
        parent[parts.at(-1)!] = value;
        const serialized = canonicalJson(body);
        const parse = () => parseCanonicalOperation({
          body: serialized,
          operation_sha256: sha256Base64Url(serialized),
        });
        if (vector.accepted) expect(parse).not.toThrow();
        else expect(parse).toThrow(/4096 UTF-8 bytes/);
      }
    }
  });

  it('rejects all 12 shared empty and whitespace-only filterable vectors', () => {
    expect(fixture.filterable_non_blank_vectors).toHaveLength(12);
    const operations = new Map(fixture.operation_hash_vectors.map(vector => [vector.name, vector]));
    for (const vector of fixture.filterable_non_blank_vectors) {
      expect(vector.accepted).toBe(false);
      const base = operations.get(vector.operation)!;
      for (const path of vector.paths) {
        const body = JSON.parse(base.body) as Record<string, any>;
        setPath(body, path, vector.value);
        expect(() => parseBodyAfterPayloadRehash(body)).toThrow(/empty|blank|whitespace/i);
      }
    }
  });

  it('uses trim only to detect blank values and preserves accepted surrounding whitespace exactly', () => {
    const operations = new Map(fixture.operation_hash_vectors.map(vector => [vector.name, vector]));
    const surroundingWhitespace = '  kept exactly \t';
    for (const vector of fixture.filterable_non_blank_vectors) {
      const base = operations.get(vector.operation)!;
      for (const path of vector.paths) {
        const body = JSON.parse(base.body) as Record<string, any>;
        setPath(body, path, surroundingWhitespace);
        const parsed = parseBodyAfterPayloadRehash(body) as Record<string, any>;
        expect(getPath(parsed, path)).toBe(surroundingWhitespace);
      }
    }
  });
});

function setPath(root: Record<string, any>, path: string, value: string): void {
  const parts = path.split('.');
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent[part] ??= {};
    parent = parent[part];
  }
  parent[parts.at(-1)!] = value;
}

function getPath(root: Record<string, any>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)[part], root);
}

function parseBodyAfterPayloadRehash(body: Record<string, any>): Record<string, unknown> {
  if (body.kind !== 'mutation') body.payload_sha256 = sha256Base64Url(canonicalJson(body.payload));
  const serialized = canonicalJson(body);
  return parseCanonicalOperation({
    body: serialized,
    operation_sha256: sha256Base64Url(serialized),
  }) as unknown as Record<string, unknown>;
}
