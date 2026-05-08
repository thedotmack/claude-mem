// SPDX-License-Identifier: Apache-2.0

import {
  Queue,
  QueueEvents,
  Worker,
  type Job,
  type JobsOptions,
  type Processor,
  type QueueEventsOptions,
  type QueueOptions,
  type WorkerOptions
} from 'bullmq';
import { logger } from '../../utils/logger.js';
import type { RedisQueueConfig } from '../queue/redis-config.js';

// BullMQ Worker docs: https://docs.bullmq.io/guide/workers
// BullMQ Concurrency:  https://docs.bullmq.io/guide/workers/concurrency
// BullMQ Stalled Jobs: https://docs.bullmq.io/guide/jobs/stalled
//
// ServerJobQueue is a thin wrapper around the BullMQ Queue + Worker pair for
// one named queue. It enforces:
//   - autorun: false on every Worker (start() is called explicitly)
//   - default concurrency: 1 (per-kind concurrency tuning happens later)
//   - an attached `error` listener on every Worker (BullMQ docs require this
//     to avoid unhandled-error crashes when a job throws)
// Postgres outbox is canonical history; BullMQ is the execution transport
// only. Do not treat completed/failed Worker state as authoritative.

export interface ServerJobCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

// Phase 12 — runtime stalled counter. BullMQ doesn't expose a stalled counter
// from getJobCounts (the underlying list is rotated on consumption). We keep
// a per-process counter that tracks how many distinct stalled events we've
// observed since startup. /api/health and /v1/info surface this.
export interface ServerJobLifecycleCounters {
  stalled: number;
  errored: number;
}

export interface ServerJobObservedListener {
  onCompleted?: (jobId: string, durationMs: number, returnvalue: unknown) => void;
  onFailed?: (jobId: string | undefined, attemptsMade: number, reason: string) => void;
  onStalled?: (jobId: string) => void;
  onError?: (error: unknown) => void;
}

export interface ServerJobQueueOptions<TPayload> {
  name: string;
  config: RedisQueueConfig;
  concurrency?: number;
  lockDurationMs?: number;
  defaultJobOptions?: JobsOptions;
  // Test seams: allow injecting fakes without touching Redis.
  queueFactory?: (name: string, options: QueueOptions) => Pick<
    Queue<TPayload>,
    'add' | 'getJob' | 'getJobCounts' | 'remove' | 'close'
  >;
  workerFactory?: (
    name: string,
    processor: Processor<TPayload> | null,
    options: WorkerOptions
  ) => Pick<Worker<TPayload>, 'on' | 'run' | 'close'>;
}

const DEFAULT_LOCK_DURATION_MS = 5 * 60 * 1000;

export class ServerJobQueue<TPayload extends object = object> {
  readonly name: string;
  private readonly config: RedisQueueConfig;
  private readonly concurrency: number;
  private readonly lockDurationMs: number;
  private readonly defaultJobOptions: JobsOptions;
  private readonly queueFactory?: ServerJobQueueOptions<TPayload>['queueFactory'];
  private readonly workerFactory?: ServerJobQueueOptions<TPayload>['workerFactory'];
  private queue: ReturnType<NonNullable<ServerJobQueueOptions<TPayload>['queueFactory']>> | Queue<TPayload> | null = null;
  private worker: ReturnType<NonNullable<ServerJobQueueOptions<TPayload>['workerFactory']>> | Worker<TPayload> | null = null;
  private queueEvents: QueueEvents | null = null;
  private started = false;
  private readonly counters: ServerJobLifecycleCounters = { stalled: 0, errored: 0 };
  private readonly listeners: ServerJobObservedListener[] = [];
  private readonly jobStartTimes = new Map<string, number>();
  // worker.on('stalled') and the QueueEvents 'stalled' subscriber both fire
  // for the same job — BullMQ's docs explicitly recommend listening on both
  // for production reliability. To avoid double-counting and double-callback
  // we record each stalled jobId here for a short TTL and treat the second
  // signal as an idempotent no-op.
  private readonly recentlyStalled = new Map<string, NodeJS.Timeout>();
  private static readonly STALLED_DEDUPE_WINDOW_MS = 30_000;

  constructor(options: ServerJobQueueOptions<TPayload>) {
    this.name = options.name;
    this.config = options.config;
    this.concurrency = options.concurrency ?? 1;
    this.lockDurationMs = options.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS;
    this.defaultJobOptions = options.defaultJobOptions ?? {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
      removeOnFail: { age: 30 * 24 * 60 * 60, count: 1000 }
    };
    this.queueFactory = options.queueFactory;
    this.workerFactory = options.workerFactory;
  }

