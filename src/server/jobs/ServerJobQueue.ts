// SPDX-License-Identifier: Apache-2.0

import {
  Queue,
  Worker,
  type Job,
  type JobsOptions,
  type Processor,
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
  private started = false;

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
    worker.on('error', (error: unknown) => {
      logger.warn('QUEUE', `${this.name} worker error`, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
    worker.run();
    this.worker = worker;
    this.started = true;
  }

  isStarted(): boolean {
    return this.started;
  }

  async close(): Promise<void> {
    const errors: Error[] = [];
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
