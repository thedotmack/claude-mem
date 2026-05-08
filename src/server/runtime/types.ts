// SPDX-License-Identifier: Apache-2.0

import type { PostgresPool, PostgresStorageRepositories } from '../../storage/postgres/index.js';

export type ServerBetaRuntimeName = 'server-beta';
export type ServerBetaAuthMode = 'api-key' | 'local-dev' | 'disabled';
export type DisabledBoundaryStatus = 'disabled';
export type ServerBetaBoundaryStatus = 'disabled' | 'active' | 'errored';

export interface ServerBetaBootstrapStatus {
  initialized: boolean;
  schemaVersion: number | null;
  appliedAt: string | null;
  error?: string;
}

export interface ServerBetaBoundaryHealth {
  status: ServerBetaBoundaryStatus;
  reason: string;
  details?: Record<string, unknown>;
}

// Phase 12 — per-lane queue metric snapshot. Returned by
// ActiveServerBetaQueueManager.getLaneMetrics so /api/health and /v1/info
// can publish current waiting/active/completed/failed/delayed/stalled counts
// for each generation lane. `unavailable` is set when Redis was unreachable
// at sample time so /api/health still responds rather than 500'ing.
export interface ServerBetaQueueLaneMetric {
  kind: string;
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  stalled: number;
  unavailable: boolean;
  unavailableReason?: string;
}

export interface ServerBetaQueueManager {
  readonly kind: 'queue-manager';
  getHealth(): ServerBetaBoundaryHealth;
  close(): Promise<void>;
}

export interface ServerBetaGenerationWorkerManager {
  readonly kind: 'generation-worker-manager';
  getHealth(): ServerBetaBoundaryHealth;
  close(): Promise<void>;
}

export interface ServerBetaProviderRegistry {
  readonly kind: 'provider-registry';
  getHealth(): ServerBetaBoundaryHealth;
  close(): Promise<void>;
}

export interface ServerBetaEventBroadcaster {
  readonly kind: 'event-broadcaster';
  getHealth(): ServerBetaBoundaryHealth;
  close(): Promise<void>;
}

export interface ServerBetaServiceGraph {
  runtime: ServerBetaRuntimeName;
  postgres: {
    pool: PostgresPool;
    bootstrap: ServerBetaBootstrapStatus;
  };
  authMode: ServerBetaAuthMode;
  queueManager: ServerBetaQueueManager;
  generationWorkerManager: ServerBetaGenerationWorkerManager;
  providerRegistry: ServerBetaProviderRegistry;
  eventBroadcaster: ServerBetaEventBroadcaster;
  storage: PostgresStorageRepositories;
}

abstract class DisabledServerBetaBoundary {
  abstract readonly kind: ServerBetaQueueManager['kind']
    | ServerBetaGenerationWorkerManager['kind']
    | ServerBetaProviderRegistry['kind']
    | ServerBetaEventBroadcaster['kind'];

  constructor(private readonly reason: string) {}

  getHealth(): ServerBetaBoundaryHealth {
    return { status: 'disabled' as const, reason: this.reason };
  }

  async close(): Promise<void> {}
}

export class DisabledServerBetaQueueManager extends DisabledServerBetaBoundary implements ServerBetaQueueManager {
  readonly kind = 'queue-manager' as const;
}

export class DisabledServerBetaGenerationWorkerManager extends DisabledServerBetaBoundary implements ServerBetaGenerationWorkerManager {
  readonly kind = 'generation-worker-manager' as const;
}

export class DisabledServerBetaProviderRegistry extends DisabledServerBetaBoundary implements ServerBetaProviderRegistry {
  readonly kind = 'provider-registry' as const;
}

export class DisabledServerBetaEventBroadcaster extends DisabledServerBetaBoundary implements ServerBetaEventBroadcaster {
  readonly kind = 'event-broadcaster' as const;
}
