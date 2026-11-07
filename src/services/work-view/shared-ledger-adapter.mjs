import { readFileSync, readdirSync, mkdirSync, renameSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readLedger } from './request-groups.mjs';
import { activitySignature, buildAgentView, readAgentRecords } from './agent-view.mjs';
import { reduceWorkState } from './work-state-reduce.mjs';
import { buildSharedProjectionUpdates, applySharedProjection, decorateSharedView, isSharedProjectionValue } from './shared-projection.mjs';
import { readSharedRecords, publishSharedRecords } from './shared-record-store.mjs';
import { sharedRecordKey, sharedValueHash } from './shared-records.mjs';
import { canonicalJson } from '../sync/CanonicalContent.js';
import { redactJsonStrings } from '../../utils/redaction.js';

const digest = value => createHash('sha256').update(canonicalJson(value ?? null)).digest('hex');
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const fixedFiles = ['request-groups.json', 'story.json', 'refresh.json', 'agent-written-prompts.json'];
const fileKinds = name => name === 'request-groups.json' ? ['group', 'ignored']
  : name === 'story.json' ? ['story'] : name === 'refresh.json' ? ['refresh']
  : name === 'agent-written-prompts.json' ? ['exclusion']
  : /^progress\/g_[a-f0-9]{12}\.json$/.test(name) ? ['progress'] : [];

