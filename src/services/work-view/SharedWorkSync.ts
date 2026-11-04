import type { Database } from 'bun:sqlite';
import type { Worker } from 'node:worker_threads';
import { createWorkViewReadWorker } from './WorkViewReadWorkerClient.js';
import { SharedLedgerAdapter } from './shared-ledger-adapter.mjs';
import { registerSharedFileWriter } from './shared-file-hooks.mjs';
import { emitContextInvalidation } from '../../shared/context-invalidation.js';
import { MY_RULES_LIST } from './my-rules.mjs';

type SharedOptions = { databasePath: string; directory: string; deviceId: string; notify: () => void; intervalMs?: number; enabled?: boolean };

/** Owns local compatibility writers and a separate background import/capture worker. */
export class SharedWorkSync {
  private readonly adapter: SharedLedgerAdapter | null;
  private worker: Worker | null = null;
  private pending: Promise<void> | null = null;
  private finish: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopWriter: (() => void) | null = null;
  private closed = false;
  private diagnostic: unknown = null;

  constructor(db: Database, private readonly options: SharedOptions) {
    this.adapter = options.enabled === true
      ? new SharedLedgerAdapter(db, { directory: options.directory, deviceId: options.deviceId, notify: change => this.changed(change?.rules) }) : null;
  }

  start(): void {
    if (!this.adapter || this.stopWriter || this.closed) return;
    const adapter = this.adapter;
    this.stopWriter = registerSharedFileWriter(this.options.directory, (name, value) => adapter.beforeWrite(name, value));
    const interval = this.options.intervalMs ?? 5_000;
    this.timer = setInterval(() => { void this.reconcile(); }, interval);
    this.timer.unref?.();
    void this.reconcile();
  }

  saveFile(name: string, value: unknown): void {
    if (!this.adapter) throw new Error('Shared My Work state is not enabled.');
    this.adapter.saveFile(name, value);
  }

  persistCopy(requestId: string, entry: unknown): void {
    if (!this.adapter) throw new Error('Shared My Work state is not enabled.');
    this.adapter.publish([{ kind: 'copy', key: requestId, value: entry }]);
  }

  status(): Record<string, unknown> {
    return { ...(this.diagnostic && typeof this.diagnostic === 'object' ? this.diagnostic : {}), enabled: this.adapter !== null };
  }

  reconcile(): Promise<void> {
    if (!this.adapter || this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = new Promise(resolve => { this.finish = resolve; });
    try {
      const worker = this.worker ?? createWorkViewReadWorker({ kind: 'shared-work-sync', databasePath: this.options.databasePath,
        directory: this.options.directory, deviceId: this.options.deviceId });
      if (!this.worker) {
        this.worker = worker;
        worker.on('message', (reply: { changed?: boolean; rulesChanged?: boolean; diagnostic?: unknown }) => {
          if (this.worker !== worker) return;
          this.diagnostic = reply.diagnostic ?? null;
          if (reply.changed) this.changed(reply.rulesChanged);
          worker.unref();
          this.settle();
        });
        worker.on('error', () => this.failed(worker));
        worker.on('exit', () => this.failed(worker));
      }
      worker.ref();
      worker.postMessage('reconcile');
    } catch { this.settle(); }
    return this.pending ?? Promise.resolve();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.stopWriter?.();
    const worker = this.worker;
    this.worker = null;
    this.settle();
    if (worker) void worker.terminate();
  }

  private changed(rules = false): void {
    this.options.notify();
    emitContextInvalidation('all', 'SharedWorkSync.changed', 'additive', { kinds: ['work_state'], workStateLists: ['__my_work_v1:records', ...(rules ? [MY_RULES_LIST] : [])] });
  }

  private settle(): void {
    const finish = this.finish;
    this.finish = null; this.pending = null;
    finish?.();
    // The periodic check handles external/Python writers and avoids a capture
    // feedback loop from its own SQLite commits. One in-flight pass at a time.
  }

  private failed(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.diagnostic = { error: 'Shared work could not be refreshed; retrying.' };
    this.settle();
    void worker.terminate();
  }
}
