import { randomUUID } from 'node:crypto';
import { canonicalJson, compareCanonicalDecimals, incrementCanonicalDecimal, sha256Base64Url } from '../sync/CanonicalContent.js';
import { SHARED_WORK_MAX_UPDATES, sharedIdentity, sharedWriter, sharedValueHash, sharedEntryRef,
  sharedRecordKey, createSharedEntry, createSharedBatch, parseSharedRow, isSharedWorkList } from './shared-records.mjs';
import { assertSharedMetadataRedactionSafe, readSharedRedactionReceipts, redactSharedValue } from './shared-redaction.mjs';

const compareText = (a, b) => a === b ? 0 : a < b ? -1 : 1;

const SHARED_ROW_COLUMNS = 'id, list_name, fields, origin_device_id, origin_local_id, sync_rev';
const INVALID_ROW = Symbol('invalid shared row');
const SKIPPED_ROW = Symbol('not a shared row');
const UNSUPPORTED_ROW = Symbol('unsupported shared row');

/**
 * What each committed shared row parsed to, per connection, device and validator, so a read
 * parses only the rows it has not seen. A row's content changes only when a pulled higher
 * revision rewrites it (SyncApply.applyWorkState), which changes its sync_rev; local rows are
 * only ever inserted and nothing deletes shared rows. So origin and sync_rev name a row's
 * content. Only reads outside a caller's transaction fill it: an open transaction may hold
 * rows it never commits, and a rolled-back id can be reused by different content.
 */
const committedRowSummaries = new WeakMap();

function summariesFor(db, deviceId, validateValue) {
  let byValidator = committedRowSummaries.get(db);
  if (!byValidator) committedRowSummaries.set(db, byValidator = new Map());
  let byDevice = byValidator.get(validateValue ?? null);
  if (!byDevice) byValidator.set(validateValue ?? null, byDevice = new Map());
  let summaries = byDevice.get(deviceId);
  if (!summaries) byDevice.set(deviceId, summaries = { rows: new Map(), values: new Map() });
  return summaries;
}

/**
 * Read only. Incomplete/invalid batches never displace an earlier complete value.
 *
 * The shared rows are an append-only history: every revision of every object
 * stays, so they grow with use (about 4,500 rows a day on the cloud viewer's
 * account) while the current state stays small. That account had 24,424 rows,
 * 50 MB of JSON, for 1,587 current objects. Reading all of it held 140 MB live
 * inside one read, added about 600 MB to the process, and ran every few
 * seconds, so the worker was killed for memory on its 1 GB machine. So each
 * row is parsed once into a summary without its value, a read parses only rows
 * it has not seen, and only the entries in the result are parsed for values.
 */
export function readSharedRecords(db, { deviceId, validateValue, rows: suppliedRows, includeHistory = false }) {
  // Preloaded rows are already in memory and must not cost another query.
  if (suppliedRows) {
    const context = { db, deviceId, validateValue, reread: row => row };
    return foldSharedRows(suppliedRows.map(row => summarizeRow(context, row, row)), context, includeHistory, new Map());
  }
  const keep = !db.inTransaction;
  // The value re-reads below must see the same rows as the scan, so both run in one read transaction.
  const read = () => {
    let scan, byId;
    try {
      scan = db.prepare("SELECT id, origin_device_id, sync_rev FROM work_state_entries WHERE list_name GLOB '__my_work_v[0-9]*:*'");
      byId = db.prepare(`SELECT ${SHARED_ROW_COLUMNS} FROM work_state_entries WHERE id = ?`);
    } catch (error) {
      scan?.finalize();
      if (/no such (table|column)/i.test(String(error.message))) return emptySharedState(includeHistory);
      throw error;
    }
    try {
      const summaries = summariesFor(db, deviceId, validateValue);
      const context = { db, deviceId, validateValue, reread: id => byId.get(id) };
      const seen = new Map();
      const items = [];
      for (const head of scan.iterate()) {
        const stamp = `${head.origin_device_id ?? ''}\u0000${head.sync_rev ?? ''}`;
        let summary = summaries.rows.get(head.id);
        if (summary?.stamp !== stamp) {
          const row = byId.get(head.id);
          summary = { stamp, item: row ? summarizeRow(context, row, head.id) : SKIPPED_ROW };
        }
        seen.set(head.id, summary);
        items.push(summary.item);
      }
      const values = new Map();
      const state = foldSharedRows(items, context, includeHistory, values, summaries.values);
      if (keep) { summaries.rows = seen; summaries.values = values; }
      return state;
    } finally { scan.finalize(); byId.finalize(); }
  };
  return db.inTransaction ? read() : db.transaction(read)();
}