function load(path) {
  try {
    const raw = readFileSync(path);
    if (raw.byteLength > MAX_FILE_BYTES) throw new RangeError('Shared My Work file is over the local import limit');
    return JSON.parse(raw.toString('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function rawWrite(path, value) {
  mkdirSync(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.shared.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
  } finally { try { unlinkSync(temp); } catch { /* Renamed or never created. */ } }
}

/**
 * Local files are compatibility caches. Their observed/base hashes and pending
 * writes live in SQLite, so a crash between database commit and rename cannot
 * import the older file as a new decision on restart.
 */
export class SharedLedgerAdapter {
  constructor(db, { directory, deviceId, project = '__my_work__', notify = () => {} }) {
    Object.assign(this, { db, directory, deviceId, project, notify });
    this.errors = [];
    this.activity = null;
    this.copyHash = null;
    this.sharedRevision = null;
    this.storyHash = null;
    this.lastSignature = null;
    this.lastDiagnostic = null;
    db.exec(`CREATE TABLE IF NOT EXISTS my_work_file_state (
      name TEXT PRIMARY KEY, observed_hash TEXT, bases TEXT NOT NULL DEFAULT '{}',
      keys_json TEXT NOT NULL DEFAULT '[]', pending_json TEXT, pending_delete INTEGER NOT NULL DEFAULT 0
    )`);
    if (!db.prepare('PRAGMA table_info(my_work_file_state)').all().some(row => row.name === 'pending_delete')) db.exec('ALTER TABLE my_work_file_state ADD COLUMN pending_delete INTEGER NOT NULL DEFAULT 0');
  }

  state(name) {
    const row = this.db.prepare('SELECT * FROM my_work_file_state WHERE name = ?').get(name);
    return row ? { ...row, bases: JSON.parse(row.bases), keys: JSON.parse(row.keys_json) } : { observed_hash: null, bases: {}, keys: [], pending_json: null };
  }

  pendingMaterialization() {
    return this.db.prepare('SELECT COUNT(*) AS count FROM my_work_file_state WHERE pending_json IS NOT NULL').get().count;
  }

  shared() { return readSharedRecords(this.db, { deviceId: this.deviceId, validateValue: isSharedProjectionValue }); }

  tombstoneKeys(name, shared) {
    const kinds = fileKinds(name);
    return [...shared.records].filter(([, record]) => record.deleted && kinds.includes(record.kind)
      && (record.kind !== 'progress' || record.key === name.slice(9, -5))
      && (record.kind !== 'refresh' || record.key === this.deviceId)).map(([key]) => key);
  }

  remember(name, value, updates, shared, pending, pendingDelete = false) {
    value = redactJsonStrings(value);
    const prior = this.state(name);
    const keys = updates.map(update => sharedRecordKey(update.kind, update.key));
    // Keep deleted objects' accepted hashes too: their tombstone is the base
    // for a later recreation of this same stable identity, including restart.
    const knownKeys = new Set([...Object.keys(prior.bases), ...prior.keys, ...keys, ...this.tombstoneKeys(name, shared)]);
    const bases = Object.fromEntries([...knownKeys].map(key => [key, shared.records.get(key)?.hash ?? prior.bases[key] ?? null]));
    this.db.prepare(`INSERT INTO my_work_file_state(name, observed_hash, bases, keys_json, pending_json, pending_delete) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET observed_hash=excluded.observed_hash, bases=excluded.bases,
      keys_json=excluded.keys_json, pending_json=excluded.pending_json, pending_delete=excluded.pending_delete`)
      .run(name, pending ? prior.observed_hash ?? digest(load(join(this.directory, name))) : digest(value), JSON.stringify(bases), JSON.stringify(keys), pending ? JSON.stringify(value) : null, Number(pending && pendingDelete));
  }

  localLedger() {
    try { return readLedger(this.directory); }
    catch {
      const safe = (name, fallback) => { try { return load(join(this.directory, name)) ?? fallback; } catch { return fallback; } };
      const groups = safe('request-groups.json', { groups: {}, conversations: {}, ignored: {} });
      const progress = {};
      try { for (const name of readdirSync(join(this.directory, 'progress'))) if (/^g_[a-f0-9]{12}\.json$/.test(name)) {
        const value = safe(`progress/${name}`, null); if (value) progress[name.slice(0, -5)] = value;
      } } catch { /* A missing progress directory is empty. */ }
      return { groups, progress, story: safe('story.json', null), refresh: safe('refresh.json', null),
        agentWrittenPromptIds: new Set(safe('agent-written-prompts.json', {}).promptIds ?? []) };
    }
  }

  signature(captureActivity) {
    const names = [...fixedFiles, 'human-copy.json'];
    try { names.push(...readdirSync(join(this.directory, 'progress')).filter(name => /^g_[a-f0-9]{12}\.json$/.test(name)).map(name => `progress/${name}`)); } catch { /* Missing directory. */ }
    const files = names.sort().map(name => {
      try { const stat = statSync(join(this.directory, name)); return [name, stat.ino, stat.size, stat.mtimeMs]; }
      catch { return [name, 'missing']; }
    });
    return JSON.stringify([this.db.prepare('PRAGMA data_version').get(), captureActivity, files]);
  }

  updatesForFile(name, value) {
    const kinds = fileKinds(name);
    if (!kinds.length) return [];
    const object = item => item !== null && typeof item === 'object' && !Array.isArray(item);
    if (value !== null && !object(value)) throw new TypeError('Shared My Work file must contain an object');
    if (name === 'request-groups.json' && value !== null && (!object(value.groups) || !object(value.conversations)
      || (value.ignored !== undefined && !object(value.ignored)) || (value.suggestions !== undefined && !object(value.suggestions)))) {
      throw new TypeError('Shared request groups have an invalid shape');
    }
    if (name.startsWith('progress/') && value !== null && value.groupId !== name.slice(9, -5)) throw new TypeError('Shared progress names a different group');
    if (name === 'agent-written-prompts.json' && value !== null && (!Array.isArray(value.promptIds)
      || value.promptIds.some(id => !Number.isSafeInteger(id) || id <= 0))) throw new TypeError('Shared prompt exclusions have an invalid shape');
    const ledger = this.localLedger();
    if (name === 'request-groups.json') ledger.groups = value ?? { groups: {}, conversations: {}, ignored: {} };
    else if (name === 'story.json') ledger.story = value ?? null;
    else if (name === 'refresh.json') ledger.refresh = value ?? null;
    else if (name === 'agent-written-prompts.json') ledger.agentWrittenPromptIds = new Set(value?.promptIds ?? []);
    else {
      const id = name.slice('progress/'.length, -5);
      ledger.progress = { ...ledger.progress };
      if (value == null) delete ledger.progress[id]; else ledger.progress[id] = value;
    }
    return buildSharedProjectionUpdates(this.db, { ledger, deviceId: this.deviceId })
      .filter(update => kinds.includes(update.kind) && (kinds[0] !== 'progress' || update.key === name.slice(9, -5)));
  }

  /** Stage canonical rows and their recovery intent without touching files or notifying observers. */
  stageFile(name, value, { resolveKeys = [], resolutionBaseline } = {}) {
    if (!fileKinds(name).length) return null;
    value = redactJsonStrings(value);
    const updates = this.updatesForFile(name, value);
    let changed = null;
    this.db.transaction(() => {
      const prior = this.state(name);
      const shared = this.shared();
      const diagnostics = applySharedProjection(this.db, shared, { ledger: this.localLedger(), deviceId: this.deviceId }).diagnostics;
      const conflicted = new Set(diagnostics.conflicts.flatMap(entry => entry.kind === 'group-membership'
        ? entry.groups.map(group => sharedRecordKey('group', group)) : [sharedRecordKey(entry.kind, entry.key)]));
      const resolving = new Set(resolveKeys.map(key => sharedRecordKey('group', key)));
      if (resolving.size && name !== 'request-groups.json') throw new TypeError('Only explicit grouping decisions can resolve group conflicts');
      if (resolving.size) {
        if (!resolutionBaseline) throw new TypeError('Explicit grouping resolution requires its canonical baseline');
        const baseline = new Map(this.updatesForFile(name, resolutionBaseline).filter(update => update.kind === 'group')
          .map(update => [sharedRecordKey(update.kind, update.key), sharedValueHash(update.kind, update.key, update.value, update.deleted)]));
        const desired = new Map(updates.filter(update => update.kind === 'group')
          .map(update => [sharedRecordKey(update.kind, update.key), sharedValueHash(update.kind, update.key, update.value, update.deleted)]));
        for (const key of new Set([...baseline.keys(), ...desired.keys()])) {
          if (!resolving.has(key) && baseline.get(key) !== desired.get(key)) throw new Error('Shared My Work: resolution changed an unrelated group');
        }
      }
      const nextKeys = new Set(updates.map(update => sharedRecordKey(update.kind, update.key)));
      const changes = updates.flatMap(update => {
        const key = sharedRecordKey(update.kind, update.key);
        if (resolving.size && update.kind === 'group' && !resolving.has(key)) return [];
        const existing = shared.records.get(key);
        if (conflicted.has(key) && !resolving.has(key)) {
          throw new Error('Shared My Work has a conflicting decision; retained the local file');
        }
        return [{ ...update, expectedHash: resolving.has(key) ? existing?.hash ?? null : prior.bases[key] ?? null }];
      });
      for (const key of new Set([...prior.keys, ...resolving])) if (!nextKeys.has(key)) {
        const existing = shared.records.get(key);
        if (existing) {
          if (resolving.size && existing.kind === 'group' && !resolving.has(key)) continue;
          if (conflicted.has(key) && !resolving.has(key)) {
            if (existing.deleted) continue;
            throw new Error('Shared My Work has a conflicting decision; retained the local file');
          }
          changes.push({ kind: existing.kind, key: existing.key, deleted: true, expectedHash: resolving.has(key) ? existing.hash : prior.bases[key] ?? null });
        }
      }
      // A first encounter with a materialized equal value is safe; a different
      // pre-existing value needs an explicit conflict choice, not an overwrite.
      for (const change of changes) {
        const key = sharedRecordKey(change.kind, change.key);
        const existing = shared.records.get(key);
        if (!Object.hasOwn(prior.bases, key) && existing
          && sharedValueHash(change.kind, change.key, change.value, change.deleted) === (existing.valueHash ?? existing.hash)) change.expectedHash = existing.hash;
      }
      const result = publishSharedRecords(this.db, { deviceId: this.deviceId, project: this.project, updates: changes, validateValue: isSharedProjectionValue });
      this.remember(name, value, updates, this.shared(), true, value === null);
      if (result.changed) changed = { rules: changes.some(change => change.kind === 'story') };
    })();
    return { name, value, updates, changed, notified: false };
  }

  notifyCommitted(stage) {
    if (this.db.inTransaction) throw new Error('Shared My Work: the outer transaction has not committed');
    this.lastSignature = null;
    if (!stage?.changed || stage.notified) return;
    stage.notified = true;
    // A notification failure cannot undo a durable decision. The normal poll
    // still sees the committed canonical rows and pending materialization.
    try { this.notify(stage.changed); }
    catch { this.lastDiagnostic = null; }
  }

  /** After the owning transaction commits, materialize its durable recovery intent. */
  materializeFile(stage) {
    this.notifyCommitted(stage);
    if (!stage) return { materialization: 'complete' };
    const { name, value, updates } = stage;
    try {
      return { materialization: this.completePending(name, value, updates) ? 'complete' : 'pending' };
    } catch {
      // The canonical action is already durable. Keep pending_json for the
      // normal reconciler and report a saved action, not a failed intention.
      return { materialization: 'pending' };
    }
  }

  /**
   * Replace the file and clear the receipt only if `value` is still the pending
   * intent. The write lock is held throughout, so a writer on another connection
   * commits fully before this check or after this commit, never in between.
   */
  completePending(name, value, updates, shared) {
    return this.db.transaction(() => {
      // A later writer replaced this intent. Never overwrite it with older bytes.
      if (this.state(name).pending_json !== JSON.stringify(redactJsonStrings(value))) return false;
      if (value === null) { try { unlinkSync(join(this.directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      else rawWrite(join(this.directory, name), value);
      this.remember(name, value, updates, shared ?? this.shared(), false);
      return true;
    }).immediate();
  }

  /**
   * Record the intent to materialize a projection. Skips when a writer on another
   * connection owns the file or has changed its records since `shared` was read;
   * that writer's newer value wins and the next reconcile projects from it.
   */
  stageProjection(name, value, updates, shared, pendingDelete = false) {
    const recordHashes = source => {
      const kinds = fileKinds(name);
      return JSON.stringify([...source.records].filter(([, record]) => kinds.includes(record.kind)).map(([key, record]) => [key, record.hash]).sort());
    };
    return this.db.transaction(() => {
      if (this.state(name).pending_json !== null || recordHashes(this.shared()) !== recordHashes(shared)) return false;
      this.remember(name, value, updates, shared, true, pendingDelete);
      return true;
    }).immediate();
  }

  /** Finish an interrupted write. Runs under the write lock so it always finishes the newest intent. */
  finishPendingFile(name) {
    return this.db.transaction(() => {
      const prior = this.state(name);
      const current = load(join(this.directory, name));
      if (prior.pending_json === null) return current;
      const originallyPending = JSON.parse(prior.pending_json);
      const pending = redactJsonStrings(originallyPending);
      if (current !== undefined && digest(current) !== prior.observed_hash && digest(current) !== digest(originallyPending)
        && digest(current) !== digest(pending)) throw new Error('Local file changed during an unfinished shared write');
      if (prior.pending_delete) { try { unlinkSync(join(this.directory, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      else rawWrite(join(this.directory, name), pending);
      this.remember(name, pending, this.updatesForFile(name, pending), this.shared(), false);
      return pending;
    }).immediate();
  }

  /** Called before an external writer replaces its file; finalization follows rename. */
  beforeWrite(name, value, options) {
    if (this.db.inTransaction) throw new Error('Shared My Work: stage file writes until the outer transaction commits');
    const stage = this.stageFile(name, value, options);
    if (!stage) return null;
    this.notifyCommitted(stage);
    return Object.assign(() => this.remember(name, stage.value, stage.updates, this.shared(), false), { value: stage.value });
  }

  saveFile(name, value, options) {
    if (!fileKinds(name).length) throw new TypeError('Unsupported shared My Work file');
    const finish = this.beforeWrite(name, value, options);
    rawWrite(join(this.directory, name), finish && Object.hasOwn(finish, 'value') ? finish.value : value);
    finish?.();
  }

  publish(updates) {
    let changed = 0;
    const shared = this.shared();
    const conflicted = new Set(shared.diagnostics.conflicts.map(entry => sharedRecordKey(entry.kind, entry.key)));
    if (updates.some(update => conflicted.has(sharedRecordKey(update.kind, update.key)))) {
      throw new Error('Shared My Work has a conflicting decision; retained the previous complete state');
    }
    const safe = updates;
    for (let offset = 0; offset < safe.length; offset += 512) {
      changed += publishSharedRecords(this.db, { deviceId: this.deviceId, project: this.project, updates: safe.slice(offset, offset + 512), validateValue: isSharedProjectionValue }).changed;
    }
    if (changed) this.notify({ rules: safe.some(update => update.kind === 'story') });
    if (changed) this.lastSignature = null;
    return changed;
  }

  reconcile({ captureActivity = true } = {}) {
    const signature = this.signature(captureActivity);
    if (signature === this.lastSignature && this.lastDiagnostic) return this.lastDiagnostic;
    this.errors = [];
    const names = [...new Set([...fixedFiles, ...this.db.prepare('SELECT name FROM my_work_file_state').all().map(row => row.name)])];
    try { names.push(...readdirSync(join(this.directory, 'progress')).filter(name => /^g_[a-f0-9]{12}\.json$/.test(name)).map(name => `progress/${name}`)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names) {
      try {
        let current = this.state(name).pending_json !== null ? this.finishPendingFile(name) : load(join(this.directory, name));
        if ((current !== undefined || this.state(name).observed_hash !== null) && digest(current) !== this.state(name).observed_hash) {
          const finish = this.beforeWrite(name, current ?? null);
          if (finish && Object.hasOwn(finish, 'value') && digest(current) !== digest(finish.value)) {
            rawWrite(join(this.directory, name), finish.value);
            current = finish.value;
          }
          finish?.();
        }
      } catch (error) { this.errors.push({ file: name, message: String(error.message) }); }
    }
    const shared = this.shared();
    let projectionSuperseded = false;
    let ledger = this.localLedger();
    const applied = applySharedProjection(this.db, shared, { ledger, deviceId: this.deviceId });
    ledger = applied.ledger;
    const materialized = { 'request-groups.json': ledger.groups, 'story.json': ledger.story,
      'agent-written-prompts.json': { promptIds: [...ledger.agentWrittenPromptIds].sort((a,b) => a-b) } };
    for (const [id, progress] of Object.entries(ledger.progress)) materialized[`progress/${id}.json`] = progress;
    for (const [name, value] of Object.entries(materialized)) {
      if (value == null || this.errors.some(error => error.file === name)) continue;
      const kinds = fileKinds(name);
      if (!shared.records.size || ![...shared.records.values()].some(record => kinds.includes(record.kind))) continue;
      if (digest(load(join(this.directory, name))) === digest(value)) {
        const prior = this.state(name);
        if (this.tombstoneKeys(name, shared).some(key => prior.bases[key] !== shared.records.get(key).hash)) {
          this.remember(name, value, this.updatesForFile(name, value), shared, false);
        }
        continue;
      }
      const updates = this.updatesForFile(name, value);
      if (this.stageProjection(name, value, updates, shared)) this.completePending(name, value, updates, shared);
      else projectionSuperseded = true;
    }
    for (const record of shared.records.values()) {
      if (!record.deleted) continue;
      const name = record.kind === 'story' && record.key === 'current' ? 'story.json'
        : record.kind === 'progress' && /^g_[a-f0-9]{12}$/.test(record.key) ? `progress/${record.key}.json` : null;
      if (!name || this.errors.some(error => error.file === name)) continue;
      if (load(join(this.directory, name)) === undefined) {
        if (this.state(name).bases[sharedRecordKey(record.kind, record.key)] !== record.hash) this.remember(name, null, [], shared, false);
        continue;
      }
      if (this.stageProjection(name, null, [], shared, true)) this.completePending(name, null, [], shared);
      else projectionSuperseded = true;
    }
    // Never materialize a remote refresh's PID/ownership into refresh.json.
    const activity = captureActivity ? activitySignature(this.db) : null;
    let copies = {}, copyHash = null;
    if (captureActivity) {
      try {
        copies = load(join(this.directory, 'human-copy.json'))?.entries ?? {};
        copyHash = digest(copies);
      } catch (error) { this.errors.push({ file: 'human-copy.json', message: String(error.message) }); }
    }
    // Legacy copy writers can finish without another memory/tool row. Their
    // semantic file hash is an independent import trigger, not activity.
    if (captureActivity && (activity !== this.activity || copyHash !== this.copyHash)) {
      const entries = this.db.prepare('SELECT id, project, list_name, fields, created_at_epoch, origin_device_id, origin_local_id FROM work_state_entries').all();
      const state = reduceWorkState(entries, { localDeviceId: this.deviceId });
      let records = readAgentRecords(this.db, { workState: state, ledger });
      records = applySharedProjection(this.db, shared, { ledger, records, deviceId: this.deviceId }).records;
      const view = decorateSharedView(buildAgentView(state, records, { ledger }), { records });
      try { this.publish(buildSharedProjectionUpdates(this.db, { ledger: null, records, view, deviceId: this.deviceId, copyEntries: copies })); }
      catch (error) { this.errors.push({ file: 'activity', message: String(error.message) }); }
      this.activity = activity;
      this.copyHash = copyHash;
    }
    const final = this.shared();
    if (final.revision !== this.sharedRevision) {
      const story = final.records.get(sharedRecordKey('story', 'current'));
      const storyHash = story?.hash ?? null;
      this.notify({ rules: storyHash !== this.storyHash });
      this.storyHash = storyHash;
      this.sharedRevision = final.revision;
    }
    // A skipped projection still has newer records to write, even though this
    // signature already includes them; the next reconcile must not return early.
    this.lastSignature = projectionSuperseded ? null : this.signature(captureActivity);
    const diagnostics = applySharedProjection(this.db, final, { ledger, deviceId: this.deviceId }).diagnostics;
    this.lastDiagnostic = { ...diagnostics, files: this.errors };
    return this.lastDiagnostic;
  }
}
