import { CodexAppServerClient, type CodexAppServerTurnOptions, type CodexAppServerTurnResult } from './CodexAppServerClient.js';
import { logger } from '../../utils/logger.js';

export function boundedInteger(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= max ? number : fallback;
}

type Client = Pick<CodexAppServerClient, 'runTurn' | 'close'>;
type TurnClient = Pick<Client, 'runTurn'>;
interface Job {
  signal?: AbortSignal;
  run: (client: TurnClient, signal: AbortSignal) => Promise<void>;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

/** FIFO admission; a client belongs exclusively to one request until cleanup finishes. */
export class CodexAppServerPool {
  private readonly clients: Client[];
  private readonly idle: Client[];
  private readonly queue: Job[] = [];
  private closed = false;
  private closePromise?: Promise<void>;
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<void>>();

  constructor(size = 2, factory: () => Client = () => new CodexAppServerClient()) {
    this.clients = Array.from({ length: boundedInteger(size, 2, 8) }, factory);
    this.idle = [...this.clients];
    logger.debug('SDK', 'App-server pool initialized', { concurrency: this.clients.length });
  }

  runTurn(options: CodexAppServerTurnOptions): Promise<CodexAppServerTurnResult> {
    return this.withClient((client, signal) => client.runTurn({ ...options, signal }), options.signal);
  }

  /** Start an operation only after admission, keeping queued cancellation separate from execution deadlines. */
  withClient<T>(run: (client: TurnClient, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex app-server pool closed'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(job);
        if (index < 0) return;
        this.queue.splice(index, 1);
        job.cleanup();
        reject(signal!.reason);
      };
      const job: Job = { signal, reject,
        run: async (client, admittedSignal) => { resolve(await run(client, admittedSignal)); },
        cleanup: () => signal?.removeEventListener('abort', abort) };
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }

  private drain(): void {
    while (!this.closed && this.idle.length && this.queue.length) {
      const client = this.idle.shift()!;
      const job = this.queue.shift()!;
      job.cleanup();
      const signal = job.signal
        ? AbortSignal.any([job.signal, this.shutdown.signal]) : this.shutdown.signal;
      const work = Promise.resolve().then(() => {
        signal.throwIfAborted();
        return job.run(client, signal);
      }).catch(job.reject).finally(() => {
        this.active.delete(work);
        this.idle.push(client);
        this.drain();
      });
      this.active.add(work);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    logger.debug('SDK', 'Closing app-server pool', { active: this.active.size, queued: this.queue.length });
    this.shutdown.abort(new Error('Codex app-server pool closed'));
    for (const job of this.queue.splice(0)) {
      job.cleanup();
      job.reject(this.shutdown.signal.reason);
    }
    this.closePromise = (async () => {
      const results = await Promise.allSettled(this.clients.map(client => client.close()));
      await Promise.allSettled([...this.active]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return this.closePromise;
  }
}
