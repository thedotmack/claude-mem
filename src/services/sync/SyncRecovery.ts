import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { sha256Base64Url, stableDocumentId, type CanonicalWireOp, type ContentKind } from './CanonicalContent.js';
import { readSyncQueueInventory, type SyncQueueFlags } from './SyncQueueEvidence.js';

const TABLES: Record<ContentKind, string> = { observation: 'observations', summary: 'session_summaries', prompt: 'user_prompts', work_state: 'work_state_entries' };
export const RECOVERY_MAX_ITEMS = 1000;
export const RECOVERY_MAX_ACTIVE_JOBS = 100;
export interface RecoveryScope { project: string; from: string; to: string; kinds: ContentKind[]; maxItems?: number }
export interface RecoveryItem { kind: ContentKind; originLocalId: string; entityId: string; revision: string; operationSha256: string; bytes: number }
export interface RecoveryPreview { scope: Required<RecoveryScope>; deviceId: string; epoch: string | null; previewToken: string; count: number; estimatedBytes: number; items: RecoveryItem[]; ownership: 'native'; coverage: 'selected_history' }
export interface RecoverySource { snapshotNative(kind: ContentKind, id: string): { revision: string; operation: CanonicalWireOp } | null; flags(): SyncQueueFlags }
export type RecoveryJobState = 'paused' | 'running' | 'cancelled' | 'complete';
export type RecoveryItemState = 'selected' | 'queued' | 'acknowledged' | 'superseded' | 'deleted' | 'failed';
export interface RecoveryJob { id: string; preview_token: string; device_id: string; epoch: string | null; status: RecoveryJobState; pause_reason: string | null; created_at_epoch: number; updated_at_epoch: number; scope: Required<RecoveryScope>; items: unknown[] }
export class RecoveryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

