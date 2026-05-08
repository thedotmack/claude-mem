// SPDX-License-Identifier: Apache-2.0

import { createPostgresStorageRepositories, getSharedPostgresPool, SERVER_BETA_POSTGRES_SCHEMA_VERSION } from '../../storage/postgres/index.js';
import { bootstrapServerBetaPostgresSchema } from '../../storage/postgres/schema.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { getRedisQueueConfig } from '../queue/redis-config.js';
import { ActiveServerBetaQueueManager } from './ActiveServerBetaQueueManager.js';
import { ActiveServerBetaGenerationWorkerManager } from './ActiveServerBetaGenerationWorkerManager.js';
import { ClaudeObservationProvider } from '../generation/providers/ClaudeObservationProvider.js';
import { GeminiObservationProvider } from '../generation/providers/GeminiObservationProvider.js';
import { OpenRouterObservationProvider } from '../generation/providers/OpenRouterObservationProvider.js';
import type { ServerGenerationProvider } from '../generation/providers/shared/types.js';
import { ServerBetaService } from './ServerBetaService.js';
import {
  DisabledServerBetaEventBroadcaster,
  DisabledServerBetaGenerationWorkerManager,
  DisabledServerBetaProviderRegistry,
  DisabledServerBetaQueueManager,
  type ServerBetaAuthMode,
  type ServerBetaBootstrapStatus,
  type ServerBetaGenerationWorkerManager,
  type ServerBetaQueueManager,
  type ServerBetaServiceGraph,
} from './types.js';

export interface CreateServerBetaServiceOptions {
  pool?: PostgresPool;
  authMode?: ServerBetaAuthMode;
  bootstrapSchema?: boolean;
  queueManager?: ServerBetaQueueManager;
  // Phase 5 seam: tests can inject a fake provider without env config.
  generationProvider?: ServerGenerationProvider;
  generationWorkerManager?: ServerBetaGenerationWorkerManager;
}

export async function createServerBetaService(
  options: CreateServerBetaServiceOptions = {},
): Promise<ServerBetaService> {
  const pool = options.pool ?? getSharedPostgresPool({ requireDatabaseUrl: true });
  const bootstrap = await initializePostgres(pool, options.bootstrapSchema ?? true);
  const queueManager = options.queueManager ?? buildQueueManager();
  const generationWorkerManager = options.generationWorkerManager
    ?? buildGenerationWorkerManager(pool, queueManager, options.generationProvider);
  const graph: ServerBetaServiceGraph = {
    runtime: 'server-beta',
    postgres: {
      pool,
      bootstrap,
    },
    authMode: options.authMode ?? parseAuthMode(process.env.CLAUDE_MEM_AUTH_MODE),
    queueManager,
    generationWorkerManager,
    providerRegistry: new DisabledServerBetaProviderRegistry('Phase 5 keeps the provider registry boundary as inert; per-call providers are owned by the generation worker manager.'),
    eventBroadcaster: new DisabledServerBetaEventBroadcaster('Phase 2 boundary only; SSE/event broadcasting is not wired.'),
    storage: createPostgresStorageRepositories(pool),
  };

  if (generationWorkerManager instanceof ActiveServerBetaGenerationWorkerManager) {
    generationWorkerManager.start();
  }

  return new ServerBetaService({ graph });
}

function buildGenerationWorkerManager(
  pool: PostgresPool,
  queueManager: ServerBetaQueueManager,
  injectedProvider?: ServerGenerationProvider,
): ServerBetaGenerationWorkerManager {
  if (!(queueManager instanceof ActiveServerBetaQueueManager)) {
    return new DisabledServerBetaGenerationWorkerManager(
      'queue manager is disabled; set CLAUDE_MEM_QUEUE_ENGINE=bullmq to enable provider generation.',
    );
  }
  const provider = injectedProvider ?? buildServerGenerationProviderFromEnv();
  if (!provider) {
    return new DisabledServerBetaGenerationWorkerManager(
      'no server generation provider configured; set CLAUDE_MEM_SERVER_PROVIDER and the matching API key to enable.',
    );
  }
  return new ActiveServerBetaGenerationWorkerManager({
    pool,
    queueManager,
    provider,
  });
}

function buildServerGenerationProviderFromEnv(): ServerGenerationProvider | null {
  const provider = (process.env.CLAUDE_MEM_SERVER_PROVIDER ?? '').trim().toLowerCase();
  if (!provider) return null;
  try {
    if (provider === 'claude' || provider === 'anthropic') {
      const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_MEM_ANTHROPIC_API_KEY ?? '';
      if (!apiKey) return null;
      const opts: { apiKey: string; model?: string } = { apiKey };
      if (process.env.CLAUDE_MEM_SERVER_MODEL) opts.model = process.env.CLAUDE_MEM_SERVER_MODEL;
      return new ClaudeObservationProvider(opts);
    }
    if (provider === 'gemini') {
      const apiKey = process.env.GEMINI_API_KEY ?? process.env.CLAUDE_MEM_GEMINI_API_KEY ?? '';
      if (!apiKey) return null;
      const opts: { apiKey: string; model?: string } = { apiKey };
      if (process.env.CLAUDE_MEM_SERVER_MODEL) opts.model = process.env.CLAUDE_MEM_SERVER_MODEL;
      return new GeminiObservationProvider(opts);
    }
    if (provider === 'openrouter') {
      const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.CLAUDE_MEM_OPENROUTER_API_KEY ?? '';
      if (!apiKey) return null;
      const opts: { apiKey: string; model?: string } = { apiKey };
      if (process.env.CLAUDE_MEM_SERVER_MODEL) opts.model = process.env.CLAUDE_MEM_SERVER_MODEL;
      return new OpenRouterObservationProvider(opts);
    }
  } catch {
    return null;
  }
  return null;
}

// Queue manager selection is fail-fast on misconfiguration. If the user
// explicitly opts into BullMQ via CLAUDE_MEM_QUEUE_ENGINE=bullmq we build
// the active manager; any error there throws so the runtime does not
// silently fall back to a disabled queue. Default behavior (sqlite engine
// or no opt-in) keeps the disabled boundary so worker-era runtimes stay
// compatible.
function buildQueueManager(): ServerBetaQueueManager {
  const config = getRedisQueueConfig();
  if (config.engine !== 'bullmq') {
    return new DisabledServerBetaQueueManager(
      `Queue engine is "${config.engine}"; set CLAUDE_MEM_QUEUE_ENGINE=bullmq to activate the server-beta queue manager.`,
    );
  }
  return new ActiveServerBetaQueueManager(config);
}

async function initializePostgres(pool: PostgresPool, bootstrapSchema: boolean): Promise<ServerBetaBootstrapStatus> {
  if (!bootstrapSchema) {
    return { initialized: false, schemaVersion: null, appliedAt: null };
  }

  await bootstrapServerBetaPostgresSchema(pool);
  const result = await pool.query(
    `
      SELECT version, applied_at
      FROM server_beta_schema_migrations
      WHERE version = $1
    `,
    [SERVER_BETA_POSTGRES_SCHEMA_VERSION],
  );
  const row = result.rows[0] as { version?: number; applied_at?: Date | string } | undefined;

  return {
    initialized: row?.version === SERVER_BETA_POSTGRES_SCHEMA_VERSION,
    schemaVersion: typeof row?.version === 'number' ? row.version : null,
    appliedAt: row?.applied_at ? new Date(row.applied_at).toISOString() : null,
  };
}

function parseAuthMode(value: string | undefined): ServerBetaAuthMode {
  if (value === 'local-dev' || value === 'disabled') {
    return value;
  }
  return 'api-key';
}
