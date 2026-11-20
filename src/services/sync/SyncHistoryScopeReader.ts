import type { Worker } from 'node:worker_threads';
import { createWorkViewReadWorker } from '../work-view/WorkViewReadWorkerClient.js';

/** Low-frequency inventory has its own worker so it cannot block HTTP or projection reads. */
export class SyncHistoryScopeReader {
  private worker: Worker | null = null;
  private pending: { resolve(value: number | null): void } | null = null;
  private closed = false;

  constructor(private readonly databasePath: string) {}

  read(): Promise<number | null> {
    if (this.closed || !this.databasePath || this.databasePath === ':memory:') return Promise.resolve(null);
    if (this.pending) throw new Error('Historical inventory already running');
    return new Promise(resolve => {
      this.pending = { resolve };
      try {
        const worker = this.worker ?? createWorkViewReadWorker({ kind: 'sync-history-scope', databasePath: this.databasePath });
        if (!this.worker) {
          this.worker = worker;
          worker.on('message', (count: unknown) => {
            if (this.worker !== worker) return;
            this.settle(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null);
            worker.unref();
          });
          worker.on('error', () => this.failed(worker));
          worker.on('exit', () => this.failed(worker));
        }
        worker.ref();
        worker.postMessage('read');
      } catch { this.settle(null); }
    });
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

  private settle(value: number | null): void {
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(value);
  }
}
