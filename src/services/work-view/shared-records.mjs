// Shared My Work is carried inside the existing primitive work_state envelope.
// The canonical JSON/hash/revision helpers are the same ones used by CloudSync.
import { canonicalJson, sha256Base64Url, assertCanonicalDecimal } from '../sync/CanonicalContent.js';

export const SHARED_WORK_PREFIX = '__my_work_v1:';
export const SHARED_WORK_VERSION = 1;
export const SHARED_WORK_MAX_VALUE_BYTES = 48_000;
export const SHARED_WORK_MAX_MANIFEST_BYTES = 48_000;
export const SHARED_WORK_MAX_ROW_BYTES = 128_000;
export const SHARED_WORK_MAX_UPDATES = 512;
export const SHARED_WORK_MAX_PARTS = 32;
export const isSharedWorkList = value => typeof value === 'string' && /^__my_work_v\d+:/.test(value);
export const sharedRecordKey = (kind, key) => canonicalJson([kind, key]);
export const sharedValueHash = (kind, key, value, deleted = false) => sha256Base64Url(canonicalJson({ kind, key, value: deleted ? null : value, deleted }));

const fail = message => { throw new TypeError(`Shared My Work: ${message}`); };
const text = (value, max, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) fail(`invalid ${name}`);
  return value;
};
export function sharedWriter(value) {
  text(value, 128, 'writer');
  if (Buffer.byteLength(value, 'utf8') > 128) fail('writer exceeds canonical byte limit');
  return value;
}
export function sharedIdentity(kind, key) {
  if (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(kind)) fail('invalid kind');
  text(key, 1_024, 'key');
  return sharedRecordKey(kind, key);
}
const hash = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail('invalid hash');
  return value;
};
const bytes = value => Buffer.byteLength(value, 'utf8');
// Only parseSharedRow can attach this receipt after binding it to a local DB
// row. A field in a remote record can never opt into redaction verification.
const verifiedRedactionReference = Symbol('verified-redaction-reference');
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('invalid fields');
};

export function createSharedEntry({ batchId, writer, kind, key, revision, base = null, value, deleted = false }) {
  sharedWriter(writer); text(batchId, 100, 'batch'); sharedIdentity(kind, key);
  assertCanonicalDecimal(revision, { positive: true });
  if (base !== null) hash(base);
  if (typeof deleted !== 'boolean') fail('invalid deletion flag');
  const payload = canonicalJson(deleted ? null : value);
  if (bytes(payload) > SHARED_WORK_MAX_VALUE_BYTES) fail('value exceeds byte limit');
  return { version: 1, record: 'entry', batch: batchId, writer, kind, key, revision, base, deleted,
    payload, hash: sharedValueHash(kind, key, deleted ? null : value, deleted) };
}

export const sharedEntryRef = entry => {
  if (entry[verifiedRedactionReference]) return entry[verifiedRedactionReference];
  const fields = Object.fromEntries(['version', 'record', 'batch', 'writer', 'kind', 'key', 'revision', 'base', 'deleted', 'payload', 'hash'].map(key => [key, entry[key]]));
  return { kind: entry.kind, key: entry.key, revision: entry.revision,
    hash: entry.hash, entryHash: sha256Base64Url(canonicalJson(fields)) };
};

/** Split only the manifest. Each named logical object remains one bounded row. */
export function createSharedBatch(entries, { batchId, writer }) {
  sharedWriter(writer); text(batchId, 100, 'batch');
  if (!Array.isArray(entries) || !entries.length || entries.length > SHARED_WORK_MAX_UPDATES) fail('invalid batch size');
  const identities = new Set();
  const groups = [[]];
  for (const entry of entries) {
    if (entry.batch !== batchId || entry.writer !== writer) fail('entry belongs to another batch');
    const identity = sharedIdentity(entry.kind, entry.key);
    if (identities.has(identity)) fail('duplicate logical object in batch');
    identities.add(identity);
    const ref = sharedEntryRef(entry);
    let group = groups.at(-1);
    if (bytes(canonicalJson([...group, ref])) > SHARED_WORK_MAX_MANIFEST_BYTES) { group = []; groups.push(group); }
    group.push(ref);
    if (bytes(canonicalJson(group)) > SHARED_WORK_MAX_MANIFEST_BYTES) fail('manifest reference exceeds byte limit');
  }
  if (groups.length > SHARED_WORK_MAX_PARTS) fail('too many manifest parts');
  const manifests = groups.map((refs, part) => {
    const payload = canonicalJson(refs);
    return { version: 1, record: 'manifest', batch: batchId, writer, part, payload, hash: sha256Base64Url(payload) };
  });
  const payload = canonicalJson(manifests.map(part => part.hash));
  const commit = { version: 1, record: 'commit', batch: batchId, writer, count: entries.length, payload, hash: sha256Base64Url(payload) };
  return [...entries.map(fields => ({ listName: `${SHARED_WORK_PREFIX}entry`, fields })),
    ...manifests.map(fields => ({ listName: `${SHARED_WORK_PREFIX}manifest`, fields })),
    { listName: `${SHARED_WORK_PREFIX}commit`, fields: commit }];
}