  private getQueue(): NonNullable<typeof this.queue> {
    if (this.queue) {
      return this.queue;
    }
    const queueOptions: QueueOptions = {
      connection: this.config.connection,
      prefix: this.config.prefix,
      defaultJobOptions: this.defaultJobOptions
    };
    this.queue = this.queueFactory
      ? this.queueFactory(this.name, queueOptions)
      : new Queue<TPayload>(this.name, queueOptions);
    return this.queue;
  }

  async add(jobId: string, payload: TPayload, options?: JobsOptions): Promise<void> {
    if (jobId.includes(':')) {
      throw new Error(`server job ID must not contain ':' (got ${jobId})`);
    }
    try {
      await (this.getQueue().add as (
        name: string,
        data: TPayload,
        opts?: JobsOptions
      ) => Promise<unknown>)(this.name, payload, {
        ...this.defaultJobOptions,
        ...options,
        jobId
      });
    } catch (error) {
      throw this.toRedisUnavailableError(error);
    }
  }

  async getJob(jobId: string): Promise<Job<TPayload> | null | undefined> {
    try {
      return (await this.getQueue().getJob(jobId)) as Job<TPayload> | null | undefined;
    } catch (error) {
      throw this.toRedisUnavailableError(error);
    }
  }

  async remove(jobId: string): Promise<void> {
    try {
      await this.getQueue().remove(jobId);
    } catch (error) {
      throw this.toRedisUnavailableError(error);
    }
  }