function emptySharedState(includeHistory) {
  return { records: new Map(), heads: new Map(), ...(includeHistory ? { history: new Map() } : {}), revision: sha256Base64Url('[]'),
    diagnostics: { pending: 0, invalid: 0, unsupported: 0, conflicts: [] } };
}

function parseRow(context, row) {
  try { return parseSharedRow(row, context.deviceId); }
  catch {
    context.redactionReceipts ??= readSharedRedactionReceipts(context.db);
    const receipt = context.redactionReceipts.get(String(row.id));
    if (!receipt) return INVALID_ROW;
    try { return parseSharedRow(row, context.deviceId, { redactionReceipt: receipt }); }
    catch { return INVALID_ROW; }
  }
}

/** One row as the fold sees it: a marker, a manifest or commit, or an entry without its value. */
function summarizeRow(context, row, source) {
  if (!isSharedWorkList(row.list_name)) return SKIPPED_ROW;
  const parsed = parseRow(context, row);
  if (parsed === INVALID_ROW) return INVALID_ROW;
  if (!parsed) return SKIPPED_ROW;
  if (parsed.unsupported) return UNSUPPORTED_ROW;
  return parsed.record === 'entry' ? entrySummary(parsed, source, context.validateValue) : parsed;
}

function foldSharedRows(items, context, includeHistory, values, previousValues = new Map()) {
  const records = new Map();
  const heads = new Map();
  const history = includeHistory ? new Map() : undefined;
  const diagnostics = { pending: 0, invalid: 0, unsupported: 0, conflicts: [] };
  // The full entry (with its value) for a kept identity, parsed again from its own row.
  const full = entry => {
    let record = values.get(entry) ?? previousValues.get(entry);
    if (!record) {
      const row = context.reread(entry.source);
      record = row ? parseRow(context, row) : INVALID_ROW;
      if (record === INVALID_ROW || record?.record !== 'entry' || record.hash !== entry.hash || record.revision !== entry.revision
        || record.batch !== entry.batch || record.writer !== entry.writer || record.kind !== entry.kind || record.key !== entry.key) {
        throw new Error('Shared My Work: a shared row changed while it was being read');
      }
    }
    values.set(entry, record);
    return record;
  };
  const batches = new Map();
  for (const item of items) {
    if (item === SKIPPED_ROW) continue;
    if (item === INVALID_ROW) { diagnostics.invalid++; continue; }
    if (item === UNSUPPORTED_ROW) { diagnostics.unsupported++; continue; }
    const id = canonicalJson([item.writer, item.batch]);
    let batch = batches.get(id);
    if (!batch) { batch = { entries: new Map(), manifests: new Map(), commits: new Map(), invalid: false }; batches.set(id, batch); }
    const map = item.record === 'entry' ? batch.entries : item.record === 'manifest' ? batch.manifests : batch.commits;
    const key = item.record === 'entry' ? sharedRecordKey(item.kind, item.key) : item.record === 'manifest' ? item.part : item.hash;
    const previous = map.get(key);
    const comparable = record => canonicalJson(record.record === 'entry' ? full(record) : record);
    if (previous && comparable(previous) !== comparable(item)) batch.invalid = true;
    map.set(key, item);
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
        if (entry.ref !== canonicalJson(ref)) { invalid = true; break; }
        entries.push(entry);
      }
    }
    if (invalid) { diagnostics.invalid++; continue; }
    if (incomplete) { diagnostics.pending++; continue; }
    if (entries.length !== commit.count || batch.entries.size !== commit.count || batch.manifests.size !== commit.parts.length
      || new Set(entries.map(entry => sharedRecordKey(entry.kind, entry.key))).size !== entries.length) {
      diagnostics.invalid++; continue;
    }
    if (context.validateValue && !entries.every(entry => entry.valid)) { diagnostics.invalid++; continue; }
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
    const recordOf = summary => {
      const entry = full(summary);
      return { kind: entry.kind, key: entry.key, value: entry.value, deleted: entry.deleted,
        revision: entry.revision, writer: entry.writer, hash: entry.hash, batchId: entry.batch, base: entry.base,
        valueHash: sharedValueHash(entry.kind, entry.key, entry.value, entry.deleted) };
    };
    const current = recordOf(latest);
    heads.set(identity, sameRevision.map(recordOf));
    if (history && latest.kind === 'group') history.set(identity, entries.map(recordOf));
    if (new Set(sameRevision.map(entry => entry.hash)).size > 1) {
      diagnostics.conflicts.push({ kind: latest.kind, key: latest.key, revision: latest.revision,
        writers: [...new Set(sameRevision.map(entry => entry.writer))].sort() });
    }
    records.set(identity, { kind: current.kind, key: current.key, value: current.value, deleted: current.deleted,
      revision: current.revision, writer: current.writer, hash: current.hash,
      valueHash: current.valueHash, batchId: current.batchId, base: current.base });
  }
  diagnostics.conflicts.sort((a, b) => compareText(sharedRecordKey(a.kind, a.key), sharedRecordKey(b.kind, b.key)));
  const revision = sha256Base64Url(canonicalJson([...records].sort(([a], [b]) => compareText(a, b))
    .map(([key, record]) => [key, record.revision, record.writer, record.hash, record.valueHash,
      heads.get(key).map(head => [head.hash, head.valueHash]).sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)))])));
  return { records, heads, ...(history ? { history } : {}), revision, diagnostics };
}

