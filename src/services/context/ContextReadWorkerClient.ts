import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { ContextReadMethods, ContextReadReply, ContextReadRequest, ContextReadResult, ContextRenderRequest } from './ContextReadProtocol.js';
import type { WorkStateEntry } from '../sqlite/work-state.js';
import type { ObservationSearchResult, SearchOptions, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';
import { CONTEXT_PLACEHOLDER_NONCE } from '../../shared/context-cache.js';

const MAX_PENDING_READS = 64;

/**
 * A read with no reply by this deadline is a hung context reader (#5374).
 * Cold keyword search has been measured around 42s (#4938) and SQLite busy
 * waits are 5s, so the budget sits above both. It is still short enough that
 * one stuck thread cannot stall every observer session that shares it.
 */
export const CONTEXT_READ_REQUEST_TIMEOUT_MS = 120_000;

/** close() and hung-reader retirement stop waiting for terminate() after this. */
export const CONTEXT_READ_TERMINATE_TIMEOUT_MS = 2_000;

type PendingRead = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

interface ContextReadWorkerHandle {
  postMessage(message: ContextReadRequest): void;
  on(event: 'message', listener: (reply: ContextReadReply) => void): void;
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

export class ContextReadWorkerClient {
  private worker: ContextReadWorkerHandle | null = null;
  private readonly pending = new Map<number, PendingRead>();
  private nextId = 0;
  private closed = false;
  private readonly requestTimeoutMs: number;
  private readonly terminateTimeoutMs: number;
  private readonly openWorker: () => ContextReadWorkerHandle;

  constructor(options: {
    requestTimeoutMs?: number;
    terminateTimeoutMs?: number;
    createWorker?: () => ContextReadWorkerHandle;
  } = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? CONTEXT_READ_REQUEST_TIMEOUT_MS;
    this.terminateTimeoutMs = options.terminateTimeoutMs ?? CONTEXT_READ_TERMINATE_TIMEOUT_MS;
    this.openWorker = options.createWorker ?? (() => this.spawnWorker());
  }

  async render(request: ContextRenderRequest): Promise<ContextReadResult> {
    return this.request('render', request);
  }

  async readKeys(projects: string[]): Promise<string[]> {
    return this.request('readKeys', { projects });
  }

  async workState(projects: string[], localDeviceId = ''): Promise<WorkStateEntry[]> {
    return this.request('workState', { projects, localDeviceId });
  }

  async hasObservations(projects: string[], platformSource?: string): Promise<boolean> {
    return this.request('hasObservations', { projects, platformSource });
  }

  async projectsForCwd(cwd: string): Promise<string[]> {
    return this.request('projectsForCwd', { cwd });
  }

  async searchObservations(query: string | undefined, options: SearchOptions): Promise<ObservationSearchResult[]> {
    return this.request('searchObservations', { query, options });
  }

  async searchSessions(query: string | undefined, options: SearchOptions): Promise<SessionSummarySearchResult[]> {
    return this.request('searchSessions', { query, options });
  }

  async searchUserPrompts(query: string | undefined, options: SearchOptions): Promise<UserPromptSearchResult[]> {
    return this.request('searchUserPrompts', { query, options });
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    this.rejectPending(new Error('Context reader closed'));
    if (!worker) return;
    worker.unref();
    await this.boundedTerminate(worker);
  }

  private getWorker(): ContextReadWorkerHandle {
    if (this.closed) throw new Error('Context reader closed');
    if (this.worker) return this.worker;
    const worker = this.openWorker();
    this.worker = worker;
    worker.on('message', (reply: ContextReadReply) => {
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
      if (reply.ok) request.resolve(reply.result);
      else request.reject(Object.assign(new Error(reply.error.message), { name: reply.error.name }));
      if (this.pending.size === 0) worker.unref();
    });
    worker.on('error', error => {
      this.failWorker(worker, error instanceof Error ? error : new Error(String(error)));
    });
    worker.on('exit', code => this.failWorker(worker, new Error(`Context reader exited with code ${code}`)));
    return worker;
  }

  private spawnWorker(): ContextReadWorkerHandle {
    const candidates = ['context-read-worker.ts', 'context-read-worker.cjs']
      .map(name => new URL(name, import.meta.url));
    // Standalone builds embed this entrypoint under its emitted JavaScript name.
    const entry = candidates.find(candidate => existsSync(candidate))
      ?? new URL('./context-read-worker.js', import.meta.url);
    return new Worker(entry, { workerData: { contextPlaceholderNonce: CONTEXT_PLACEHOLDER_NONCE } });
  }

  private request<Method extends keyof ContextReadMethods>(
    method: Method,
    input: ContextReadMethods[Method]['input'],
  ): Promise<ContextReadMethods[Method]['result']> {
    if (this.pending.size >= MAX_PENDING_READS) return Promise.reject(new Error('Context reader queue is full'));
    const worker = this.getWorker();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const pending: PendingRead = {
        resolve: value => resolve(value as ContextReadMethods[Method]['result']),
        reject,
        timer: setTimeout(() => {
          if (this.pending.get(id) !== pending) return;
          this.retireWorker(worker, new Error(`Context reader timed out after ${this.requestTimeoutMs}ms`));
        }, this.requestTimeoutMs),
      };
      unrefTimer(pending.timer);
      this.pending.set(id, pending);
      worker.ref();
      try {
        worker.postMessage({ id, method, input } as ContextReadRequest);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (this.pending.size === 0) worker.unref();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private failWorker(worker: ContextReadWorkerHandle, error: Error): void {
    this.detachWorker(worker, error);
  }

  private retireWorker(worker: ContextReadWorkerHandle, error: Error): void {
    if (!this.detachWorker(worker, error)) return;
    worker.unref();
    void this.boundedTerminate(worker);
  }

  /** Drop this thread from the client. A later read opens a replacement. */
  private detachWorker(worker: ContextReadWorkerHandle, error: Error): boolean {
    if (this.worker !== worker) return false;
    this.worker = null;
    this.rejectPending(error);
    return true;
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private boundedTerminate(worker: ContextReadWorkerHandle): Promise<void> {
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
}

const readerState: { client?: ContextReadWorkerClient } = {};

export function getContextReadWorker(): ContextReadWorkerClient {
  readerState.client ??= new ContextReadWorkerClient();
  return readerState.client;
}

export async function closeContextReadWorker(): Promise<void> {
  await readerState.client?.close();
}
