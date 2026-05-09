// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { Queue, Worker, type Job, type JobType, type QueueOptions, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { PendingMessage, PendingMessageWithId } from '../../services/worker-types.js';
import type { CreateIteratorOptions } from '../../services/queue/SessionQueueProcessor.js';
import { logger } from '../../utils/logger.js';
import type {
  HealthCheckedObservationQueueEngine,
  ObservationQueueHealth,
  ObservationQueueInspection,
} from './ObservationQueueEngine.js';
import { getRedisQueueConfig, type RedisQueueConfig } from './redis-config.js';

interface BullMqPendingPayload {
  sessionDbId: number;
  contentSessionId: string;
  createdAtEpoch: number;
  message: PendingMessage;
}

type BullMqJob = Pick<
  Job<BullMqPendingPayload>,
  'id' | 'data' | 'moveToCompleted' | 'moveToWait' | 'extendLock' | 'getState'
  | 'remove'
>;

type BullMqQueue = Pick<
  Queue<BullMqPendingPayload>,
  'add' | 'getJob' | 'getJobCounts' | 'getJobs' | 'obliterate' | 'close'
>;

type BullMqWorker = Pick<Worker<BullMqPendingPayload>, 'getNextJob' | 'close'>;

interface RedisHealthClient {
  status: string;
  connect(): Promise<void>;
  ping(): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export interface BullMqObservationQueueEngineOptions {
  config?: RedisQueueConfig;
  queueFactory?: (name: string, options: QueueOptions) => BullMqQueue;
  workerFactory?: (name: string, options: WorkerOptions) => BullMqWorker;
  redisFactory?: (config: RedisQueueConfig) => RedisHealthClient;
  onMutate?: () => void;
  lockDurationMs?: number;
  pollIntervalMs?: number;
}

interface SessionRuntime {
  queue: BullMqQueue;
  worker: BullMqWorker;
  events: EventEmitter;
}

interface ClaimedJob {
  sessionDbId: number;
  job: BullMqJob;
  token: string;
  lockTimer: ReturnType<typeof setInterval> | null;
}

const QUEUE_JOB_TYPES: JobType[] = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'];
const DEFAULT_LOCK_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 250;

export class BullMqObservationQueueEngine
  implements HealthCheckedObservationQueueEngine, ObservationQueueInspection {
  private readonly config: RedisQueueConfig;
  private readonly sessions = new Map<number, SessionRuntime>();
  private readonly activeClaims = new Map<number, ClaimedJob>();
  private readonly lockDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly registryKey: string;
  private nextClaimId = 1;
  private nextEnqueueId = 1;
  private healthClient: RedisHealthClient | null = null;

  constructor(private readonly options: BullMqObservationQueueEngineOptions = {}) {
    this.config = options.config ?? getRedisQueueConfig();
    this.lockDurationMs = options.lockDurationMs ?? DEFAULT_LOCK_DURATION_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.registryKey = `${this.config.prefix}:queue_registry:sessions`;
  }

  async enqueue(sessionDbId: number, contentSessionId: string, message: PendingMessage): Promise<number> {
    const runtime = this.getSessionRuntime(sessionDbId);
    await this.registerSession(sessionDbId);
    const createdAtEpoch = Date.now();
    const payload: BullMqPendingPayload = {
      sessionDbId,
      contentSessionId,
      createdAtEpoch,
      message,
    };
    const jobId = getSafeJobId(contentSessionId, message, createdAtEpoch);

    const existing = await runtime.queue.getJob(jobId);
    if (existing && !await this.isTerminal(existing)) {
      return 0;
    }
    if (existing) {
      try {
        await existing.remove();
      } catch (error) {
        throw this.toRedisUnavailableError(error);
      }
    }

    try {
      await runtime.queue.add(message.type, payload, {
        jobId,
        attempts: 1000000,
        removeOnComplete: true,
        removeOnFail: { age: 24 * 60 * 60, count: 1000 },
      });
    } catch (error) {
      throw this.toRedisUnavailableError(error);
    }

    runtime.events.emit('message');
    this.options.onMutate?.();
    return this.nextEnqueueId++;
  }

  async *createIterator(options: CreateIteratorOptions): AsyncIterableIterator<PendingMessageWithId> {
    const {
      sessionDbId,
      signal,
      onIdleTimeout,
      idleTimeoutMs = 3 * 60 * 1000,
    } = options;
    const runtime = this.getSessionRuntime(sessionDbId);
    let lastActivityTime = Date.now();

    while (!signal.aborted) {
      const token = this.createToken(sessionDbId);
      let job: BullMqJob | undefined;
      try {
        job = await runtime.worker.getNextJob(token, { block: false }) as BullMqJob | undefined;
      } catch (error) {
        throw this.toRedisUnavailableError(error);
      }

      if (job) {
        const claimId = this.nextClaimId++;
        this.activeClaims.set(claimId, {
          sessionDbId,
          job,
          token,
          lockTimer: this.startLockRenewal(job, token),
        });
        lastActivityTime = Date.now();
        this.options.onMutate?.();
        yield {
          ...job.data.message,
          _persistentId: claimId,
          _originalTimestamp: job.data.createdAtEpoch,
        };
        continue;
      }

      const received = await this.waitForMessage(runtime.events, signal, this.pollIntervalMs);
      if (received) {
        continue;
      }

      if (Date.now() - lastActivityTime >= idleTimeoutMs && !signal.aborted) {
        onIdleTimeout?.();
        return;
      }
    }
  }

  async confirmProcessed(messageId: number): Promise<number> {
    const claimed = this.activeClaims.get(messageId);
    if (!claimed) {
      return 0;
    }

    try {
      await claimed.job.moveToCompleted({ ok: true }, claimed.token, false);
    } catch (error) {
      throw this.toRedisUnavailableError(error);
    }
    this.finishClaim(messageId, claimed);
    await this.unregisterSessionIfEmpty(claimed.sessionDbId);
    this.options.onMutate?.();
    return 1;
  }

  async clearPendingForSession(sessionDbId: number): Promise<number> {
    const runtime = this.getSessionRuntime(sessionDbId);
    const count = await this.getPendingCount(sessionDbId);
    try {
      await runtime.queue.obliterate({ force: true });
    } catch (error) {
      throw this.toRedisUnavailableError(error);
    }
    for (const [claimId, claimed] of Array.from(this.activeClaims.entries())) {
      if (claimed.sessionDbId === sessionDbId) {
        this.finishClaim(claimId, claimed);
      }
    }
    await this.unregisterSessionIfEmpty(sessionDbId);
    if (count > 0) {
      runtime.events.emit('message');
      this.options.onMutate?.();
    }
    return count;
  }

  async resetProcessingToPending(sessionDbId: number): Promise<number> {
    let reset = 0;
    let resetError: Error | null = null;
    for (const [claimId, claimed] of Array.from(this.activeClaims.entries())) {
      if (claimed.sessionDbId !== sessionDbId) {
        continue;
      }
      try {
        await claimed.job.moveToWait(claimed.token);
      } catch (error) {
        const normalized = this.toRedisUnavailableError(error);
        resetError ??= normalized;
        logger.warn('QUEUE', 'BullMQ active claim reset failed', {
          sessionDbId,
          jobId: claimed.job.id,
          error: normalized.message,
        });
        continue;
      }
      this.finishClaim(claimId, claimed);
      reset++;
    }
    if (reset > 0) {
      this.getSessionRuntime(sessionDbId).events.emit('message');
      this.options.onMutate?.();
    }
    if (resetError) {
      throw resetError;
    }
    return reset;
  }

  async getPendingCount(sessionDbId: number): Promise<number> {
    const counts = await this.getSessionRuntime(sessionDbId).queue.getJobCounts(...QUEUE_JOB_TYPES);
    return sumCounts(counts);
  }

  async getTotalQueueDepth(): Promise<number> {
    let total = 0;
    const sessionIds = new Set<number>(this.sessions.keys());
    for (const sessionDbId of await this.getRegisteredSessionIds()) {
      sessionIds.add(sessionDbId);
    }
    for (const sessionDbId of sessionIds) {
      total += await this.getPendingCount(sessionDbId);
    }
    return total;
  }

  async peekPendingTypes(sessionDbId: number): Promise<Array<{ message_type: string; tool_name: string | null }>> {
    const jobs = await this.getSessionRuntime(sessionDbId).queue.getJobs(QUEUE_JOB_TYPES, 0, -1, true);
    return jobs.map(job => ({
      message_type: job.data.message.type,
      tool_name: job.data.message.tool_name ?? null,
    }));
  }

  async getHealth(): Promise<ObservationQueueHealth> {
    try {
      const client = this.getHealthClient();
      if (client.status === 'wait' || client.status === 'end') {
        await client.connect();
      }
      await client.ping();
      return {
        engine: 'bullmq',
        redis: {
          status: 'ok',
          mode: this.config.mode,
          host: this.config.host,
          port: this.config.port,
          prefix: this.config.prefix,
        },
      };
    } catch (error) {
      return {
        engine: 'bullmq',
        redis: {
          status: 'error',
          mode: this.config.mode,
          host: this.config.host,
          port: this.config.port,
          prefix: this.config.prefix,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  async assertHealthy(): Promise<void> {
    const health = await this.getHealth();
    if (health.redis.status !== 'ok') {
      throw new Error(
        `CLAUDE_MEM_QUEUE_ENGINE=bullmq requires Redis/Valkey at ${health.redis.host}:${health.redis.port}; ${health.redis.error ?? 'ping failed'}`
      );
    }
  }

  async close(): Promise<void> {
    let releaseError: Error | null = null;
    try {
      await this.releaseActiveClaimsToWait();
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error(String(error));
    } finally {
      for (const [claimId, claimed] of Array.from(this.activeClaims.entries())) {
        this.finishClaim(claimId, claimed);
      }
      for (const runtime of this.sessions.values()) {
        runtime.events.removeAllListeners();
        await runtime.worker.close().catch(error => {
          logger.warn('QUEUE', 'BullMQ worker close failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        await runtime.queue.close().catch(error => {
          logger.warn('QUEUE', 'BullMQ queue close failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      this.sessions.clear();
      if (this.healthClient) {
        await this.healthClient.quit().catch(() => this.healthClient?.disconnect());
        this.healthClient = null;
      }
    }

    if (releaseError) {
      throw releaseError;
    }
  }

  private getSessionRuntime(sessionDbId: number): SessionRuntime {
    const existing = this.sessions.get(sessionDbId);
    if (existing) {
      return existing;
    }

    const name = `claude_mem_session_${sessionDbId}`;
    const queueOptions: QueueOptions = {
      connection: this.config.connection,
      prefix: this.config.prefix,
    };
    const workerOptions: WorkerOptions = {
      connection: this.config.connection,
      prefix: this.config.prefix,
      autorun: false,
      concurrency: 1,
      lockDuration: this.lockDurationMs,
    };
    const runtime: SessionRuntime = {
      queue: this.options.queueFactory
        ? this.options.queueFactory(name, queueOptions)
        : new Queue<BullMqPendingPayload>(name, queueOptions),
      worker: this.options.workerFactory
        ? this.options.workerFactory(name, workerOptions)
        : new Worker<BullMqPendingPayload>(name, null, workerOptions),
      events: new EventEmitter(),
    };
    this.sessions.set(sessionDbId, runtime);
    return runtime;
  }

  private getHealthClient(): RedisHealthClient {
    if (!this.healthClient) {
      this.healthClient = this.options.redisFactory
        ? this.options.redisFactory(this.config)
        : new Redis(this.config.connection) as RedisHealthClient;
    }
    return this.healthClient;
  }

  private async registerSession(sessionDbId: number): Promise<void> {
    try {
      await this.getHealthClient().sadd(this.registryKey, String(sessionDbId));
    } catch (error) {
      throw this.toRedisUnavailableError(error);
    }
  }

  private async unregisterSessionIfEmpty(sessionDbId: number): Promise<void> {
    if (await this.getPendingCount(sessionDbId) > 0) {
      return;
    }
    try {
      await this.getHealthClient().srem(this.registryKey, String(sessionDbId));
    } catch (error) {
      throw this.toRedisUnavailableError(error);
    }
  }

  private async getRegisteredSessionIds(): Promise<number[]> {
    let rawSessionIds: string[];
    try {
      rawSessionIds = await this.getHealthClient().smembers(this.registryKey);
    } catch (error) {
      throw this.toRedisUnavailableError(error);
    }
    return rawSessionIds
      .map(raw => Number.parseInt(raw, 10))
      .filter(sessionDbId => Number.isInteger(sessionDbId) && sessionDbId > 0);
  }

  private async isTerminal(job: BullMqJob): Promise<boolean> {
    const state = await job.getState();
    return state === 'completed' || state === 'failed' || state === 'unknown';
  }

  private startLockRenewal(job: BullMqJob, token: string): ReturnType<typeof setInterval> | null {
    if (!job.extendLock) {
      return null;
    }
    const interval = setInterval(() => {
      job.extendLock(token, this.lockDurationMs).catch(error => {
        logger.warn('QUEUE', 'BullMQ job lock renewal failed', {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, Math.max(1000, Math.floor(this.lockDurationMs / 2)));
    return interval;
  }

  private finishClaim(claimId: number, claimed: ClaimedJob): void {
    if (claimed.lockTimer) {
      clearInterval(claimed.lockTimer);
    }
    this.activeClaims.delete(claimId);
  }

  private async releaseActiveClaimsToWait(): Promise<number> {
    let released = 0;
    let releaseError: Error | null = null;
    for (const [claimId, claimed] of Array.from(this.activeClaims.entries())) {
      try {
        await claimed.job.moveToWait(claimed.token);
      } catch (error) {
        const normalized = this.toRedisUnavailableError(error);
        releaseError ??= normalized;
        logger.warn('QUEUE', 'BullMQ active claim release failed during close', {
          sessionDbId: claimed.sessionDbId,
          jobId: claimed.job.id,
          error: normalized.message,
        });
        continue;
      }
      this.finishClaim(claimId, claimed);
      released++;
      this.sessions.get(claimed.sessionDbId)?.events.emit('message');
    }
    if (released > 0) {
      this.options.onMutate?.();
    }
    if (releaseError) {
      throw releaseError;
    }
    return released;
  }

  private waitForMessage(events: EventEmitter, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        events.off('message', onMessage);
        signal.removeEventListener('abort', onAbort);
      };
      const onMessage = () => {
        cleanup();
        resolve(true);
      };
      const onAbort = () => {
        cleanup();
        resolve(false);
      };
      timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      events.once('message', onMessage);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private createToken(sessionDbId: number): string {
    return `claude-mem-${process.pid}-${sessionDbId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private toRedisUnavailableError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`BullMQ queue operation failed; Redis/Valkey is required when CLAUDE_MEM_QUEUE_ENGINE=bullmq: ${message}`);
  }
}

export function getSafeJobId(contentSessionId: string, message: PendingMessage, createdAtEpoch: number): string {
  if (message.type === 'observation') {
    if (message.toolUseId) {
      return `obs_${sha256(`${contentSessionId}\0${message.toolUseId}`)}`;
    }
    return `obs_${sha256(`${contentSessionId}\0${createdAtEpoch}\0${stableMessageFingerprint(message)}`)}`;
  }
  return `sum_${sha256(`${contentSessionId}\0${createdAtEpoch}\0${message.type}`)}`;
}

function stableMessageFingerprint(message: PendingMessage): string {
  return JSON.stringify({
    type: message.type,
    tool_name: message.tool_name ?? null,
    tool_input: message.tool_input ?? null,
    tool_response: message.tool_response ?? null,
    cwd: message.cwd ?? null,
    prompt_number: message.prompt_number ?? null,
    agentId: message.agentId ?? null,
    agentType: message.agentType ?? null,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sumCounts(counts: Record<string, number>): number {
  return QUEUE_JOB_TYPES.reduce((sum, type) => sum + (counts[type] ?? 0), 0);
}
