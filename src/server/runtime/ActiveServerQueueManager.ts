// SPDX-License-Identifier: Apache-2.0

import type { Processor } from 'bullmq';
import { ServerJobQueue } from '../jobs/ServerJobQueue.js';
import {
  SERVER_JOB_QUEUE_NAMES,
  type ServerGenerationJobKind,
  type ServerGenerationJobPayload,
} from '../jobs/types.js';
import type { RedisQueueConfig } from '../queue/redis-config.js';
import { logger } from '../../utils/logger.js';
import type {
  ServerBoundaryHealth,
  ServerQueueLaneMetric,
  ServerQueueManager,
} from './types.js';

// ActiveServerQueueManager owns one ServerJobQueue per generation kind.
// It is wired in only when CLAUDE_MEM_QUEUE_ENGINE=bullmq is set; otherwise
// create-server-service.ts keeps the disabled adapter in place.
//
// This boundary intentionally does not start any Worker processors here.
// Phase 4+ wires processors that consume the queues, calling
// `start(kind, processor)` once provider generation is ready. Until then,
// the queues exist as transports for `enqueueOutbox` to publish into.

const QUEUE_KINDS: ServerGenerationJobKind[] = ['event', 'summary'];

/**
 * How many generation jobs the server works in parallel.
 *
 * `ServerJobQueue` defaults to `concurrency: 1` and nothing has ever passed a
 * value, so generation is strictly serial however the deployment is configured —
 * the queue has carried the comment "per-kind concurrency tuning happens later"
 * since it was written, and this is that knob.
 *
 * Serial generation is invisible until the estate outruns it, and then it is
 * invisible in a second way: nothing fails. On one deployment the event lane
 * drained 9 observations/min against ~28/min arriving, so the backlog reached
 * 8,215 jobs in a single day and an observation was on average 5h02m old by the
 * time it existed. Every job completed. Every health check passed. The memory was
 * simply hours behind the work it described.
 *
 * Unset keeps 1, so behaviour is unchanged unless a deployment opts in.
 */
export function resolveServerGenerationConcurrency(): number | undefined {
  const raw = process.env.CLAUDE_MEM_SERVER_GENERATION_CONCURRENCY;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    logger.warn('SYSTEM', 'server: ignoring invalid CLAUDE_MEM_SERVER_GENERATION_CONCURRENCY', {
      value: raw,
    });
    return undefined;
  }
  return parsed;
}

export class ActiveServerQueueManager implements ServerQueueManager {
  readonly kind = 'queue-manager' as const;

  private readonly queues: Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>>;
  private closed = false;

  constructor(
    private readonly config: RedisQueueConfig,
    queues?: Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>>,
  ) {
    if (config.engine !== 'bullmq') {
      throw new Error(
        `ActiveServerQueueManager requires CLAUDE_MEM_QUEUE_ENGINE=bullmq (got ${config.engine}); ` +
          'do not instantiate when bullmq is not selected.',
      );
    }
    this.queues = queues ?? this.buildQueues(config);
  }

  getQueue(kind: ServerGenerationJobKind): ServerJobQueue<ServerGenerationJobPayload> {
    const queue = this.queues.get(kind);
    if (!queue) {
      throw new Error(`unknown server generation job kind: ${kind}`);
    }
    return queue;
  }

  start(kind: ServerGenerationJobKind, processor: Processor<ServerGenerationJobPayload>): void {
    this.getQueue(kind).start(processor);
  }

  getHealth(): ServerBoundaryHealth {
    if (this.closed) {
      return { status: 'errored', reason: 'queue-manager closed' };
    }
    const lanes = QUEUE_KINDS.map((kind) => ({ kind, name: SERVER_JOB_QUEUE_NAMES[kind] }));
    return {
      status: 'active',
      reason: 'BullMQ-backed queue manager wired',
      details: {
        engine: this.config.engine,
        mode: this.config.mode,
        host: this.config.host,
        port: this.config.port,
        prefix: this.config.prefix,
        lanes,
      },
    };
  }

  /**
   * Phase 12 — per-lane counts. Returns BullMQ getJobCounts plus the
   * per-process stalled counter. If Redis is unreachable, the lane is
   * reported with an `unavailable` flag rather than throwing so /api/health
   * remains responsive even in partial-failure modes.
   */
  async getLaneMetrics(): Promise<ServerQueueLaneMetric[]> {
    const out: ServerQueueLaneMetric[] = [];
    for (const kind of QUEUE_KINDS) {
      const queue = this.queues.get(kind);
      if (!queue) continue;
      const lifecycle = queue.getLifecycleCounters();
      try {
        out.push(await this.readLaneMetric(kind, queue, lifecycle.stalled));
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          'QUEUE',
          'failed to read lane counts; reporting lane as unavailable',
          { kind, name: SERVER_JOB_QUEUE_NAMES[kind] },
          err,
        );
        out.push({
          kind,
          name: SERVER_JOB_QUEUE_NAMES[kind],
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          stalled: lifecycle.stalled,
          unavailable: true,
          unavailableReason: err.message,
        });
      }
    }
    return out;
  }

  private async readLaneMetric(
    kind: ServerGenerationJobKind,
    queue: ServerJobQueue<ServerGenerationJobPayload>,
    stalled: number,
  ): Promise<ServerQueueLaneMetric> {
    const counts = await queue.getCounts();
    return {
      kind,
      name: SERVER_JOB_QUEUE_NAMES[kind],
      waiting: counts.waiting,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      delayed: counts.delayed,
      stalled,
      unavailable: false,
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const errors: Error[] = [];
    for (const queue of this.queues.values()) {
      try {
        await queue.close();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('QUEUE', 'error closing server job queue', {}, err);
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      logger.warn('QUEUE', 'errors closing server queue manager', {
        count: errors.length,
        first: errors[0]!.message,
      });
      throw errors[0];
    }
  }

  private buildQueues(
    config: RedisQueueConfig,
  ): Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>> {
    const map = new Map<ServerGenerationJobKind, ServerJobQueue<ServerGenerationJobPayload>>();
    const concurrency = resolveServerGenerationConcurrency();
    for (const kind of QUEUE_KINDS) {
      map.set(
        kind,
        new ServerJobQueue<ServerGenerationJobPayload>({
          name: SERVER_JOB_QUEUE_NAMES[kind],
          config,
          ...(concurrency !== undefined ? { concurrency } : {}),
        }),
      );
    }
    return map;
  }
}
