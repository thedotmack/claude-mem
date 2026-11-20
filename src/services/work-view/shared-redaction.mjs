import { canonicalJson, sha256Base64Url } from '../sync/CanonicalContent.js';
import { getRedactionConfig, redactJsonStrings } from '../../utils/redaction.js';
import { parseSharedRow, sharedEntryRef, SHARED_WORK_MAX_VALUE_BYTES } from './shared-records.mjs';

const TABLE = 'local_shared_work_redactions';

/** Identities cannot be rewritten without changing every hash/reference. Refuse them before storage. */
export function assertSharedMetadataRedactionSafe(fields, project = undefined) {
  const config = getRedactionConfig();
  if (project !== undefined && redactJsonStrings(project, config) !== project) {
    throw new TypeError('Shared My Work: redaction would change a project identity');
  }
  const identity = { ...fields }; delete identity.payload;
  if (canonicalJson(redactJsonStrings(identity, config)) !== canonicalJson(identity)) {
    throw new TypeError('Shared My Work: redaction would change a protocol identity');
  }
  if (fields.record !== 'entry' && canonicalJson(redactJsonStrings(JSON.parse(fields.payload), config)) !== fields.payload) {
    throw new TypeError('Shared My Work: redaction would change a manifest identity');
  }
}

/** Validate original protocol bytes in memory, then retain only private-safe content and hash evidence. */
export function redactSharedInboundRow(row, localDeviceId) {
  const record = parseSharedRow(row, localDeviceId);
  if (!record || record.unsupported) return null;
  const fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields;
  const config = getRedactionConfig();
  assertSharedMetadataRedactionSafe(fields, row.project);
  if (record.record !== 'entry') {
    return { fields: canonicalJson(fields), receipt: null };
  }
  const payload = canonicalJson(redactJsonStrings(record.value, config));
  if (Buffer.byteLength(payload, 'utf8') > SHARED_WORK_MAX_VALUE_BYTES) throw new TypeError('Shared My Work: redacted value exceeds byte limit');
  if (payload === fields.payload) return { fields: canonicalJson(fields), receipt: null };
  const storedFields = { ...fields, payload };
  return { fields: canonicalJson(storedFields), receipt: {
    stored_fields_hash: sha256Base64Url(canonicalJson(storedFields)),
    original_ref_json: canonicalJson(sharedEntryRef(record)),
  } };
}

/** Local-only attestation; it is not a canonical row and contains no original content. */
export function saveSharedRedactionReceipt(db, row, receipt) {
  if (!receipt) {
    try { db.prepare(`DELETE FROM ${TABLE} WHERE row_id = ?`).run(row.id); }
    catch (error) { if (!/no such table/i.test(String(error.message))) throw error; }
    return;
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    row_id INTEGER PRIMARY KEY REFERENCES work_state_entries(id) ON DELETE CASCADE,
    origin_device_id TEXT NOT NULL, origin_local_id TEXT NOT NULL, sync_rev TEXT NOT NULL,
    stored_fields_hash TEXT NOT NULL, original_ref_json TEXT NOT NULL
  )`);
  db.prepare(`INSERT INTO ${TABLE} (row_id, origin_device_id, origin_local_id, sync_rev, stored_fields_hash, original_ref_json)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(row_id) DO UPDATE SET
    origin_device_id=excluded.origin_device_id, origin_local_id=excluded.origin_local_id, sync_rev=excluded.sync_rev,
    stored_fields_hash=excluded.stored_fields_hash, original_ref_json=excluded.original_ref_json`)
    .run(row.id, row.origin_device_id, String(row.origin_local_id), String(row.sync_rev), receipt.stored_fields_hash, receipt.original_ref_json);
}

export function readSharedRedactionReceipts(db) {
  try { return new Map(db.prepare(`SELECT * FROM ${TABLE}`).all().map(row => [String(row.row_id), row])); }
  catch (error) { if (/no such table/i.test(String(error.message))) return new Map(); throw error; }
}

export function redactSharedValue(value) { return redactJsonStrings(value, getRedactionConfig()); }