/** What the fold needs from one history entry, without its value: the value is read again only if the entry is kept. */
function entrySummary(entry, source, validateValue) {
  let valid = true;
  if (validateValue) {
    try { valid = validateValue(entry.kind, entry.key, entry.value, entry.deleted, entry.writer) === true; }
    catch { valid = false; }
  }
  return { record: 'entry', kind: entry.kind, key: entry.key, revision: entry.revision, writer: entry.writer, batch: entry.batch,
    hash: entry.hash, ref: canonicalJson(sharedEntryRef(entry)), valid, source };
}

/**
 * One reader that reuses its last read until the shared rows change. They change only by an
 * insert or by a pulled higher revision rewriting a row (SyncApply.applyWorkState), and nothing
 * deletes them, so their count, highest id and summed sync revision show any change: the same
 * check data-source.mjs makes on work_state_entries. A pull that touches other tables, which on
 * a replica is almost every commit, reuses the last read instead of parsing the history again.
 * A read inside a caller's transaction may include rows it has not committed, so only a read
 * outside one is kept.
 */
export function createSharedRecordReader(db, options) {
  let kept = null;
  const revisionOf = () => {
    try {
      // TOTAL, not SUM: a sum past the integer range is an SQLite error, and this check must not fail a read.
      const row = db.query(`SELECT COUNT(*) AS count, MAX(id) AS id, TOTAL(CAST(sync_rev AS INTEGER)) AS revisions
        FROM work_state_entries WHERE list_name GLOB '__my_work_v[0-9]*:*'`).get();
      return `${row.count}:${row.id ?? 0}:${row.revisions ?? 0}`;
    } catch (error) {
      if (/no such (table|column)/i.test(String(error.message))) return null;
      throw error;
    }
  };
  return () => {
    if (db.inTransaction) {
      const revision = revisionOf();
      return kept && revision !== null && revision === kept.revision ? kept.state : readSharedRecords(db, options);
    }
    return db.transaction(() => {
      const revision = revisionOf();
      if (kept && revision !== null && revision === kept.revision) return kept.state;
      const state = readSharedRecords(db, options);
      kept = revision === null ? null : { revision, state };
      return state;
    })();
  };
}

/** Atomic local commit; callers emit notifications only after this returns. */
export function publishSharedRecords(db, { deviceId, project, updates, now = Date.now(), validateValue, readState }) {
  sharedWriter(deviceId);
  if (typeof project !== 'string' || !project.trim() || project.length > 1_024) throw new TypeError('Shared My Work: invalid project');
  if (!Array.isArray(updates) || updates.length > SHARED_WORK_MAX_UPDATES) throw new RangeError('Shared My Work: too many updates');
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) throw new TypeError('Shared My Work: invalid timestamp');
  return db.transaction(() => {
    // readState lets a caller that already keeps a reader (createSharedRecordReader) reuse it.
    const state = readState ? readState() : readSharedRecords(db, { deviceId, validateValue });
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
