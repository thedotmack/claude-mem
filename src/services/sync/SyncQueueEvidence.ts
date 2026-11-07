import type { Database } from 'bun:sqlite';
import type { Worker } from 'node:worker_threads';
import type { ContentKind } from './CanonicalContent.js';
import { createWorkViewReadWorker } from '../work-view/WorkViewReadWorkerClient.js';
import { affectedByMutationSql, FROZEN_SCOPE, HEAD_MUTATION_SQL, mutationPrerequisiteSql, nativeScope, PENDING_MUTATIONS_SQL } from './SyncScheduling.js';

export interface SyncQueueFlags {
  deviceId: string;
  sharedWorkWritesEnabled: boolean;
  workStateSupported: boolean;
}

export interface SyncQueueKindInventory {
  /** Mutable native revisions not already represented by a frozen revision. */
  nativePending: number;
  /** Includes tombstones; a frozen revision is counted once, not as a native row too. */
  frozenPending: number;
  eligiblePending: number;
  heldPending: number;
  /** Hold reasons may overlap; heldPending is the distinct total. */
  heldSharedState: number;
  heldUnsupportedKind: number;
  heldMutation: number;
  oldestMutationHeldQueuedAt: number | null;
  tombstones: number;
  /** Actual frozen enqueue time. Native rows do not store an enqueue timestamp. */
  oldestQueuedAt: number | null;
  oldestEligibleQueuedAt: number | null;
  /** Record creation time, deliberately not described as queue age. */
  oldestNativeCreatedAt: number | null;
}

export interface SyncQueueInventory {
  observedAt: number;
  kinds: Record<ContentKind, SyncQueueKindInventory>;
  mutations: { pending: number; oldestQueuedAt: number | null };
  /** Subtotals across the content kinds; tombstones lead each kind's turn. */
  tombstones: { pending: number; eligiblePending: number; oldestQueuedAt: number | null };
}

export interface SyncQueueEvidenceSnapshot {
  inventory: SyncQueueInventory | null;
  observedAt: number | null;
  stale: boolean;
  refreshing: boolean;
}

const TABLES: Record<ContentKind, string> = {
  observation: 'observations', summary: 'session_summaries', prompt: 'user_prompts', work_state: 'work_state_entries',
};
const SHARED_LIST = "COALESCE(list_name, '') GLOB '__my_work_v[0-9]*:*'";
type Aggregate = { pending: number; eligible: number; shared: number; mutationHeld: number; tombstones: number; oldest: number | null; oldestEligible: number | null; oldestMutationHeld: number | null };

