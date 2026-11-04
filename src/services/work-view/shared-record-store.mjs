import { randomUUID } from 'node:crypto';
import { canonicalJson, compareCanonicalDecimals, incrementCanonicalDecimal, sha256Base64Url } from '../sync/CanonicalContent.js';
import { SHARED_WORK_MAX_UPDATES, sharedIdentity, sharedWriter, sharedValueHash, sharedEntryRef,
  sharedRecordKey, createSharedEntry, createSharedBatch, parseSharedRow, isSharedWorkList } from './shared-records.mjs';
import { assertSharedMetadataRedactionSafe, readSharedRedactionReceipts, redactSharedValue } from './shared-redaction.mjs';

const compareText = (a, b) => a === b ? 0 : a < b ? -1 : 1;

/** Read only. Incomplete/invalid batches never displace an earlier complete value. */
export function readSharedRecords(db, { deviceId, validateValue, rows: suppliedRows, includeHistory = false }) {
  const records = new Map();
  const heads = new Map();
  const history = includeHistory ? new Map() : undefined;
  const diagnostics = { pending: 0, invalid: 0, unsupported: 0, conflicts: [] };
  let rows;
  try {
    rows = suppliedRows ?? db.prepare("SELECT id, list_name, fields, origin_device_id, origin_local_id, sync_rev FROM work_state_entries WHERE list_name GLOB '__my_work_v[0-9]*:*'").all();
  } catch (error) {
    if (/no such (table|column)/i.test(String(error.message))) return { records, heads, ...(history ? { history } : {}), revision: sha256Base64Url('[]'), diagnostics };
    throw error;
  }
  const batches = new Map();
  let redactionReceipts;
  for (const row of rows) {
    if (!isSharedWorkList(row.list_name)) continue;
    let record;
    try { record = parseSharedRow(row, deviceId); }
    catch {
      redactionReceipts ??= readSharedRedactionReceipts(db);
      const receipt = redactionReceipts.get(String(row.id));
      if (!receipt) { diagnostics.invalid++; continue; }
      try { record = parseSharedRow(row, deviceId, { redactionReceipt: receipt }); }
      catch { diagnostics.invalid++; continue; }
    }
    if (!record) continue;
    if (record.unsupported) { diagnostics.unsupported++; continue; }
    const id = canonicalJson([record.writer, record.batch]);
    let batch = batches.get(id);
    if (!batch) { batch = { entries: new Map(), manifests: new Map(), commits: new Map(), invalid: false }; batches.set(id, batch); }
    const map = record.record === 'entry' ? batch.entries : record.record === 'manifest' ? batch.manifests : batch.commits;
    const key = record.record === 'entry' ? sharedRecordKey(record.kind, record.key) : record.record === 'manifest' ? record.part : record.hash;
    const previous = map.get(key);
    if (previous && canonicalJson(previous) !== canonicalJson(record)) batch.invalid = true;
    map.set(key, record);
  }
  const candidates = new Map();
  for (const batch of batches.values()) {
    if (batch.invalid || batch.commits.size > 1) { diagnostics.invalid++; continue; }
    const commit = [...batch.commits.values()][0];
    if (!commit) { diagnostics.pending++; continue; }
    const entries = [];
    let incomplete = false, invalid = false;
    for (let index = 0; index < commit.parts.length; index++) {
      const manifest = batch.manifests.get(index);
      if (!manifest) { incomplete = true; break; }
      if (manifest.hash !== commit.parts[index]) { invalid = true; break; }
      for (const ref of manifest.refs) {
        const entry = batch.entries.get(sharedRecordKey(ref.kind, ref.key));
        if (!entry) { incomplete = true; break; }
        if (canonicalJson(sharedEntryRef(entry)) !== canonicalJson(ref)) { invalid = true; break; }
        entries.push(entry);
      }
    }
    if (invalid) { diagnostics.invalid++; continue; }
    if (incomplete) { diagnostics.pending++; continue; }
    if (entries.length !== commit.count || batch.entries.size !== commit.count || batch.manifests.size !== commit.parts.length
      || new Set(entries.map(entry => sharedRecordKey(entry.kind, entry.key))).size !== entries.length) {
      diagnostics.invalid++; continue;
    }
    if (validateValue) {
      let valid = true;
      try { valid = entries.every(entry => validateValue(entry.kind, entry.key, entry.value, entry.deleted, entry.writer) === true); }
      catch { valid = false; }
      if (!valid) { diagnostics.invalid++; continue; }
    }
    for (const entry of entries) {
      const identity = sharedRecordKey(entry.kind, entry.key);
      if (!candidates.has(identity)) candidates.set(identity, []);
      candidates.get(identity).push(entry);
    }
  }
  for (const [identity, entries] of [...candidates].sort(([a], [b]) => compareText(a, b))) {
    entries.sort((a, b) => compareCanonicalDecimals(a.revision, b.revision)
      || compareText(a.writer, b.writer) || compareText(a.batch, b.batch));
    const latest = entries.at(-1);
    const sameRevision = entries.filter(entry => entry.revision === latest.revision);
    const recordOf = entry => ({ kind: entry.kind, key: entry.key, value: entry.value, deleted: entry.deleted,
      revision: entry.revision, writer: entry.writer, hash: entry.hash, batchId: entry.batch, base: entry.base,
      valueHash: sharedValueHash(entry.kind, entry.key, entry.value, entry.deleted) });
    heads.set(identity, sameRevision.map(recordOf));
    if (history && latest.kind === 'group') history.set(identity, entries.map(recordOf));
    if (new Set(sameRevision.map(entry => entry.hash)).size > 1) {
      diagnostics.conflicts.push({ kind: latest.kind, key: latest.key, revision: latest.revision,
        writers: [...new Set(sameRevision.map(entry => entry.writer))].sort() });
    }
    records.set(identity, { kind: latest.kind, key: latest.key, value: latest.value, deleted: latest.deleted,
      revision: latest.revision, writer: latest.writer, hash: latest.hash,
      valueHash: sharedValueHash(latest.kind, latest.key, latest.value, latest.deleted), batchId: latest.batch, base: latest.base });
  }
  diagnostics.conflicts.sort((a, b) => compareText(sharedRecordKey(a.kind, a.key), sharedRecordKey(b.kind, b.key)));
  const revision = sha256Base64Url(canonicalJson([...records].sort(([a], [b]) => compareText(a, b))
    .map(([key, record]) => [key, record.revision, record.writer, record.hash, record.valueHash,
      heads.get(key).map(head => [head.hash, head.valueHash]).sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)))])));
  return { records, heads, ...(history ? { history } : {}), revision, diagnostics };
}

