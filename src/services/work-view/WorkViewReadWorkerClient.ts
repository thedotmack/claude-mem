import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { boundedDurationMs, WORK_VIEW_READ_PURPOSES, type WorkViewReadDiagnostic, type WorkViewReadPurpose, type WorkViewReaderDiagnostics, type WorkViewReadRequest, type WorkViewReadResponse, type WorkViewReadResult, type WorkViewRulesReadResult } from './WorkViewReadProtocol.js';

type Pending = { resolve(value: WorkViewReadResult): void; reject(error: Error): void; enqueuedAtNs: bigint; startedAtNs: bigint | null; purpose: WorkViewReadPurpose; pendingAtEnqueue: number };

/** Same packaged entrypoint, independent worker and queue for each reader. */
export function createWorkViewReadWorker(workerData: object): Worker {
  const candidates = ['work-view-read-worker.ts', 'work-view-read-worker.cjs'].map(name => new URL(name, import.meta.url));
  const entry = candidates.find(candidate => existsSync(candidate)) ?? new URL('./work-view-read-worker.js', import.meta.url);
  return new Worker(entry, { workerData });
}

/**
 * Runs SQLite-backed work-view projection reads away from the worker HTTP event loop, one at a time and answered in the
 * order they were asked (WorkViewRoutes relies on that). The queue has no cap of its own: each read belongs to an open
 * HTTP request or to one of the routes' collapsed background reads, and refusing one after a saved edit would fail
 * a request whose write already landed.
 */
export class WorkViewReadWorkerClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private maxPendingCount = 0;
  private completedReads = 0;
  private failedReads = 0;
  private lastRead: WorkViewReadDiagnostic | null = null;

  constructor(private readonly workerData: { databasePath: string; ledgerDir: string | null; pollIntervalMs: number }) {}

  read(maxActivityAgeMs: number, localDeviceId: string, purpose: WorkViewReadPurpose = 'snapshot'): Promise<WorkViewReadResult> {
    return this.request(maxActivityAgeMs, localDeviceId, purpose, 'view');
  }

  async readRules(localDeviceId: string): Promise<WorkViewRulesReadResult> {
    const { agentView } = await this.request(0, localDeviceId, 'rules', 'rules');
    return { rules: agentView.rules as WorkViewRulesReadResult['rules'], source: agentView.source };
  }

  invalidateActivity(workState = false): void {
    const worker = this.worker;
    if (!worker || this.closed) return; // A new reader has no cached activity.
    try { worker.postMessage({ kind: 'invalidate-activity', workState }); }
    catch (error) { this.failWorker(worker, error instanceof Error ? error : new Error(String(error))); }
  }

  private request(maxActivityAgeMs: number, localDeviceId: string, purpose: WorkViewReadPurpose, kind: 'view' | 'rules'): Promise<WorkViewReadResult> {
    let worker: Worker;
    try { worker = this.getWorker(); }
    catch (error) { return Promise.reject(error); }
    const id = ++this.nextId;
    const enqueuedAtNs = process.hrtime.bigint();
    const safePurpose = WORK_VIEW_READ_PURPOSES.includes(purpose) ? purpose : 'snapshot';
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, enqueuedAtNs, startedAtNs: null, purpose: safePurpose, pendingAtEnqueue: this.pending.size });
      this.maxPendingCount = Math.max(this.maxPendingCount, this.pending.size);
      worker.ref();
      try { worker.postMessage({ id, maxActivityAgeMs, localDeviceId, kind } satisfies WorkViewReadRequest); }
      catch (error) {
        this.recordRead(this.pending.get(id)!, false);
        this.pending.delete(id);
        if (!this.pending.size) worker.unref();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** One fixed-size sample and counters; no source data, IDs or unbounded history. */
  getDiagnostics(): WorkViewReaderDiagnostics {
    return { pendingCount: this.pending.size, maxPendingCount: this.maxPendingCount, completedReads: this.completedReads,
      failedReads: this.failedReads, lastRead: this.lastRead ? { ...this.lastRead } : null };
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    this.rejectPending(new Error('Work view reader closed'));
    if (worker) await worker.terminate();
  }

  private getWorker(): Worker {
    if (this.closed) throw new Error('Work view reader closed');
    if (this.worker) return this.worker;
    const worker = createWorkViewReadWorker(this.workerData);
    this.worker = worker;
    worker.on('message', (response: WorkViewReadResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      if ('started' in response) {
        pending.startedAtNs ??= process.hrtime.bigint();
        return;
      }
      this.pending.delete(response.id);
      this.recordRead(pending, response.ok && response.result.agentView.source.connected === true, response.timing);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(Object.assign(new Error(response.error.message), { name: response.error.name }));
      if (!this.pending.size) worker.unref();
    });
    worker.on('error', error => this.failWorker(worker, error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', code => this.failWorker(worker, new Error(`Work view reader exited with code ${code}`)));
    return worker;
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      this.recordRead(pending, false);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private recordRead(pending: Pending, ok: boolean, timing?: { readMs: number }): void {
    const roundTripMs = boundedDurationMs(Number(process.hrtime.bigint() - pending.enqueuedAtNs) / 1e6);
    // Bun's hrtime origin is realm-local, so measure enqueue -> started entirely here.
    const queueWaitMs = pending.startedAtNs === null ? 0
      : Math.min(roundTripMs, boundedDurationMs(Number(pending.startedAtNs - pending.enqueuedAtNs) / 1e6));
    const readMs = boundedDurationMs(timing?.readMs ?? 0);
    this.completedReads = Math.min(Number.MAX_SAFE_INTEGER, this.completedReads + 1);
    if (!ok) this.failedReads = Math.min(Number.MAX_SAFE_INTEGER, this.failedReads + 1);
    this.lastRead = { purpose: pending.purpose, pendingAtEnqueue: pending.pendingAtEnqueue,
      queueWaitMs, readMs, roundTripMs, started: pending.startedAtNs !== null, ok };
  }
}