/** Runs only in the dedicated inventory worker (or an explicit test), never in status(). */
export function readSyncQueueInventory(db: Database, flags: SyncQueueFlags): SyncQueueInventory {
  const kinds = {} as SyncQueueInventory['kinds'];
  let tombstones = 0;
  let eligibleTombstones = 0;
  let oldestTombstone: number | null = null;
  // A read transaction makes native/frozen deduplication consistent while the uploader advances.
  const read = db.transaction(() => {
    const deviceSql = (db.prepare('SELECT quote(?) AS value').get(flags.deviceId) as { value: string }).value;
    for (const [kind, table] of Object.entries(TABLES) as Array<[ContentKind, string]>) {
      const scope = nativeScope(kind);
      const nativeAlias = kind === 'prompt' ? 'up' : table;
      const nativeFrom = kind === 'prompt' ? `${table} up LEFT JOIN sdk_sessions s ON up.session_db_id = s.id` : table;
      const nativeHeld = `EXISTS (SELECT 1 FROM ${PENDING_MUTATIONS_SQL} m WHERE ${affectedByMutationSql(scope, deviceSql)})`;
      const shared = kind === 'work_state' ? SHARED_LIST : '0';
      const kindAllowed = kind !== 'work_state' ? '1' : !flags.workStateSupported ? '0'
        : flags.sharedWorkWritesEnabled ? '1' : `NOT (${shared})`;
      const allowed = `(${kindAllowed}) AND NOT (${nativeHeld})`;
      const native = db.prepare(`
        SELECT COUNT(*) AS pending, COALESCE(SUM(${allowed}), 0) AS eligible,
          COALESCE(SUM(${shared}), 0) AS shared, COALESCE(SUM(${nativeHeld}), 0) AS mutationHeld,
          MIN(${nativeAlias}.created_at_epoch) AS oldest
        FROM ${nativeFrom} WHERE ${nativeAlias}.synced_at IS NULL AND ${nativeAlias}.origin_device_id IS NULL
          AND (${scope.localId}, ${scope.rev}) NOT IN
            (SELECT origin_local_id, entity_rev FROM sync_content_outbox WHERE kind = ?)
      `).get(kind) as Aggregate;
      // Null list names (including tombstones without payloads) use the existing uploader policy.
      const frozenShared = kind === 'work_state'
        ? "COALESCE(CASE WHEN json_valid(o.body) THEN json_extract(o.body, '$.payload.list_name') END, '') GLOB '__my_work_v[0-9]*:*'" : '0';
      const frozenHeld = `(EXISTS (SELECT 1 FROM ${PENDING_MUTATIONS_SQL} m WHERE
        ${affectedByMutationSql(FROZEN_SCOPE, deviceSql)} AND NOT ${mutationPrerequisiteSql(FROZEN_SCOPE, deviceSql)})
        AND NOT EXISTS (SELECT 1 FROM ${HEAD_MUTATION_SQL} m WHERE ${mutationPrerequisiteSql(FROZEN_SCOPE, deviceSql)}))`;
      const frozenKindAllowed = kind !== 'work_state' ? '1' : !flags.workStateSupported ? '0'
        : flags.sharedWorkWritesEnabled ? '1' : `NOT (${frozenShared})`;
      const frozenAllowed = `(${frozenKindAllowed}) AND NOT (${frozenHeld})`;
      const frozen = db.prepare(`
        SELECT COUNT(*) AS pending, COALESCE(SUM(${frozenAllowed}), 0) AS eligible,
          COALESCE(SUM(${frozenShared}), 0) AS shared, COALESCE(SUM(${frozenHeld}), 0) AS mutationHeld,
          COALESCE(SUM(o.deleted), 0) AS tombstones, MIN(o.created_at_epoch) AS oldest,
          MIN(CASE WHEN ${frozenAllowed} THEN o.created_at_epoch END) AS oldestEligible,
          MIN(CASE WHEN ${frozenHeld} THEN o.created_at_epoch END) AS oldestMutationHeld
        FROM sync_content_outbox o WHERE o.kind = ?
      `).get(kind) as Aggregate;
      const deleted = db.prepare(`
        SELECT COUNT(*) AS pending, COALESCE(SUM(${frozenAllowed}), 0) AS eligible,
          MIN(o.created_at_epoch) AS oldest FROM sync_content_outbox o WHERE o.kind = ? AND o.deleted = 1
      `).get(kind) as Aggregate;
      const pending = native.pending + frozen.pending;
      const eligible = native.eligible + frozen.eligible;
      kinds[kind] = {
        nativePending: native.pending, frozenPending: frozen.pending, eligiblePending: eligible,
        heldPending: pending - eligible,
        heldSharedState: kind === 'work_state' && !flags.sharedWorkWritesEnabled ? native.shared + frozen.shared : 0,
        heldUnsupportedKind: kind === 'work_state' && !flags.workStateSupported ? pending : 0,
        heldMutation: native.mutationHeld + frozen.mutationHeld, oldestMutationHeldQueuedAt: frozen.oldestMutationHeld,
        tombstones: frozen.tombstones, oldestQueuedAt: frozen.oldest,
        oldestEligibleQueuedAt: frozen.oldestEligible, oldestNativeCreatedAt: native.oldest,
      };
      tombstones += deleted.pending;
      eligibleTombstones += deleted.eligible;
      if (deleted.oldest !== null) oldestTombstone = oldestTombstone === null ? deleted.oldest : Math.min(oldestTombstone, deleted.oldest);
    }
    const mutations = db.prepare('SELECT COUNT(*) AS pending, MIN(created_at_epoch) AS oldestQueuedAt FROM sync_outbox')
      .get() as SyncQueueInventory['mutations'];
    return { observedAt: Date.now(), kinds, mutations,
      tombstones: { pending: tombstones, eligiblePending: eligibleTombstones, oldestQueuedAt: oldestTombstone } };
  });
  return read();
}