/** Additive tables only. Called during SessionStore initialization, never by preview. */
export function ensureSyncRecoverySchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS sync_recovery_jobs (
    id TEXT PRIMARY KEY, preview_token TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL,
    scope_json TEXT NOT NULL, epoch TEXT, status TEXT NOT NULL, pause_reason TEXT,
    created_at_epoch INTEGER NOT NULL, updated_at_epoch INTEGER NOT NULL)`);
  db.run(`CREATE TABLE IF NOT EXISTS sync_recovery_items (
    job_id TEXT NOT NULL, kind TEXT NOT NULL, origin_local_id TEXT NOT NULL, entity_id TEXT NOT NULL,
    selected_rev TEXT NOT NULL, selected_sha256 TEXT NOT NULL, estimated_bytes INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'selected', queued_rev TEXT, queued_sha256 TEXT, queued_epoch TEXT,
    acknowledged_epoch TEXT, detail TEXT, updated_at_epoch INTEGER NOT NULL,
    PRIMARY KEY(job_id, kind, origin_local_id))`);
  const itemColumns = db.query('PRAGMA table_info(sync_recovery_items)').all() as { name: string }[];
  if (!itemColumns.some(column => column.name === 'queued_epoch')) db.run('ALTER TABLE sync_recovery_items ADD COLUMN queued_epoch TEXT');
  db.run('CREATE INDEX IF NOT EXISTS idx_sync_recovery_selection ON sync_recovery_items(job_id, status, kind, origin_local_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sync_recovery_entity_revision ON sync_recovery_items(entity_id, queued_rev, queued_sha256)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sync_recovery_jobs_active ON sync_recovery_jobs(device_id, status, created_at_epoch)');
  db.run(`CREATE TABLE IF NOT EXISTS sync_recovery_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, entity_id TEXT NOT NULL,
    entity_rev TEXT NOT NULL, operation_sha256 TEXT NOT NULL, epoch TEXT, event TEXT NOT NULL,
    created_at_epoch INTEGER NOT NULL)`);
}

/** Native source selection is bounded before canonical bodies cross SQLite's FFI. */
export class SyncRecovery {
  readonly available: boolean;
  /** Items the last selectPage finished without returning them. Each one is progress, and more may follow them. */
  itemsSettledByLastPage = 0;
  constructor(private readonly db: Database, readonly deviceId: string, private readonly source: RecoverySource) {
    this.available = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_recovery_jobs'").get();
  }

  inventory() {
    return this.db.transaction(() => {
      const queue = readSyncQueueInventory(this.db, this.source.flags());
      const excludedCurrent = {} as Record<ContentKind, number>;
      const ledgerEntries = {} as Record<ContentKind, number>;
      for (const [kind, table] of Object.entries(TABLES) as [ContentKind, string][]) {
        excludedCurrent[kind] = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} t
          JOIN sync_launch_exclusions e ON e.kind = ? AND e.origin_local_id = CAST(t.id AS TEXT)
          WHERE t.origin_device_id IS NULL AND (length(CAST(t.sync_rev AS TEXT)) < length(e.through_rev)
          OR (length(CAST(t.sync_rev AS TEXT)) = length(e.through_rev) AND CAST(t.sync_rev AS TEXT) <= e.through_rev))`).get(kind) as { n: number }).n;
        ledgerEntries[kind] = (this.db.prepare('SELECT COUNT(*) AS n FROM sync_launch_exclusions WHERE kind = ?').get(kind) as { n: number }).n;
      }
      const pull = this.db.query(`SELECT COUNT(*) AS operations, COUNT(DISTINCT entity_id) AS distinctEntities
        FROM sync_pull_quarantine WHERE entity_id IS NOT NULL`).get() as { operations: number; distinctEntities: number };
      const unidentifiedPull = (this.db.query('SELECT COUNT(*) AS n FROM sync_pull_quarantine WHERE entity_id IS NULL').get() as { n: number }).n;
      const push = this.db.query("SELECT COUNT(*) AS operations, COUNT(DISTINCT queue_key) AS distinctEntities FROM sync_dead_letter WHERE lane = 'content'").get() as { operations: number; distinctEntities: number };
      return { observedAt: Date.now(), deviceId: this.deviceId, epoch: this.epoch(), queue, excludedCurrent, ledgerEntries,
        quarantine: { pullOperations: pull.operations + unidentifiedPull, pullDistinctEntities: pull.distinctEntities, unidentifiedPullOperations: unidentifiedPull, pushOperations: push.operations, pushDistinctEntities: push.distinctEntities },
        coverage: 'selected_history' as const, cloudAbsenceProven: false };
    })();
  }

  preview(input: RecoveryScope): RecoveryPreview {
    const scope = normalizeScope(input);
    return this.db.transaction(() => {
      const flags = this.source.flags();
      if (!this.deviceId) throw new RecoveryError('not_configured', 'Recovery requires a configured origin device');
      const items: RecoveryItem[] = [];
      for (const kind of scope.kinds) {
        if (kind === 'work_state' && !flags.workStateSupported) throw new RecoveryError('unsupported_kind', 'Work-state capability is unavailable');
        const table = TABLES[kind];
        const from = kind === 'prompt' ? `${table} t LEFT JOIN sdk_sessions s ON t.session_db_id = s.id` : `${table} t`;
        const project = kind === 'prompt' ? "COALESCE(s.project, 'unknown')" : "COALESCE(t.project, 'unknown')";
        const held = kind === 'work_state' && !flags.sharedWorkWritesEnabled ? "AND COALESCE(t.list_name, '') NOT GLOB '__my_work_v[0-9]*:*'" : '';
        const candidates = this.db.prepare(`SELECT CAST(t.id AS TEXT) AS id FROM ${from}
          JOIN sync_launch_exclusions e ON e.kind = ? AND e.origin_local_id = CAST(t.id AS TEXT)
          WHERE t.origin_device_id IS NULL AND ${project} = ? AND t.created_at_epoch >= ? AND t.created_at_epoch < ?
          AND (t.synced_at IS NULL OR t.synced_at >= 0) ${held}
          AND (length(CAST(t.sync_rev AS TEXT)) < length(e.through_rev)
          OR (length(CAST(t.sync_rev AS TEXT)) = length(e.through_rev) AND CAST(t.sync_rev AS TEXT) <= e.through_rev))
          ORDER BY t.id LIMIT ?`).all(kind, scope.project, Date.parse(scope.from), Date.parse(scope.to), scope.maxItems - items.length + 1) as { id: string }[];
        if (items.length + candidates.length > scope.maxItems) throw new RecoveryError('selection_too_large', `Recovery selection exceeds ${scope.maxItems} items; narrow project/date/type scope`);
        for (const { id } of candidates) {
          let snapshot: ReturnType<RecoverySource['snapshotNative']>;
          try { snapshot = this.source.snapshotNative(kind, id); } catch { throw new RecoveryError('invalid_native_content', `Selected ${kind} ${id} is not canonical; investigate its diagnostic before recovery`); }
          if (!snapshot) throw new RecoveryError('stale_preview', 'Recovery selection changed; preview again');
          items.push({ kind, originLocalId: id, entityId: stableDocumentId(kind, this.deviceId, id), revision: snapshot.revision,
            operationSha256: snapshot.operation.operation_sha256, bytes: Buffer.byteLength(JSON.stringify(snapshot.operation), 'utf8') });
        }
      }
      const epoch = this.epoch();
      const previewToken = sha256Base64Url(JSON.stringify({ deviceId: this.deviceId, epoch, scope, items }));
      return { scope, deviceId: this.deviceId, epoch, previewToken, count: items.length,
        estimatedBytes: items.reduce((n, item) => n + item.bytes, 0), items, ownership: 'native' as const, coverage: 'selected_history' as const };
    })();
  }

  create(input: { scope: RecoveryScope; previewToken: string }) {
    return this.createFromPreview(this.preview(input.scope), input.previewToken);
  }

  /** The HTTP owner obtains this trusted preview off-thread; commit checks only its bounded members. */
  createFromPreview(preview: RecoveryPreview, expectedToken: string) {
    return this.db.transaction(() => {
      const token = sha256Base64Url(JSON.stringify({ deviceId: preview.deviceId, epoch: preview.epoch, scope: preview.scope, items: preview.items }));
      if (preview.previewToken !== expectedToken || token !== expectedToken || preview.deviceId !== this.deviceId
        || preview.epoch !== this.epoch() || preview.items.length > RECOVERY_MAX_ITEMS) {
        throw new RecoveryError('stale_preview', 'Recovery preview is stale; preview again');
      }
      const existing = this.db.prepare('SELECT id FROM sync_recovery_jobs WHERE preview_token = ?').get(preview.previewToken) as { id: string } | undefined;
      if (existing) return this.get(existing.id);
      if (!preview.count) throw new Error('Recovery selection is empty');
      for (const item of preview.items) {
        const current = this.source.snapshotNative(item.kind, item.originLocalId);
        if (!current || current.revision !== item.revision || current.operation.operation_sha256 !== item.operationSha256) {
          throw new RecoveryError('stale_preview', 'Recovery preview is stale; preview again');
        }
      }
      const id = randomUUID(); const now = Date.now();
      this.db.prepare(`INSERT INTO sync_recovery_jobs (id, preview_token, device_id, scope_json, epoch, status, created_at_epoch, updated_at_epoch)
        VALUES (?, ?, ?, ?, ?, 'paused', ?, ?)`).run(id, preview.previewToken, this.deviceId, JSON.stringify(preview.scope), preview.epoch, now, now);
      const insert = this.db.prepare(`INSERT INTO sync_recovery_items (job_id, kind, origin_local_id, entity_id, selected_rev, selected_sha256, estimated_bytes, status, updated_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'selected', ?)`);
      for (const item of preview.items) insert.run(id, item.kind, item.originLocalId, item.entityId, item.revision, item.operationSha256, item.bytes, now);
      return this.get(id);
    }).immediate();
  }

  get(id: string): RecoveryJob {
    const job = this.db.prepare('SELECT * FROM sync_recovery_jobs WHERE id = ? AND device_id = ?').get(id, this.deviceId) as (Omit<RecoveryJob, 'scope' | 'items'> & { scope_json: string }) | undefined;
    if (!job) throw new Error('Recovery job not found for this device');
    const items = this.db.prepare('SELECT kind, origin_local_id, entity_id, selected_rev, estimated_bytes, status, queued_rev, queued_epoch, acknowledged_epoch, detail FROM sync_recovery_items WHERE job_id = ? ORDER BY kind, origin_local_id LIMIT ?').all(id, RECOVERY_MAX_ITEMS);
    const { scope_json, ...fields } = job;
    return { ...fields, scope: JSON.parse(scope_json), items };
  }

  list(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Job limit must be 1..100');
    return this.db.prepare('SELECT id, status, epoch, pause_reason, created_at_epoch, updated_at_epoch FROM sync_recovery_jobs WHERE device_id = ? ORDER BY created_at_epoch DESC LIMIT ?').all(this.deviceId, limit);
  }

  hasPendingSelection(): boolean {
    return this.available && !!this.db.prepare(`SELECT 1 FROM sync_recovery_jobs j
      JOIN sync_recovery_items i ON i.job_id = j.id WHERE j.device_id = ? AND j.status = 'running'
      AND i.status = 'selected' LIMIT 1`).get(this.deviceId);
  }

  /** Capability discovery must see selected history even when its native rows are launch-stamped. */
  hasSelectedWorkState(): boolean {
    if (!this.available) return false;
    const sharedAllowed = this.source.flags().sharedWorkWritesEnabled;
    return !!this.db.prepare(`SELECT 1 FROM sync_recovery_jobs j JOIN sync_recovery_items i ON i.job_id = j.id
      JOIN work_state_entries w ON w.id = i.origin_local_id AND w.origin_device_id IS NULL
      WHERE j.device_id = ? AND j.status = 'running' AND i.status = 'selected' AND i.kind = 'work_state'
      AND (? = 1 OR COALESCE(w.list_name, '') NOT GLOB '__my_work_v[0-9]*:*') LIMIT 1`).get(this.deviceId, Number(sharedAllowed));
  }

  transition(id: string, action: 'resume' | 'pause' | 'cancel', expectedEpoch: string | null) {
    if (!['resume', 'pause', 'cancel'].includes(action)) throw new Error('Invalid recovery action');
    return this.db.transaction(() => {
      const job = this.get(id);
      if (job.status === 'cancelled') { if (action === 'cancel') return job; throw new Error('Cancelled jobs cannot resume; create a new preview'); }
      if (action === 'resume' && job.status !== 'running') {
        const active = (this.db.prepare("SELECT COUNT(*) AS n FROM sync_recovery_jobs WHERE device_id = ? AND status = 'running'").get(this.deviceId) as { n: number }).n;
        if (active >= RECOVERY_MAX_ACTIVE_JOBS) throw new RecoveryError('active_job_limit', `Pause an active job before resuming; maximum ${RECOVERY_MAX_ACTIVE_JOBS} active jobs`);
      }
      const epoch = this.epoch();
      if (action === 'resume' && expectedEpoch !== epoch) throw new Error('Recovery epoch changed; inspect and resume with the current epoch');
      if (action === 'resume') {
        // Each receipt owns its epoch. A control transition must never erase
        // that proof or let a previously rewritten job epoch hide stale items.
        this.db.prepare(`UPDATE sync_recovery_items SET status = 'selected', queued_rev = NULL,
          queued_sha256 = NULL, queued_epoch = NULL, acknowledged_epoch = NULL, detail = 'epoch_changed', updated_at_epoch = ?
          WHERE job_id = ? AND ((status = 'queued' AND queued_epoch IS NOT ?)
            OR (status = 'acknowledged' AND acknowledged_epoch IS NOT ?))`).run(Date.now(), id, epoch, epoch);
      }
      this.db.prepare('UPDATE sync_recovery_jobs SET status = ?, epoch = CASE WHEN ? = 1 THEN ? ELSE epoch END, pause_reason = NULL, updated_at_epoch = ? WHERE id = ?')
        .run(action === 'resume' ? 'running' : action === 'pause' ? 'paused' : 'cancelled', Number(action === 'resume'), epoch, Date.now(), id);
      return this.get(id);
    })();
  }

  /** Called only by the upload owner's idle lane. No eligibility flag is changed globally. */
  selectPage(limit: number): RecoveryItem[] {
    if (!this.available) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid recovery page limit');
    return this.db.transaction(() => {
      const jobs = this.db.prepare("SELECT id, epoch FROM sync_recovery_jobs WHERE device_id = ? AND status = 'running' ORDER BY created_at_epoch LIMIT ?").all(this.deviceId, RECOVERY_MAX_ACTIVE_JOBS) as { id: string; epoch: string | null }[];
      const selections: RecoveryItem[] = [];
      const flags = this.source.flags();
      this.itemsSettledByLastPage = 0;
      for (const job of jobs) {
        if (job.epoch !== this.epoch()) {
          this.db.prepare("UPDATE sync_recovery_jobs SET status = 'paused', pause_reason = 'epoch_changed', updated_at_epoch = ? WHERE id = ?").run(Date.now(), job.id); continue;
        }
        const rows = this.db.prepare(`SELECT i.* FROM sync_recovery_items i WHERE i.job_id = ? AND i.status = 'selected'
          AND (? = 1 OR i.kind != 'work_state')
          AND (? = 1 OR NOT EXISTS (SELECT 1 FROM work_state_entries w WHERE i.kind = 'work_state'
            AND w.id = i.origin_local_id AND COALESCE(w.list_name, '') GLOB '__my_work_v[0-9]*:*'))
          ORDER BY i.kind, i.origin_local_id LIMIT ?`).all(job.id, Number(flags.workStateSupported), Number(flags.sharedWorkWritesEnabled), Math.max(0, limit - selections.length)) as StoredItem[];
        for (const row of rows) {
          let snapshot: ReturnType<RecoverySource['snapshotNative']>;
          try { snapshot = this.source.snapshotNative(row.kind, row.origin_local_id); }
          catch { this.finishItem(row, 'failed', 'invalid_native_content'); this.itemsSettledByLastPage++; continue; }
          if (!snapshot) { this.finishItem(row, 'deleted', 'native_missing'); this.itemsSettledByLastPage++; continue; }
          if (snapshot.revision !== row.selected_rev || snapshot.operation.operation_sha256 !== row.selected_sha256) {
            this.finishItem(row, 'superseded', 'native_revision_changed'); this.itemsSettledByLastPage++; continue;
          }
          selections.push({ kind: row.kind, originLocalId: row.origin_local_id, entityId: row.entity_id, revision: row.selected_rev, operationSha256: row.selected_sha256, bytes: row.estimated_bytes });
        }
        this.completeIfFinished(job.id);
        if (selections.length >= limit) break;
      }
      return selections;
    })();
  }

  recordSnapshot(item: RecoveryItem, revision: string, hash: string): void {
    if (!this.available) return;
    this.db.prepare(`UPDATE sync_recovery_items SET status = 'queued', queued_rev = ?, queued_sha256 = ?, queued_epoch = ?, updated_at_epoch = ?
      WHERE entity_id = ? AND selected_rev = ? AND selected_sha256 = ? AND status = 'selected'
      AND job_id IN (SELECT id FROM sync_recovery_jobs WHERE device_id = ? AND status = 'running')`)
      .run(revision, hash, this.epoch(), Date.now(), item.entityId, item.revision, item.operationSha256, this.deviceId);
  }

  recordSelectionFailure(item: RecoveryItem): void {
    this.db.prepare(`UPDATE sync_recovery_items SET status = 'failed', detail = 'canonical_quarantine', updated_at_epoch = ?
      WHERE entity_id = ? AND selected_rev = ? AND selected_sha256 = ? AND status = 'selected'`)
      .run(Date.now(), item.entityId, item.revision, item.operationSha256);
    this.completeTerminalJobsForEntity(item.entityId);
  }

  recordSelectionChanged(item: RecoveryItem, missing: boolean): void {
    this.db.prepare(`UPDATE sync_recovery_items SET status = ?, detail = ?, updated_at_epoch = ?
      WHERE entity_id = ? AND selected_rev = ? AND selected_sha256 = ? AND status = 'selected'`)
      .run(missing ? 'deleted' : 'superseded', missing ? 'native_missing' : 'native_revision_changed', Date.now(), item.entityId, item.revision, item.operationSha256);
    this.completeTerminalJobsForEntity(item.entityId);
  }

  recordAcknowledgement(entityId: string, revision: string, hash: string, requestEpoch = this.epoch()): void {
    if (!this.available) return;
    const rows = this.db.prepare("SELECT * FROM sync_recovery_items WHERE entity_id = ? AND queued_rev = ? AND queued_sha256 = ? AND status IN ('queued', 'deleted')").all(entityId, revision, hash) as StoredItem[];
    for (const row of rows) {
      const job = this.db.prepare('SELECT epoch FROM sync_recovery_jobs WHERE id = ?').get(row.job_id) as { epoch: string | null };
      if (requestEpoch !== this.epoch() || job.epoch !== requestEpoch || row.queued_epoch !== requestEpoch) {
        this.db.prepare("UPDATE sync_recovery_jobs SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'paused' END, pause_reason = 'epoch_changed', updated_at_epoch = ? WHERE id = ?").run(Date.now(), row.job_id);
        this.receipt(row, revision, hash, 'acknowledged_epoch_unverified', null);
        continue;
      }
      this.db.prepare("UPDATE sync_recovery_items SET status = 'acknowledged', acknowledged_epoch = ?, updated_at_epoch = ? WHERE job_id = ? AND entity_id = ? AND status = 'queued'").run(this.epoch(), Date.now(), row.job_id, entityId);
      this.receipt(row, revision, hash, 'acknowledged'); this.completeIfFinished(row.job_id);
    }
  }

  recordDeletion(entityId: string): void {
    if (!this.available) return;
    this.db.prepare("UPDATE sync_recovery_items SET status = 'deleted', detail = 'native_deleted', updated_at_epoch = ? WHERE entity_id = ? AND status IN ('selected', 'queued')").run(Date.now(), entityId);
    this.completeTerminalJobsForEntity(entityId);
  }

  recordFailure(entityId: string, revision: string, hash: string): void {
    if (!this.available) return;
    const rows = this.db.prepare("SELECT * FROM sync_recovery_items WHERE entity_id = ? AND queued_rev = ? AND queued_sha256 = ? AND status = 'queued'").all(entityId, revision, hash) as StoredItem[];
    for (const row of rows) { this.finishItem(row, 'failed', 'canonical_quarantine'); this.receipt(row, revision, hash, 'failed'); this.completeIfFinished(row.job_id); }
  }

  currentEpoch(): string | null { return this.epoch(); }
  private epoch(): string | null { return (this.db.prepare("SELECT v FROM sync_state WHERE k = 'epoch'").get() as { v: string } | undefined)?.v ?? null; }
  private finishItem(row: StoredItem, status: RecoveryItemState, detail: string) { this.db.prepare('UPDATE sync_recovery_items SET status = ?, detail = ?, updated_at_epoch = ? WHERE job_id = ? AND entity_id = ?').run(status, detail, Date.now(), row.job_id, row.entity_id); }
  private receipt(row: StoredItem, revision: string, hash: string, event: string, epoch = this.epoch()) { this.db.prepare('INSERT INTO sync_recovery_receipts (job_id, entity_id, entity_rev, operation_sha256, epoch, event, created_at_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.job_id, row.entity_id, revision, hash, epoch, event, Date.now()); }
  private completeIfFinished(id: string) { this.db.prepare("UPDATE sync_recovery_jobs SET status = 'complete', updated_at_epoch = ? WHERE id = ? AND status = 'running' AND NOT EXISTS (SELECT 1 FROM sync_recovery_items WHERE job_id = ? AND status IN ('selected', 'queued'))").run(Date.now(), id, id); }
  private completeTerminalJobsForEntity(entityId: string) {
    this.db.prepare(`UPDATE sync_recovery_jobs SET status = 'complete', updated_at_epoch = ? WHERE status = 'running'
      AND id IN (SELECT job_id FROM sync_recovery_items WHERE entity_id = ?)
      AND NOT EXISTS (SELECT 1 FROM sync_recovery_items WHERE job_id = sync_recovery_jobs.id AND status IN ('selected', 'queued'))`).run(Date.now(), entityId);
  }
}

interface StoredItem { job_id: string; kind: ContentKind; origin_local_id: string; entity_id: string; selected_rev: string; selected_sha256: string; estimated_bytes: number; queued_epoch: string | null }

function normalizeScope(input: RecoveryScope): Required<RecoveryScope> {
  if (!input || typeof input.project !== 'string' || !input.project.trim() || input.project.length > 512) throw new Error('An explicit project is required');
  if (typeof input.from !== 'string' || typeof input.to !== 'string') throw new RecoveryError('invalid_scope', 'Explicit string dates are required', 400);
  const from = Date.parse(input.from); const to = Date.parse(input.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('An explicit increasing date interval is required');
  if (!Array.isArray(input.kinds) || !input.kinds.length || input.kinds.some(kind => !Object.hasOwn(TABLES, kind))) throw new Error('Explicit valid content kinds are required');
  const maxItems = input.maxItems ?? RECOVERY_MAX_ITEMS;
  if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > RECOVERY_MAX_ITEMS) throw new Error(`maxItems must be 1..${RECOVERY_MAX_ITEMS}`);
  return { project: input.project, from: new Date(from).toISOString(), to: new Date(to).toISOString(), kinds: [...new Set(input.kinds)].sort(), maxItems };
}
