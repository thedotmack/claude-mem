import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { boundedDurationMs, WORK_VIEW_READ_PURPOSES, type WorkViewReadDiagnostic, type WorkViewReadPurpose, type WorkViewReaderDiagnostics, type WorkViewReadRequest, type WorkViewReadResponse, type WorkViewReadResult, type WorkViewRulesReadResult } from './WorkViewReadProtocol.js';

/**
 * A read with no reply by this deadline is a hung work-view reader (#5374).
 * The number mirrors the context reader's deadline: the reader answers one
 * message at a time and this clock starts when a read is queued, so 120 s
 * covers this read plus one as slow ahead of it, with margin. SQLite's busy
 * wait fits well inside it.
 */
export const WORK_VIEW_READ_REQUEST_TIMEOUT_MS = 120_000;

/**
 * close() and hung-reader retirement stop waiting for terminate() after this.
 * A healthy reader closed in 15 ms at most (measured: 20 open-read-close cycles
 * on Bun 1.4.4), while one stuck in native SQLite code may never finish (#5374).
 */
export const WORK_VIEW_READ_TERMINATE_TIMEOUT_MS = 2_000;

type Pending = { resolve(value: WorkViewReadResult): void; reject(error: Error): void; enqueuedAtNs: bigint; startedAtNs: bigint | null; purpose: WorkViewReadPurpose; pendingAtEnqueue: number; timer: ReturnType<typeof setTimeout> };

interface WorkViewReadWorkerHandle {
  postMessage(message: WorkViewReadRequest | { kind: 'invalidate-activity'; workState?: boolean }): void;
  on(event: 'message', listener: (response: WorkViewReadResponse) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  ref(): void;
  unref(): void;
  terminate(): Promise<number>;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === 'function') unref.call(timer);
}

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
 * a request whose write already landed. A read that gets no reply by the deadline retires the thread (its terminate()
 * is bounded, so a reader stuck in native SQLite code cannot block shutdown or the next read's replacement).
 */
export class WorkViewReadWorkerClient {
  private worker: WorkViewReadWorkerHandle | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private maxPendingCount = 0;
  private completedReads = 0;
  private failedReads = 0;
  private lastRead: WorkViewReadDiagnostic | null = null;
  private readonly requestTimeoutMs: number;
  private readonly terminateTimeoutMs: number;
  private readonly openWorker: () => WorkViewReadWorkerHandle;

  constructor(
    private readonly workerData: { databasePath: string; ledgerDir: string | null; pollIntervalMs: number; transcriptRoots?: { claudeProjectsDir?: string; codexHome?: string } },
    options: { requestTimeoutMs?: number; terminateTimeoutMs?: number; createWorker?: () => WorkViewReadWorkerHandle } = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? WORK_VIEW_READ_REQUEST_TIMEOUT_MS;
    this.terminateTimeoutMs = options.terminateTimeoutMs ?? WORK_VIEW_READ_TERMINATE_TIMEOUT_MS;
    this.openWorker = options.createWorker ?? (() => createWorkViewReadWorker(this.workerData));
  }

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
    let worker: WorkViewReadWorkerHandle;
    try { worker = this.getWorker(); }
    catch (error) { return Promise.reject(error); }
    const id = ++this.nextId;
    const enqueuedAtNs = process.hrtime.bigint();
    const safePurpose = WORK_VIEW_READ_PURPOSES.includes(purpose) ? purpose : 'snapshot';
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        resolve, reject, enqueuedAtNs, startedAtNs: null, purpose: safePurpose, pendingAtEnqueue: this.pending.size,
        timer: setTimeout(() => {
          if (this.pending.get(id) !== pending) return;
          this.retireWorker(worker, new Error(`Work view reader timed out after ${this.requestTimeoutMs}ms`));
        }, this.requestTimeoutMs),
      };
      unrefTimer(pending.timer);
      this.pending.set(id, pending);
      this.maxPendingCount = Math.max(this.maxPendingCount, this.pending.size);
      worker.ref();
      try { worker.postMessage({ id, maxActivityAgeMs, localDeviceId, kind } satisfies WorkViewReadRequest); }
      catch (error) {
        clearTimeout(pending.timer);
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
    if (!worker) return;
    worker.unref();
    await this.boundedTerminate(worker);
  }

  private getWorker(): WorkViewReadWorkerHandle {
    if (this.closed) throw new Error('Work view reader closed');
    if (this.worker) return this.worker;
    const worker = this.openWorker();
    this.worker = worker;
    worker.on('message', (response: WorkViewReadResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      if ('started' in response) {
        pending.startedAtNs ??= process.hrtime.bigint();
        return;
      }
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      this.recordRead(pending, response.ok && response.result.agentView.source.connected === true, response.timing);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(Object.assign(new Error(response.error.message), { name: response.error.name }));
      if (!this.pending.size) worker.unref();
    });
    worker.on('error', error => this.failWorker(worker, error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', code => this.failWorker(worker, new Error(`Work view reader exited with code ${code}`)));
    return worker;
  }

  private failWorker(worker: WorkViewReadWorkerHandle, error: Error): void {
    this.detachWorker(worker, error);
  }

  /** Deadline retirement: drop the hung thread and stop waiting for its terminate(). A later read opens a replacement. */
  private retireWorker(worker: WorkViewReadWorkerHandle, error: Error): void {
    if (!this.detachWorker(worker, error)) return;
    worker.unref();
    void this.boundedTerminate(worker);
  }

  /** Drop this thread from the client. */
  private detachWorker(worker: WorkViewReadWorkerHandle, error: Error): boolean {
    if (this.worker !== worker) return false;
    this.worker = null;
    this.rejectPending(error);
    return true;
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      this.recordRead(entry, false);
      entry.reject(error);
    }
  }

  private boundedTerminate(worker: WorkViewReadWorkerHandle): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, this.terminateTimeoutMs);
      unrefTimer(timer);
    });
    let terminated: Promise<void>;
    try {
      terminated = Promise.resolve(worker.terminate()).then(() => undefined, () => undefined);
    } catch {
      terminated = Promise.resolve();
    }
    return Promise.race([terminated, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
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
