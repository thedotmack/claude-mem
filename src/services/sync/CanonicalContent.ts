import { createHash, randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';

export const CONTENT_BODY_SCHEMA_VERSION = 1 as const;
export const CONTENT_PAYLOAD_SCHEMA_VERSION = 2 as const;
export const CONTENT_BODY_MAX_BYTES = 256_000;
export const MUTATION_FIELD_MAX_BYTES = 4_096;

export type ContentKind = 'observation' | 'summary' | 'prompt';
export type CanonicalKind = ContentKind | 'mutation';

export interface CanonicalMutation {
  op: 'set_title' | 'set_prompt_session' | 'remap_project';
  target?: Record<string, unknown>;
  where?: Record<string, unknown>;
  fields: Record<string, unknown>;
}

export interface CanonicalContentBody {
  body_schema_version: typeof CONTENT_BODY_SCHEMA_VERSION;
  deleted: boolean;
  deleted_at: string | null;
  entity_rev: string;
  id: string;
  kind: CanonicalKind;
  mutation: CanonicalMutation | null;
  origin_device_id: string;
  origin_local_id: string | null;
  payload: Record<string, unknown> | null;
  payload_schema_version: typeof CONTENT_PAYLOAD_SCHEMA_VERSION;
  payload_sha256: string;
}

export interface CanonicalWireOp {
  body: string;
  operation_sha256: string;
}

export interface CanonicalHubChange extends CanonicalWireOp {
  seq: string;
  server_ts?: string;
}

const CONTENT_KINDS = new Set<ContentKind>(['observation', 'summary', 'prompt']);
const MUTATION_OPS = new Set(['set_title', 'set_prompt_session', 'remap_project']);
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const UINT64_MAX = 18_446_744_073_709_551_615n;
const SHA256_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENVELOPE_KEYS = [
  'body_schema_version',
  'deleted',
  'deleted_at',
  'entity_rev',
  'id',
  'kind',
  'mutation',
  'origin_device_id',
  'origin_local_id',
  'payload',
  'payload_schema_version',
  'payload_sha256',
] as const;

function jsonError(message: string): never {
  logger.debug('CLOUD_SYNC', 'Rejected invalid canonical content', { reason: message });
  throw new Error(`canonical content: ${message}`);
}

/** RFC-8259 JSON with recursively sorted object keys and preserved array order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, new Set()));
}

function normalizeJson(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) jsonError('numbers must be finite');
    if (!Number.isSafeInteger(value) && Number.isInteger(value)) {
      jsonError('integers must be safe; use decimal strings for uint64 values');
    }
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (typeof value !== 'object') jsonError(`unsupported JSON value ${typeof value}`);
  if (seen.has(value)) jsonError('cycles are not allowed');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeJson(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      jsonError('objects must be plain objects');
    }
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const item = input[key];
      if (item === undefined) jsonError(`undefined is not allowed at ${key}`);
      output[key] = normalizeJson(item, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function assertCanonicalDecimal(value: unknown, options: { positive?: boolean } = {}): string {
  if (typeof value !== 'string' || !CANONICAL_DECIMAL.test(value)) {
    return jsonError('decimal values must be unsigned base-10 strings without leading zeroes');
  }
  if (BigInt(value) > UINT64_MAX) jsonError('decimal value exceeds uint64');
  if (options.positive && value === '0') jsonError('decimal value must be positive');
  return value;
}

export function compareCanonicalDecimals(left: string, right: string): -1 | 0 | 1 {
  assertCanonicalDecimal(left);
  assertCanonicalDecimal(right);
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function incrementCanonicalDecimal(value: string): string {
  const canonical = assertCanonicalDecimal(value);
  if (BigInt(canonical) === UINT64_MAX) jsonError('uint64 sequence overflow');
  return (BigInt(canonical) + 1n).toString(10);
}

export function canonicalDecimalToSafeInteger(value: unknown, name: string): number {
  const canonical = assertCanonicalDecimal(value);
  const parsed = Number(canonical);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`canonical content: ${name} exceeds the local SQLite safe-integer range`);
  }
  return parsed;
}

export function stableDocumentId(
  kind: ContentKind,
  originDeviceId: string,
  originLocalId: string,
): string {
  if (!CONTENT_KINDS.has(kind)) jsonError(`unsupported content kind ${String(kind)}`);
  const deviceId = assertDeviceId(originDeviceId);
  const localId = assertCanonicalDecimal(originLocalId);
  const input = canonicalJson([
    'cmem-doc-id-v1',
    'device',
    kind,
    deviceId,
    localId,
  ]);
  return `${kind}:${sha256Base64Url(input)}`;
}

export function buildContentOperation(input: {
  kind: ContentKind;
  originDeviceId: string;
  originLocalId: string;
  entityRev: string;
  payload: Record<string, unknown> | null;
  deleted?: boolean;
  deletedAt?: string | null;
}): CanonicalWireOp {
  const deleted = input.deleted === true;
  const deletedAt = input.deletedAt ?? null;
  if (deleted) {
    if (input.payload !== null) jsonError('a tombstone payload must be null');
    if (typeof deletedAt !== 'string' || deletedAt.length === 0) {
      jsonError('a tombstone requires deleted_at');
    }
  } else {
    if (input.payload === null) jsonError('a live/revived operation requires a payload');
    if (deletedAt !== null) jsonError('a live/revived operation requires deleted_at=null');
  }
  const originLocalId = assertCanonicalDecimal(input.originLocalId);
  const payloadJson = canonicalJson(input.payload);
  const body: CanonicalContentBody = {
    body_schema_version: CONTENT_BODY_SCHEMA_VERSION,
    deleted,
    deleted_at: deletedAt,
    entity_rev: assertCanonicalDecimal(input.entityRev, { positive: true }),
    id: stableDocumentId(input.kind, input.originDeviceId, originLocalId),
    kind: input.kind,
    mutation: null,
    origin_device_id: input.originDeviceId,
    origin_local_id: originLocalId,
    payload: input.payload,
    payload_schema_version: CONTENT_PAYLOAD_SCHEMA_VERSION,
    payload_sha256: sha256Base64Url(payloadJson),
  };
  return wrapCanonicalBody(body);
}

export function buildMutationOperation(input: {
  originDeviceId: string;
  mutation: CanonicalMutation;
  entityRev: string;
  mutationId?: string;
}): CanonicalWireOp {
  const mutationId = input.mutationId ?? randomUUID();
  if (!UUID.test(mutationId)) jsonError('mutation_id must be a UUID');
  validateMutation(input.mutation);
  const payload = null;
  const body: CanonicalContentBody = {
    body_schema_version: CONTENT_BODY_SCHEMA_VERSION,
    deleted: false,
    deleted_at: null,
    entity_rev: assertCanonicalDecimal(input.entityRev, { positive: true }),
    id: `mutation:${mutationId}`,
    kind: 'mutation',
    mutation: input.mutation,
    origin_device_id: input.originDeviceId,
    origin_local_id: null,
    payload,
    payload_schema_version: CONTENT_PAYLOAD_SCHEMA_VERSION,
    payload_sha256: sha256Base64Url(canonicalJson(payload)),
  };
  return wrapCanonicalBody(body);
}

function wrapCanonicalBody(body: CanonicalContentBody): CanonicalWireOp {
  validateBody(body);
  const serialized = canonicalJson(body);
  if (Buffer.byteLength(serialized, 'utf8') > CONTENT_BODY_MAX_BYTES) {
    jsonError(`body exceeds ${CONTENT_BODY_MAX_BYTES} UTF-8 bytes`);
  }
  return { body: serialized, operation_sha256: sha256Base64Url(serialized) };
}

export function parseCanonicalOperation(op: CanonicalWireOp): CanonicalContentBody {
  if (!op || typeof op !== 'object') jsonError('operation wrapper must be an object');
  const wrapperKeys = Object.keys(op).sort();
  if (wrapperKeys.length !== 2 || wrapperKeys[0] !== 'body' || wrapperKeys[1] !== 'operation_sha256') {
    jsonError('operation wrapper must contain only body and operation_sha256');
  }
  if (typeof op.body !== 'string' || op.body.length === 0) jsonError('body must be a non-empty string');
  if (Buffer.byteLength(op.body, 'utf8') > CONTENT_BODY_MAX_BYTES) {
    jsonError(`body exceeds ${CONTENT_BODY_MAX_BYTES} UTF-8 bytes`);
  }
  if (typeof op.operation_sha256 !== 'string' || !SHA256_BASE64URL.test(op.operation_sha256)) {
    jsonError('operation_sha256 must be a base64url SHA-256 digest');
  }
  if (sha256Base64Url(op.body) !== op.operation_sha256) jsonError('operation_sha256 mismatch');

  let parsed: unknown;
  try {
    parsed = JSON.parse(op.body);
  } catch {
    return jsonError('body is not JSON');
  }
  if (canonicalJson(parsed) !== op.body) jsonError('body is not canonical JSON');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return jsonError('body must be an object');
  }
  const body = parsed as unknown as CanonicalContentBody;
  validateBody(body);
  return body;
}

const PAYLOAD_FIELDS: Record<ContentKind, readonly string[]> = {
  observation: [
    'agent_id', 'agent_type', 'concepts', 'content_hash', 'created_at', 'created_at_epoch',
    'discovery_tokens', 'facts', 'files_modified', 'files_read', 'generated_by_model',
    'memory_session_id', 'merged_into_project', 'metadata', 'narrative', 'project',
    'prompt_number', 'subtitle', 'text', 'title', 'type',
  ],
  summary: [
    'completed', 'created_at', 'created_at_epoch', 'discovery_tokens', 'files_edited',
    'files_read', 'investigated', 'learned', 'memory_session_id', 'merged_into_project',
    'next_steps', 'notes', 'project', 'prompt_number', 'request',
  ],
  prompt: [
    'content_session_id', 'created_at', 'created_at_epoch', 'memory_session_id',
    'platform_source', 'project', 'prompt_number', 'prompt_text',
  ],
};
const PAYLOAD_ARRAY_FIELDS = new Set(['concepts', 'facts', 'files_edited', 'files_modified', 'files_read']);
const PAYLOAD_DECIMAL_FIELDS = new Set(['created_at_epoch', 'discovery_tokens', 'prompt_number']);
const PAYLOAD_FILTERABLE_FIELDS = new Set([
  'content_session_id', 'memory_session_id', 'merged_into_project', 'platform_source', 'project',
]);

function validateBody(body: CanonicalContentBody): void {
  const record = exactObject(body, ENVELOPE_KEYS, 'operation body');
  if (record.body_schema_version !== CONTENT_BODY_SCHEMA_VERSION) jsonError('unsupported body_schema_version');
  if (record.payload_schema_version !== CONTENT_PAYLOAD_SCHEMA_VERSION) jsonError('unsupported payload_schema_version');
  assertCanonicalDecimal(record.entity_rev, { positive: true });
  const originDeviceId = assertDeviceId(record.origin_device_id);
  assertHash(record.payload_sha256, 'payload_sha256');
  if (typeof record.kind !== 'string') jsonError('kind must be a string');

  if (record.kind === 'mutation') {
    if (record.deleted !== false || record.deleted_at !== null) jsonError('mutation operations cannot be deleted');
    if (record.origin_local_id !== null || record.payload !== null) {
      jsonError('mutation origin_local_id and payload must be null');
    }
    if (record.payload_sha256 !== sha256Base64Url('null')) {
      jsonError('mutation payload_sha256 must hash canonical null');
    }
    if (typeof record.id !== 'string' || !record.id.startsWith('mutation:') || !UUID.test(record.id.slice(9))) {
      jsonError('mutation id must be mutation:<canonical UUID>');
    }
    validateMutation(record.mutation);
    return;
  }

  if (!CONTENT_KINDS.has(record.kind as ContentKind)) jsonError('kind must be observation, summary, or prompt');
  const kind = record.kind as ContentKind;
  const originLocalId = assertCanonicalDecimal(record.origin_local_id);
  if (record.id !== stableDocumentId(kind, originDeviceId, originLocalId)) {
    jsonError('content id does not match its stable identity');
  }
  if (record.mutation !== null) jsonError('content mutation must be null');
  if (typeof record.deleted !== 'boolean') jsonError('deleted must be boolean');
  if (record.deleted) {
    if (record.payload !== null) jsonError('tombstone payload must be null');
    canonicalTimestamp(record.deleted_at, 'deleted_at');
    if (record.payload_sha256 !== sha256Base64Url('null')) {
      jsonError('tombstone payload_sha256 must hash canonical null');
    }
    return;
  }
  if (record.deleted_at !== null) jsonError('live deleted_at must be null');
  validatePayload(kind, record.payload);
  if (sha256Base64Url(canonicalJson(record.payload)) !== record.payload_sha256) {
    jsonError('payload_sha256 does not match canonical payload');
  }
}

function validatePayload(kind: ContentKind, value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    jsonError(`${kind} payload must be an object`);
  }
  const normalized = JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  const allowed = new Set(PAYLOAD_FIELDS[kind]);
  const unknown = Object.keys(normalized).find((key) => !allowed.has(key));
  if (unknown) jsonError(`${kind} payload contains unknown field ${unknown}`);

  requiredString(normalized, 'project', kind);
  requiredString(normalized, 'created_at', kind);
  requiredDecimal(normalized, 'created_at_epoch', kind);
  if (kind === 'observation' || kind === 'summary') {
    requiredString(normalized, 'memory_session_id', kind);
  } else {
    requiredString(normalized, 'content_session_id', kind);
    requiredString(normalized, 'prompt_text', kind);
  }
  for (const [key, item] of Object.entries(normalized)) {
    if (item === null) continue;
    if (PAYLOAD_ARRAY_FIELDS.has(key)) {
      if (!Array.isArray(item) || item.some((entry) => typeof entry !== 'string')) {
        jsonError(`${kind}.${key} must be a string array or null`);
      }
      continue;
    }
    if (PAYLOAD_DECIMAL_FIELDS.has(key)) {
      assertCanonicalDecimal(item);
      continue;
    }
    if (key === 'metadata') {
      if (typeof item !== 'object' || Array.isArray(item)) jsonError(`${kind}.metadata must be an object or null`);
      continue;
    }
    if (typeof item !== 'string') jsonError(`${kind}.${key} must be a string or null`);
    if (PAYLOAD_FILTERABLE_FIELDS.has(key)) {
      if (item.trim().length === 0) {
        jsonError(`${kind}.${key} must not be empty or whitespace-only`);
      }
      if (Buffer.byteLength(item, 'utf8') > 4_096) {
        jsonError(`${kind}.${key} exceeds the 4096-byte filterable limit`);
      }
    }
  }
}

function validateMutation(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) jsonError('mutation must be an object');
  const mutation = value as Record<string, unknown>;
  if (typeof mutation.op !== 'string' || !MUTATION_OPS.has(mutation.op)) jsonError('unsupported mutation op');
  if (mutation.op === 'set_title') {
    const record = exactObject(mutation, ['fields', 'op', 'target'], 'set_title');
    const target = exactSubsetObject(record.target, ['content_session_id', 'memory_session_id', 'platform_source'], 'set_title.target');
    if (target.memory_session_id === undefined && target.content_session_id === undefined) {
      jsonError('set_title target requires a session identifier');
    }
    for (const key of ['memory_session_id', 'content_session_id', 'platform_source']) {
      if (target[key] !== undefined) nonEmptyString(target[key], key);
    }
    const fields = exactObject(record.fields, ['custom_title'], 'set_title.fields');
    nonEmptyString(fields.custom_title, 'custom_title');
    return;
  }
  if (mutation.op === 'set_prompt_session') {
    const record = exactObject(mutation, ['fields', 'op', 'target'], 'set_prompt_session');
    const target = exactObject(record.target, ['origin_device_id', 'origin_local_id'], 'set_prompt_session.target');
    assertDeviceId(target.origin_device_id);
    assertCanonicalDecimal(target.origin_local_id);
    const fields = exactSubsetObject(
      record.fields,
      ['content_session_id', 'memory_session_id', 'platform_source', 'project'],
      'set_prompt_session.fields',
    );
    nonEmptyString(fields.memory_session_id, 'memory_session_id');
    for (const key of ['content_session_id', 'platform_source', 'project']) {
      if (fields[key] !== undefined) nonEmptyString(fields[key], key);
    }
    return;
  }
  const record = exactObject(mutation, ['fields', 'op', 'where'], 'remap_project');
  const where = exactSubsetObject(
    record.where,
    ['memory_session_id', 'merged_into_project_is_null', 'project'],
    'remap_project.where',
  );
  if (where.project !== undefined) nonEmptyString(where.project, 'project');
  if (where.memory_session_id !== undefined) nonEmptyString(where.memory_session_id, 'memory_session_id');
  if (where.merged_into_project_is_null !== undefined && where.merged_into_project_is_null !== true) {
    jsonError('merged_into_project_is_null may only be true');
  }
  if (Object.keys(where).length === 0) jsonError('remap_project where is empty');
  const fields = exactSubsetObject(record.fields, ['merged_into_project', 'project'], 'remap_project.fields');
  if (fields.project !== undefined) nonEmptyString(fields.project, 'project');
  if (fields.merged_into_project !== undefined) nonEmptyString(fields.merged_into_project, 'merged_into_project');
  if (Object.keys(fields).length === 0) jsonError('remap_project fields are empty');
}

/** Validate a queued mutation before it is durably appended to an outbox. */
export function validateCanonicalMutation(value: unknown): asserts value is CanonicalMutation {
  validateMutation(value);
}

function assertDeviceId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 128) {
    return jsonError('origin_device_id must be a non-empty string of at most 128 UTF-8 bytes');
  }
  return value;
}