  async getCounts(): Promise<ServerJobCounts> {
    try {
      const counts = await this.getQueue().getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'completed'
      );
      return {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0
      };
    } catch (error) {
      throw this.toRedisUnavailableError(error);
    }
  }

  // BullMQ docs require `worker.on('error', ...)` to avoid unhandled rejections
  // when a job throws. We construct the Worker with autorun: false so the
  // caller controls startup explicitly via run().
  //
  // Phase 12 — wire `completed`, `failed`, `progress`, `error`, and the
  // QueueEvents `stalled` listener. Stalled events go through QueueEvents
  // because BullMQ's docs note rare stalls don't always reach the local
  // worker.on('stalled') listener; QueueEvents publishes from Redis.
  // Deduped stalled handler. Counts the stall once even though BullMQ may
  // surface it via both worker.on('stalled') and QueueEvents 'stalled'.
  private notifyStalled(jobId: string, source: 'worker' | 'queue-events'): void {
    if (this.recentlyStalled.has(jobId)) {
      logger.debug?.('QUEUE', `[generation] job=${jobId} stalled (suppressed duplicate from ${source})`, {
        queue: this.name,
        jobId,
        source,
      });
      return;
    }
    const timer = setTimeout(() => {
      this.recentlyStalled.delete(jobId);
    }, ServerJobQueue.STALLED_DEDUPE_WINDOW_MS);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
    this.recentlyStalled.set(jobId, timer);
    this.counters.stalled += 1;
    logger.warn('QUEUE', `[generation] job=${jobId} stalled${source === 'queue-events' ? ' (queue-events)' : ''}`, {
      queue: this.name,
      jobId,
      source,
    });
    for (const l of this.listeners) {
      try { l.onStalled?.(jobId); } catch { /* listener errors must not propagate */ }
    }
  }

  // Single source of truth for queue-side error accounting. worker errors and
  // QueueEvents errors both increment counters.errored and notify listeners,
  // so per-process metrics aren't asymmetric across the two sources.
  private notifyQueueError(error: unknown, source: 'worker' | 'queue-events'): void {
    this.counters.errored += 1;
    logger.warn('QUEUE', `${this.name} ${source} error`, {
      error: error instanceof Error ? error.message : String(error),
    });
    for (const l of this.listeners) {
      try { l.onError?.(error); } catch { /* listener errors must not propagate */ }
    }
  }

  start(processor: Processor<TPayload>): void {
    if (this.started) {
      throw new Error(`ServerJobQueue ${this.name} is already started`);
    }
    const workerOptions: WorkerOptions = {
      connection: this.config.connection,
      prefix: this.config.prefix,
      autorun: false,
      concurrency: this.concurrency,
      lockDuration: this.lockDurationMs
    };
    const worker = this.workerFactory
      ? this.workerFactory(this.name, processor, workerOptions)
      : new Worker<TPayload>(this.name, processor, workerOptions);
    worker.on('error', (error: unknown) => this.notifyQueueError(error, 'worker'));
    // BullMQ Worker exposes `active`, `completed`, `failed`, `progress`, and
    // `stalled` events. We attach to all five because the runtime relies on
    // them for observability (Phase 12).
    if (typeof (worker as { on?: unknown }).on === 'function') {
      const w = worker as Worker<TPayload>;
      w.on('active', (job: Job<TPayload>) => {
        if (job.id) this.jobStartTimes.set(job.id, Date.now());
      });
      w.on('completed', (job: Job<TPayload>, returnvalue: unknown) => {
        const startedAt = job.id ? this.jobStartTimes.get(job.id) : undefined;
        const durationMs = startedAt ? Date.now() - startedAt : 0;
        if (job.id) this.jobStartTimes.delete(job.id);
        const sourceType = (job.data as { source_type?: string } | undefined)?.source_type ?? '?';
        logger.info('QUEUE', `[generation] job=${job.id ?? '?'} source_type=${sourceType} duration=${durationMs}ms`, {
          queue: this.name,
          jobId: job.id ?? null,
          sourceType,
          durationMs,
        });
        for (const l of this.listeners) {
          try { l.onCompleted?.(job.id ?? '?', durationMs, returnvalue); } catch { /* swallow listener errors only */ }
        }
      });
      w.on('failed', (job: Job<TPayload> | undefined, error: Error) => {
        if (job?.id) this.jobStartTimes.delete(job.id);
        const sourceType = (job?.data as { source_type?: string } | undefined)?.source_type ?? '?';
        const attemptsMade = job?.attemptsMade ?? 0;
        logger.warn('QUEUE', `[generation] job=${job?.id ?? '?'} source_type=${sourceType} attempts=${attemptsMade} reason=${error.message}`, {
          queue: this.name,
          jobId: job?.id ?? null,
          sourceType,
          attemptsMade,
          reason: error.message,
        });
        for (const l of this.listeners) {
          try { l.onFailed?.(job?.id, attemptsMade, error.message); } catch { /* swallow */ }
        }
      });
      w.on('progress', (job: Job<TPayload>, progress: unknown) => {
        logger.debug?.('QUEUE', `[generation] job=${job.id ?? '?'} progress`, {
          queue: this.name,
          jobId: job.id ?? null,
          progress,
        });
      });
      w.on('stalled', (jobId: string) => this.notifyStalled(jobId, 'worker'));
    }
    worker.run();
    this.worker = worker;

    // QueueEvents subscribes to Redis pub/sub for cross-process events
    // (BullMQ "Stalled Jobs" docs recommend this for production reliability).
    // Skip in test/factory mode since the test factory does not provide a
    // real Redis connection.
    if (!this.workerFactory) {
      try {
        const events = new QueueEvents(this.name, {
          connection: this.config.connection,
          prefix: this.config.prefix,
        } as QueueEventsOptions);
        events.on('stalled', ({ jobId }: { jobId: string }) => this.notifyStalled(jobId, 'queue-events'));
        // QueueEvents emits its own 'error' too — surface through the same
        // counter+listener path as worker errors so observability stays symmetric.
        events.on('error', (error: Error) => this.notifyQueueError(error, 'queue-events'));
        this.queueEvents = events;
      } catch (error) {
        logger.warn('QUEUE', `${this.name} failed to start QueueEvents listener`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.started = true;
  }

  /**
   * Phase 12 — register an observer for completed/failed/stalled/error
   * events. Used by the runtime to surface lifecycle hooks (audit, metrics)
   * without subclassing. Listeners that throw are isolated.
   */
  observe(listener: ServerJobObservedListener): void {
    this.listeners.push(listener);
  }

  /**
   * Phase 12 — runtime counters for stalled/errored events. waiting/active/
   * completed/failed/delayed live in `getCounts()` (BullMQ getJobCounts).
   * Stalled is a per-process counter because BullMQ rotates the underlying
   * list and there's no reliable count from getJobCounts.
   */
  getLifecycleCounters(): ServerJobLifecycleCounters {
    return { ...this.counters };
  }

  isStarted(): boolean {
    return this.started;
  }

  async close(): Promise<void> {
    const errors: Error[] = [];
    if (this.queueEvents) {
      try {
        await this.queueEvents.close();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      this.queueEvents = null;
    }
    if (this.worker) {
      try {
        await this.worker.close();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      this.worker = null;
      this.started = false;
    }
    if (this.queue) {
      try {
        await this.queue.close();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      this.queue = null;
    }
    for (const timer of this.recentlyStalled.values()) {
      clearTimeout(timer);
    }
    this.recentlyStalled.clear();
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  private toRedisUnavailableError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(
      `ServerJobQueue ${this.name} requires Redis/Valkey when CLAUDE_MEM_QUEUE_ENGINE=bullmq: ${message}`
    );
  }
}
