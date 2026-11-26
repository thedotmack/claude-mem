import { canonicalJson, sha256Base64Url } from '../sync/CanonicalContent.js';
import { getRedactionConfig, redactJsonStrings } from '../../utils/redaction.js';
import { parseSharedRow, sharedEntryRef, SHARED_WORK_MAX_VALUE_BYTES } from './shared-records.mjs';
import { focusIdFor, isReviewStackValue } from './review-stack-schema.js';

const TABLE = 'local_shared_work_redactions';
const REPAIR_CLOCK = 'shared_review_card_repair';

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
  return discloseEntry(record, fields, config, record.value);
}

function discloseEntry(record, fields, config, priorValue) {
  const isCard = record.kind === 'stack-card' && !record.deleted;
  if (isCard && !isReviewStackValue(record.kind, record.key, record.value)) {
    throw new TypeError('Shared My Work: invalid original review card');
  }
  const value = redactJsonStrings(priorValue, config);
  if (isCard) {
    if (value.key !== record.value.key) value.key = record.key;
    if (value.source !== record.value.source) delete value.source;
    if (value.preview !== record.value.preview) delete value.preview;
    if (value.focus !== record.value.focus) value.focusId = record.value.focusId ?? focusIdFor(record.value.focus);
  }
  const payload = canonicalJson(value);
  if (Buffer.byteLength(payload, 'utf8') > SHARED_WORK_MAX_VALUE_BYTES) throw new TypeError('Shared My Work: redacted value exceeds byte limit');
  if (payload === fields.payload) return { fields: canonicalJson(fields), receipt: null };
  const storedFields = { ...fields, payload };
  return { fields: canonicalJson(storedFields), receipt: {
    stored_fields_hash: sha256Base64Url(canonicalJson(storedFields)),
    original_ref_json: canonicalJson(isCard ? {domain:'stack-card-v1', ref:sharedEntryRef(record)} : sharedEntryRef(record)),
  } };
}

/** A legacy receipt proves the origin digest, but did not attest the original card schema.
 * Upgrade it only when the hub replays the identical canonical operation, retaining the
 * earlier recipient's disclosure even if its current privacy policy is less restrictive. */
export function repairReplayedReviewCard(db, deviceId, originalRow) {
  if (originalRow.list_name !== '__my_work_v1:entry') return false;
  let previous;
  try {
    previous = db.query(`SELECT e.id,e.list_name,e.fields,e.origin_device_id,
        CAST(e.origin_local_id AS TEXT) AS origin_local_id,CAST(e.sync_rev AS TEXT) AS sync_rev,
        r.row_id,r.stored_fields_hash,r.original_ref_json
      FROM work_state_entries e JOIN ${TABLE} r ON r.row_id=e.id AND r.origin_device_id=e.origin_device_id
        AND r.origin_local_id=e.origin_local_id AND r.sync_rev=e.sync_rev
      WHERE e.origin_device_id=? AND e.origin_local_id=? AND e.sync_rev=?`)
      .get(originalRow.origin_device_id, originalRow.origin_local_id, originalRow.sync_rev);
  } catch (error) {
    if (/no such table/i.test(String(error.message))) return false;
    throw error;
  }
  if (!previous) return false;
  const oldRef = JSON.parse(previous.original_ref_json);
  if (oldRef.kind !== 'stack-card') return false;
  const retained = parseSharedRow(previous, deviceId, {redactionReceipt:previous});
  const origin = parseSharedRow(originalRow, deviceId);
  if (retained?.record !== 'entry' || origin?.record !== 'entry' || origin.deleted
    || canonicalJson(sharedEntryRef(origin)) !== previous.original_ref_json) {
    throw new TypeError('Shared My Work: review card replay does not match its verified origin');
  }
  const fields = typeof originalRow.fields === 'string' ? JSON.parse(originalRow.fields) : originalRow.fields;
  assertSharedMetadataRedactionSafe(fields, originalRow.project);
  const repaired = discloseEntry(origin, fields, getRedactionConfig(), retained.value);
  db.query('UPDATE work_state_entries SET fields=? WHERE id=?').run(repaired.fields, previous.id);
  saveSharedRedactionReceipt(db, previous, repaired.receipt);
  db.query('INSERT INTO sync_state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    .run(REPAIR_CLOCK, sha256Base64Url(repaired.fields));
  return true;
}

export function sharedReviewCardRepairClock(db) {
  try { return db.query('SELECT v FROM sync_state WHERE k=?').get(REPAIR_CLOCK)?.v ?? ''; }
  catch (error) {
    if (/no such table/i.test(String(error.message))) return '';
    throw error;
  }
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
