import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { ContextReadMethods, ContextReadReply, ContextReadRequest, ContextReadResult, ContextRenderRequest } from './ContextReadProtocol.js';
import type { WorkStateEntry } from '../sqlite/work-state.js';
import type { ObservationSearchResult, SearchOptions, SessionSummarySearchResult, UserPromptSearchResult } from '../sqlite/types.js';
import { CONTEXT_PLACEHOLDER_NONCE } from '../../shared/context-cache.js';

const MAX_PENDING_READS = 64;

type PendingRead = { resolve(value: unknown): void; reject(error: Error): void };

export class ContextReadWorkerClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, PendingRead>();
  private nextId = 0;
  private closed = false;

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
    if (worker) await worker.terminate();
  }

  private getWorker(): Worker {
    if (this.closed) throw new Error('Context reader closed');
    if (this.worker) return this.worker;
    const candidates = ['context-read-worker.ts', 'context-read-worker.cjs']
      .map(name => new URL(name, import.meta.url));
    // Standalone builds embed this entrypoint under its emitted JavaScript name.
    const entry = candidates.find(candidate => existsSync(candidate))
      ?? new URL('./context-read-worker.js', import.meta.url);
    const worker = new Worker(entry, { workerData: { contextPlaceholderNonce: CONTEXT_PLACEHOLDER_NONCE } });
    this.worker = worker;
    worker.on('message', (reply: ContextReadReply) => {
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
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

  private request<Method extends keyof ContextReadMethods>(
    method: Method,
    input: ContextReadMethods[Method]['input'],
  ): Promise<ContextReadMethods[Method]['result']> {
    if (this.pending.size >= MAX_PENDING_READS) return Promise.reject(new Error('Context reader queue is full'));
    const worker = this.getWorker();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as ContextReadMethods[Method]['result']), reject });
      worker.ref();
      try {
        worker.postMessage({ id, method, input } as ContextReadRequest);
      } catch (error) {
        this.pending.delete(id);
        if (this.pending.size === 0) worker.unref();
        reject(error);
      }
    });
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
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
