import type { Worker } from 'node:worker_threads';
import { createWorkViewReadWorker } from '../work-view/WorkViewReadWorkerClient.js';
import { RecoveryError, type RecoveryPreview, type RecoveryScope, type SyncRecovery } from './SyncRecovery.js';
import type { SyncQueueFlags } from './SyncQueueEvidence.js';
import type { ContentKind } from './CanonicalContent.js';
import { SyncRecoveryError, type LocalConflictEvidence } from './SyncConflictEvidence.js';

type Inventory = ReturnType<SyncRecovery['inventory']>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Dedicated read-only connection: selected history scans never block viewer HTTP/projection reads. */
export class SyncRecoveryReader {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(private readonly databasePath: string, private readonly deviceId: string, private readonly flags: () => SyncQueueFlags) {}

  inventory(): Promise<Inventory> { return this.read('inventory') as Promise<Inventory>; }
  preview(scope: RecoveryScope): Promise<RecoveryPreview> { return this.read('preview', scope) as Promise<RecoveryPreview>; }
  conflictEvidence(kind: ContentKind, originLocalId: string): Promise<LocalConflictEvidence> {
    return this.read('conflict-evidence', undefined, { contentKind: kind, originLocalId }) as Promise<LocalConflictEvidence>;
  }
  conflicts(limit = 50): Promise<unknown[]> { return this.read('conflict-list', undefined, { limit }) as Promise<unknown[]>; }

  close(): void {
    this.closed = true;
    this.fail();
  }

  private read(kind: 'inventory' | 'preview' | 'conflict-evidence' | 'conflict-list', scope?: RecoveryScope, detail?: object): Promise<unknown> {
    if (this.closed || !this.databasePath || this.databasePath === ':memory:') return Promise.reject(new Error('recovery_reader_unavailable'));
    if (this.pending.size >= 4) return Promise.reject(new Error('recovery_reader_busy'));
    if (!this.worker) {
      const worker = createWorkViewReadWorker({ kind: 'sync-recovery', databasePath: this.databasePath, deviceId: this.deviceId });
      this.worker = worker;
      worker.on('message', (reply: { id: number; ok: boolean; result?: unknown; code?: string; status?: number }) => {
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        clearTimeout(pending.timer);
        if (reply.ok) pending.resolve(reply.result);
        else pending.reject(reply.code?.startsWith('repair_') || reply.code === 'native_origin_required' || reply.code === 'shared_work_repair_unsupported'
          ? new SyncRecoveryError(reply.code, reply.status ?? 409)
          : new RecoveryError(reply.code ?? 'recovery_read_failed', 'Recovery read could not be completed.', reply.status ?? 503));
        if (!this.pending.size) worker.unref();
      });
      worker.on('error', () => { if (this.worker === worker) this.fail(); });
      worker.on('exit', () => { if (this.worker === worker) this.fail(); });
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.ref();
      try { this.worker!.postMessage({ id, kind, scope, flags: this.flags(), ...detail }); }
      catch { this.fail(); }
    });
  }

  private fail(): void {
    const worker = this.worker;
    this.worker = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('recovery_reader_unavailable'));
    }
    this.pending.clear();
    if (worker) void worker.terminate();
  }
}
