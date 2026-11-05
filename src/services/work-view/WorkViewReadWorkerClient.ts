import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { WorkViewReadRequest, WorkViewReadResponse, WorkViewReadResult } from './WorkViewReadProtocol.js';

type Pending = { resolve(value: WorkViewReadResult): void; reject(error: Error): void };

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

  constructor(private readonly workerData: { databasePath: string; ledgerDir: string | null; pollIntervalMs: number }) {}

  read(maxActivityAgeMs: number, localDeviceId: string): Promise<WorkViewReadResult> {
    let worker: Worker;
    try { worker = this.getWorker(); }
    catch (error) { return Promise.reject(error); }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.ref();
      try { worker.postMessage({ id, maxActivityAgeMs, localDeviceId } satisfies WorkViewReadRequest); }
      catch (error) {
        this.pending.delete(id);
        if (!this.pending.size) worker.unref();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
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
    const candidates = ['work-view-read-worker.ts', 'work-view-read-worker.cjs'].map(name => new URL(name, import.meta.url));
    const entry = candidates.find(candidate => existsSync(candidate)) ?? new URL('./work-view-read-worker.js', import.meta.url);
    const worker = new Worker(entry, { workerData: this.workerData });
    this.worker = worker;
    worker.on('message', (response: WorkViewReadResponse) => {
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
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
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