/** Cached, collapsed reads on an independent worker; getSnapshot never runs SQL or awaits a scan. */
export class SyncQueueEvidenceReader {
  private worker: Worker | null = null;
  private pending: { flags: SyncQueueFlags; promise: Promise<SyncQueueInventory | null>; resolve(value: SyncQueueInventory | null): void } | null = null;
  private cached: { flags: SyncQueueFlags; inventory: SyncQueueInventory } | null = null;
  private closed = false;
  private lastAttemptAt = 0;
  private lastAttemptFlags: SyncQueueFlags | null = null;
  private lastAttemptFailed = false;

  constructor(private readonly databasePath: string, private readonly refreshMs = 5000) {}

  getSnapshot(flags: SyncQueueFlags): SyncQueueEvidenceSnapshot {
    const stale = this.lastAttemptFailed || !this.cached || !sameFlags(this.cached.flags, flags)
      || Date.now() - this.cached.inventory.observedAt >= this.refreshMs;
    if (stale && !this.pending && (!this.lastAttemptFlags || !sameFlags(this.lastAttemptFlags, flags)
      || Date.now() - this.lastAttemptAt >= this.refreshMs)) void this.read(flags);
    return { inventory: this.cached?.inventory ?? null, observedAt: this.cached?.inventory.observedAt ?? null,
      stale, refreshing: this.pending !== null };
  }

  read(flags: SyncQueueFlags): Promise<SyncQueueInventory | null> {
    if (this.closed || !this.databasePath || this.databasePath === ':memory:') return Promise.resolve(null);
    if (this.pending) return this.pending.promise;
    this.lastAttemptAt = Date.now();
    this.lastAttemptFlags = { ...flags };
    let resolve!: (value: SyncQueueInventory | null) => void;
    const promise = new Promise<SyncQueueInventory | null>(settle => { resolve = settle; });
    this.pending = { flags: { ...flags }, promise, resolve };
    try {
      const worker = this.worker ?? createWorkViewReadWorker({ kind: 'sync-queue-evidence', databasePath: this.databasePath });
      if (!this.worker) {
        this.worker = worker;
        worker.on('message', (value: SyncQueueInventory | null) => {
          if (this.worker !== worker) return;
          this.settle(value);
          worker.unref();
        });
        worker.on('error', () => this.failed(worker));
        worker.on('exit', () => this.failed(worker));
      }
      worker.ref();
      worker.postMessage(flags);
    } catch { this.settle(null); }
    return promise;
  }

  close(): void {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    this.settle(null);
    if (worker) void worker.terminate();
  }

  private failed(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.settle(null);
    void worker.terminate();
  }

  private settle(inventory: SyncQueueInventory | null): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) this.lastAttemptFailed = inventory === null;
    if (pending && inventory) this.cached = { flags: pending.flags, inventory };
    pending?.resolve(inventory);
  }
}

function sameFlags(a: SyncQueueFlags, b: SyncQueueFlags): boolean {
  return a.deviceId === b.deviceId && a.sharedWorkWritesEnabled === b.sharedWorkWritesEnabled && a.workStateSupported === b.workStateSupported;
}