function assertHash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SHA256_BASE64URL.test(value)) {
    return jsonError(`${name} must be an unpadded base64url SHA-256 digest`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 40) return jsonError(`${name} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    return jsonError(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function nonEmptyString(value: unknown, name: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim().length === 0
    || Buffer.byteLength(value, 'utf8') > MUTATION_FIELD_MAX_BYTES
  ) {
    return jsonError(`${name} must be a non-blank string of at most ${MUTATION_FIELD_MAX_BYTES} UTF-8 bytes`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string, kind: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) return jsonError(`${kind}.${key} must be a non-empty string`);
  return value;
}

function requiredDecimal(record: Record<string, unknown>, key: string, kind: string): string {
  return assertCanonicalDecimal(record[key] ?? jsonError(`${kind}.${key} must be a decimal string`));
}

function exactObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return jsonError(`${name} must be an object`);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    jsonError(`${name} must contain exactly: ${expected.join(', ')}`);
  }
  return record;
}

function exactSubsetObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return jsonError(`${name} must be an object`);
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) jsonError(`${name} contains unknown field ${unknown}`);
  return record;
}

export function decodeHubChange(change: CanonicalHubChange): {
  seq: string;
  body: CanonicalContentBody;
  operation_sha256: string;
  server_ts: number;
} {
  if (!change || typeof change !== 'object') jsonError('hub change must be an object');
  const seq = assertCanonicalDecimal(change.seq, { positive: true });
  const serverTs = change.server_ts === undefined
    ? 0
    : canonicalDecimalToSafeInteger(change.server_ts, 'server_ts');
  return {
    seq,
    body: parseCanonicalOperation({
      body: change.body,
      operation_sha256: change.operation_sha256,
    }),
    operation_sha256: change.operation_sha256,
    server_ts: serverTs,
  };
}