/** Atomic local commit; callers emit notifications only after this returns. */
export function publishSharedRecords(db, { deviceId, project, updates, now = Date.now(), validateValue }) {
  sharedWriter(deviceId);
  if (typeof project !== 'string' || !project.trim() || project.length > 1_024) throw new TypeError('Shared My Work: invalid project');
  if (!Array.isArray(updates) || updates.length > SHARED_WORK_MAX_UPDATES) throw new RangeError('Shared My Work: too many updates');
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) throw new TypeError('Shared My Work: invalid timestamp');
  return db.transaction(() => {
    const state = readSharedRecords(db, { deviceId, validateValue });
    const batchId = randomUUID();
    const entries = [], seen = new Set();
    for (const update of updates) {
      const identity = sharedIdentity(update.kind, update.key);
      if (seen.has(identity)) throw new TypeError('Shared My Work: duplicate update');
      seen.add(identity);
      const previous = state.records.get(identity);
      if (Object.hasOwn(update, 'expectedHash') && update.expectedHash !== (previous?.hash ?? null)) throw new Error('Shared My Work: changed since read');
      const deleted = update.deleted === true;
      const value = deleted ? null : redactSharedValue(update.value);
      if (validateValue && validateValue(update.kind, update.key, value, deleted, deviceId) !== true) throw new TypeError('Shared My Work: invalid object value');
      const conflicted = state.diagnostics.conflicts.some(conflict => sharedRecordKey(conflict.kind, conflict.key) === identity);
      if (!conflicted && (previous?.valueHash ?? previous?.hash) === sharedValueHash(update.kind, update.key, value, deleted)) continue;
      if (!previous && deleted) continue;
      if (conflicted && !Object.hasOwn(update, 'expectedHash')) throw new Error('Shared My Work: unresolved conflict requires expectedHash');
      entries.push(createSharedEntry({ batchId, writer: deviceId, kind: update.kind, key: update.key,
        revision: incrementCanonicalDecimal(previous?.revision ?? '0'), base: previous?.hash ?? null, value, deleted }));
    }
    if (!entries.length) return { changed: 0, rowIds: [], batchId: null };
    const rows = createSharedBatch(entries, { batchId, writer: deviceId });
    for (const row of rows) assertSharedMetadataRedactionSafe(row.fields, project);
    const insert = db.prepare('INSERT INTO work_state_entries (project, list_name, fields, created_at, created_at_epoch) VALUES (?, ?, ?, ?, ?)');
    try {
      const rowIds = rows.map(row => Number(insert.run(project, row.listName, canonicalJson(row.fields), new Date(now).toISOString(), now).lastInsertRowid));
      return { changed: entries.length, rowIds, batchId };
    } finally { insert.finalize(); }
  })();
}