/** Validate independently of arrival order, without trusting fields.writer. */
export function parseSharedRow(row, localDeviceId, { redactionReceipt = null } = {}) {
  if (!isSharedWorkList(row.list_name)) return null;
  if (!row.list_name.startsWith(SHARED_WORK_PREFIX)) return { unsupported: true };
  if (typeof row.fields === 'string' && bytes(row.fields) > SHARED_WORK_MAX_ROW_BYTES) fail('row exceeds byte limit');
  const fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields;
  if (!fields || fields.version !== 1) return { unsupported: true };
  const writer = row.origin_device_id ?? localDeviceId;
  sharedWriter(writer);
  if (fields.writer !== writer) fail('writer does not match origin');
  text(fields.batch, 100, 'batch'); hash(fields.hash);
  if (row.list_name !== `${SHARED_WORK_PREFIX}${fields.record}`) fail('record/list mismatch');
  if (fields.record === 'entry') {
    exact(fields, ['version', 'record', 'batch', 'writer', 'kind', 'key', 'revision', 'base', 'deleted', 'payload', 'hash']);
    sharedIdentity(fields.kind, fields.key); assertCanonicalDecimal(fields.revision, { positive: true });
    if (fields.base !== null) hash(fields.base);
    if (typeof fields.deleted !== 'boolean' || typeof fields.payload !== 'string' || bytes(fields.payload) > SHARED_WORK_MAX_VALUE_BYTES) fail('invalid entry payload');
    const value = JSON.parse(fields.payload);
    if (canonicalJson(value) !== fields.payload || (fields.deleted && value !== null)) fail('entry hash mismatch');
    const result = { ...fields, value };
    if (sharedValueHash(fields.kind, fields.key, value, fields.deleted) !== fields.hash) {
      // A recipient can enforce a stricter privacy policy than the origin.
      // Its trusted local receipt attests that the original entry was fully
      // verified before redaction, while this hash binds every stored field.
      // The manifest still verifies against that original reference.
      const receipt = redactionReceipt;
      if (!receipt || String(row.id) !== String(receipt.row_id)
        || row.origin_device_id !== receipt.origin_device_id
        || String(row.origin_local_id) !== receipt.origin_local_id
        || String(row.sync_rev) !== receipt.sync_rev
        || sha256Base64Url(canonicalJson(fields)) !== receipt.stored_fields_hash) fail('entry hash mismatch');
      const ref = JSON.parse(receipt.original_ref_json);
      exact(ref, ['kind', 'key', 'revision', 'hash', 'entryHash']);
      hash(ref.hash); hash(ref.entryHash);
      if (ref.kind !== fields.kind || ref.key !== fields.key || ref.revision !== fields.revision || ref.hash !== fields.hash) fail('redaction receipt does not match entry');
      Object.defineProperty(result, verifiedRedactionReference, { value: ref });
    }
    return result;
  }
  if (fields.record === 'manifest') {
    exact(fields, ['version', 'record', 'batch', 'writer', 'part', 'payload', 'hash']);
    if (!Number.isInteger(fields.part) || fields.part < 0 || fields.part >= SHARED_WORK_MAX_PARTS
      || typeof fields.payload !== 'string' || bytes(fields.payload) > SHARED_WORK_MAX_MANIFEST_BYTES) fail('invalid manifest');
    const refs = JSON.parse(fields.payload);
    if (!Array.isArray(refs) || !refs.length || refs.length > SHARED_WORK_MAX_UPDATES || canonicalJson(refs) !== fields.payload) fail('invalid references');
    for (const ref of refs) {
      exact(ref, ['kind', 'key', 'revision', 'hash', 'entryHash']);
      sharedIdentity(ref.kind, ref.key); assertCanonicalDecimal(ref.revision, { positive: true }); hash(ref.hash); hash(ref.entryHash);
    }
    if (sha256Base64Url(fields.payload) !== fields.hash) fail('manifest hash mismatch');
    return { ...fields, refs };
  }
  if (fields.record === 'commit') {
    exact(fields, ['version', 'record', 'batch', 'writer', 'count', 'payload', 'hash']);
    if (!Number.isInteger(fields.count) || fields.count < 1 || fields.count > SHARED_WORK_MAX_UPDATES || typeof fields.payload !== 'string'
      || bytes(fields.payload) > SHARED_WORK_MAX_MANIFEST_BYTES) fail('invalid commit');
    const parts = JSON.parse(fields.payload);
    if (!Array.isArray(parts) || !parts.length || parts.length > SHARED_WORK_MAX_PARTS || canonicalJson(parts) !== fields.payload) fail('invalid commit parts');
    parts.forEach(hash);
    if (sha256Base64Url(fields.payload) !== fields.hash) fail('commit hash mismatch');
    return { ...fields, parts };
  }
  fail('unknown record type');
}
