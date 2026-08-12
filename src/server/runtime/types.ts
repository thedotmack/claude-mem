// SPDX-License-Identifier: Apache-2.0

import type { PostgresPool } from '../../storage/postgres/index.js';

export type ServerRuntimeName = 'server-beta';
export type ServerAuthMode = 'api-key' | 'local-dev' | 'disabled';
export type DisabledBoundaryStatus = 'disabled';
export type ServerBoundaryStatus = 'disabled' | 'active' | 'errored';

export interface ServerBootstrapStatus {
  initialized: boolean;
  schemaVersion: number | null;
  appliedAt: string | null;
  error?: string;
}

export interface ServerBoundaryHealth {
  status: ServerBoundaryStatus;
  reason: string;
  details?: Record<string, unknown>;
}

export interface ServerQueueManager {
  readonly kind: 'queue-manager';
  getHealth(): ServerBoundaryHealth;
  close(): Promise<void>;
}

export interface ServerGenerationWorkerManager {
  readonly kind: 'generation-worker-manager';
  getHealth(): ServerBoundaryHealth;
  close(): Promise<void>;
}

export interface ServerServiceGraph {
  runtime: ServerRuntimeName;
  postgres: {
    pool: PostgresPool;
    bootstrap: ServerBootstrapStatus;
  };
  authMode: ServerAuthMode;
  queueManager: ServerQueueManager;
  generationWorkerManager: ServerGenerationWorkerManager;
}

abstract class DisabledServerBoundary {
  abstract readonly kind: ServerQueueManager['kind']
    | ServerGenerationWorkerManager['kind'];

  constructor(private readonly reason: string) {}

  getHealth(): ServerBoundaryHealth {
    return { status: 'disabled' as const, reason: this.reason };
  }

  async close(): Promise<void> {}
}

export class DisabledServerQueueManager extends DisabledServerBoundary implements ServerQueueManager {
  readonly kind = 'queue-manager' as const;
}

export class DisabledServerGenerationWorkerManager extends DisabledServerBoundary implements ServerGenerationWorkerManager {
  readonly kind = 'generation-worker-manager' as const;
}
