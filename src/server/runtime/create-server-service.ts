// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { ModeManager } from '../../services/domain/ModeManager.js';
import { createPostgresStorageRepositories, getSharedPostgresPool, SERVER_POSTGRES_SCHEMA_VERSION } from '../../storage/postgres/index.js';
import { bootstrapServerPostgresSchema } from '../../storage/postgres/schema.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { getRedisQueueConfig } from '../queue/redis-config.js';
import { ActiveServerQueueManager } from './ActiveServerQueueManager.js';
import { ActiveServerGenerationWorkerManager } from './ActiveServerGenerationWorkerManager.js';
import { ClaudeObservationProvider } from '../generation/providers/ClaudeObservationProvider.js';
import { GeminiObservationProvider } from '../generation/providers/GeminiObservationProvider.js';
import { OpenRouterObservationProvider } from '../generation/providers/OpenRouterObservationProvider.js';
import type { ServerGenerationProvider } from '../generation/providers/shared/types.js';
import { ServerService } from './ServerService.js';
import {
  DisabledServerGenerationWorkerManager,
  DisabledServerQueueManager,
  type ServerAuthMode,
  type ServerBootstrapStatus,
  type ServerGenerationWorkerManager,
  type ServerQueueManager,
  type ServerServiceGraph,
} from './types.js';

export interface CreateServerServiceOptions {
  pool?: PostgresPool;
  authMode?: ServerAuthMode;
  bootstrapSchema?: boolean;
  queueManager?: ServerQueueManager;
  // Phase 5 seam: tests can inject a fake provider without env config.
  generationProvider?: ServerGenerationProvider;
  generationWorkerManager?: ServerGenerationWorkerManager;
  // Phase 10: when true, skip building the generation worker. Used when the
  // service is just an HTTP front-end and a separate `server worker` process
  // consumes the BullMQ queues.
  generationDisabled?: boolean;
  // Phase 10: skip env validation (tests). Production code paths always run
  // validation so misconfiguration fails fast at startup.
  skipEnvValidation?: boolean;
}

// Phase 10 — env validation. Server in Docker requires explicit, complete
// configuration. Missing pieces fail fast at startup rather than silently
// degrading. Required env when running in Docker:
//   - CLAUDE_MEM_SERVER_DATABASE_URL  (Postgres)
//   - CLAUDE_MEM_QUEUE_ENGINE=bullmq  (no in-memory queue in Docker)
//   - CLAUDE_MEM_REDIS_URL            (BullMQ requires Redis/Valkey)
//   - CLAUDE_MEM_AUTH_MODE != local-dev (auth must be real in Docker)
// `local-dev` bypass is only valid on a developer's loopback; in Docker the
// container is reachable via service-to-service networking and exposed ports,
// so the loopback assumption is invalid.
export interface ServerEnvValidationOptions {
  env?: NodeJS.ProcessEnv;
  isDocker?: boolean;
}

export interface ServerEnvValidationResult {
  isDocker: boolean;
  runtime: string;
  authMode: string;
  queueEngine: string;
  hasDatabaseUrl: boolean;
  hasRedisUrl: boolean;
}

export function detectDockerEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAUDE_MEM_DOCKER === '1' || env.CLAUDE_MEM_DOCKER === 'true') return true;
  // /.dockerenv is the canonical Docker marker; existsSync is cheap.
  try {
    if (existsSync('/.dockerenv')) return true;
  } catch {
    // ignore
  }
  return false;
}

export function validateServerEnv(
  options: ServerEnvValidationOptions = {},
): ServerEnvValidationResult {
  const env = options.env ?? process.env;
  const isDocker = options.isDocker ?? detectDockerEnvironment(env);
  const errors: string[] = [];

  const runtime = (env.CLAUDE_MEM_RUNTIME ?? '').trim();
  if (!runtime) {
    // Warn but allow — defaulted to 'worker' upstream; we log a warning so
    // operators know the server runtime is active here.
    if (isDocker) {
      logger.warn('SYSTEM', 'CLAUDE_MEM_RUNTIME unset; server container assumes runtime=server');
    }
  } else if (runtime !== 'server' && runtime !== 'server-beta' && isDocker) {
    // Phase 1a (cmem-sdk rename): accept both the canonical `server` and the
    // legacy `server-beta` literal so existing operator configs keep working.
    errors.push(
      `CLAUDE_MEM_RUNTIME=${runtime} is invalid in Docker; the server image only runs CLAUDE_MEM_RUNTIME=server (or legacy CLAUDE_MEM_RUNTIME=server-beta).`,
    );
  }

  const authMode = (env.CLAUDE_MEM_AUTH_MODE ?? 'api-key').trim();
  if (isDocker) {
    if (authMode === 'local-dev') {
      errors.push(
        'CLAUDE_MEM_AUTH_MODE=local-dev is not allowed in Docker. Set CLAUDE_MEM_AUTH_MODE=api-key and create a key with `claude-mem server api-key create`.',
      );
    }
    if (
      env.CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS === '1'
      || env.CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS === 'true'
    ) {
      errors.push(
        'CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS is not allowed in Docker. Loopback bypass cannot be enforced inside a container; remove the variable.',
      );
    }
  }

  const queueEngine = (env.CLAUDE_MEM_QUEUE_ENGINE ?? '').trim().toLowerCase();
  if (isDocker) {
    if (!queueEngine) {
      errors.push('CLAUDE_MEM_QUEUE_ENGINE is required in Docker; set it to "bullmq".');
    } else if (queueEngine !== 'bullmq') {
      errors.push(
        `CLAUDE_MEM_QUEUE_ENGINE=${queueEngine} is not allowed in Docker. Only "bullmq" is supported (no in-process queues across container boundaries).`,
      );
    }
  }

  const hasDatabaseUrl = Boolean((env.CLAUDE_MEM_SERVER_DATABASE_URL ?? '').trim());
  if (!hasDatabaseUrl) {
    errors.push('CLAUDE_MEM_SERVER_DATABASE_URL is required to start the server (Postgres connection string).');
  }

  const hasRedisUrl = Boolean((env.CLAUDE_MEM_REDIS_URL ?? '').trim());
  if (queueEngine === 'bullmq' && !hasRedisUrl) {
    errors.push('CLAUDE_MEM_REDIS_URL is required when CLAUDE_MEM_QUEUE_ENGINE=bullmq.');
  }

  if (errors.length > 0) {
    const message = [
      'server startup configuration is invalid:',
      ...errors.map(line => `  - ${line}`),
    ].join('\n');
    throw new Error(message);
  }

  return {
    isDocker,
    // Phase 1a: report the canonical `'server'` value when unset; legacy
    // `'server-beta'` is preserved verbatim when explicitly supplied so
    // diagnostics reflect the operator's actual config.
    runtime: runtime || 'server',
    authMode,
    queueEngine: queueEngine || 'disabled',
    hasDatabaseUrl,
    hasRedisUrl,
  };
}

// #2443 — the server runtime must load an observation mode before it can
// process any generation job; without it every job fails with "No mode
// loaded". We mirror the worker's pattern (src/services/worker-service.ts) and
// fail fast at boot if no mode can be loaded, so a broken install surfaces at
// startup rather than as silent per-job failures.
export function loadServerMode(): void {
  // ModeManager.loadMode('code') throws ('Critical: code.json mode file
  // missing') if the bundled mode is absent — that propagates as a fatal boot
  // error. We additionally assert a mode is active afterward.
  const modeManager = ModeManager.getInstance();
  modeManager.loadMode('code');
  // getActiveMode() throws if nothing is loaded — this is the explicit
  // validation that boot did not silently no-op.
  modeManager.getActiveMode();
  logger.info('SYSTEM', 'Server mode loaded', { mode: 'code' });
}

export async function createServerService(
  options: CreateServerServiceOptions = {},
): Promise<ServerService> {
  // Generation prompt-builder requires an active mode; the server runtime never
  // went through the plugin setup path that loads one, so we do it here
  // explicitly.
  try {
    ModeManager.getInstance().loadMode('code');
  } catch (err) {
    // Mode files are optional, but surface failures (e.g. malformed JSON in a
    // CLAUDE_MEM_MODES_DIR file) so an operator can diagnose why custom types
    // aren't appearing instead of silently falling back to the defaults.
    logger.warn('SYSTEM', 'server: failed to load mode at startup (mode files optional)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!options.skipEnvValidation) {
    validateServerEnv();
  }
  // Fail fast if no observation mode can be loaded (#2443). Must happen before
  // the service starts accepting jobs.
  loadServerMode();
  const pool = options.pool ?? getSharedPostgresPool({ requireDatabaseUrl: true });
  const bootstrap = await initializePostgres(pool, options.bootstrapSchema ?? true);
  const queueManager = options.queueManager ?? buildQueueManager();
  const generationDisabled = options.generationDisabled
    ?? (process.env.CLAUDE_MEM_GENERATION_DISABLED === '1'
      || process.env.CLAUDE_MEM_GENERATION_DISABLED === 'true');
  const generationWorkerManager = options.generationWorkerManager
    ?? (generationDisabled
      ? new DisabledServerGenerationWorkerManager(
          'CLAUDE_MEM_GENERATION_DISABLED is set; this server runs HTTP only. A separate `claude-mem server worker start` process consumes the BullMQ queues.',
        )
      : buildGenerationWorkerManager(pool, queueManager, options.generationProvider));
  const graph: ServerServiceGraph = {
    // Persisted runtime literal — Phase 1d will migrate this value. The TS
    // identifiers above are now `Server*`; the wire/storage value remains
    // `'server-beta'` for back-compat.
    runtime: 'server-beta',
    postgres: {
      pool,
      bootstrap,
    },
    authMode: options.authMode ?? parseAuthMode(process.env.CLAUDE_MEM_AUTH_MODE),
    queueManager,
    generationWorkerManager,
    storage: createPostgresStorageRepositories(pool),
  };

  if (generationWorkerManager instanceof ActiveServerGenerationWorkerManager) {
    generationWorkerManager.start();
  }

  return new ServerService({ graph });
}

function buildGenerationWorkerManager(
  pool: PostgresPool,
  queueManager: ServerQueueManager,
  injectedProvider?: ServerGenerationProvider,
): ServerGenerationWorkerManager {
  if (!(queueManager instanceof ActiveServerQueueManager)) {
    return new DisabledServerGenerationWorkerManager(
      'queue manager is disabled; set CLAUDE_MEM_QUEUE_ENGINE=bullmq to enable provider generation.',
    );
  }
  const provider = injectedProvider ?? buildServerGenerationProviderFromEnv();
  if (!provider) {
    return new DisabledServerGenerationWorkerManager(
      'no server generation provider configured; set CLAUDE_MEM_SERVER_PROVIDER and the matching API key to enable.',
    );
  }
  return new ActiveServerGenerationWorkerManager({
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
      const opts: { apiKey: string; model?: string; baseUrl?: string } = { apiKey };
      if (process.env.CLAUDE_MEM_SERVER_MODEL) opts.model = process.env.CLAUDE_MEM_SERVER_MODEL;
      // #2382/#2590/#2622/#2393 — optional OpenAI-compatible base URL.
      const baseUrl = process.env.CLAUDE_MEM_OPENROUTER_BASE_URL ?? process.env.OPENROUTER_BASE_URL;
      if (baseUrl) opts.baseUrl = baseUrl;
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
function buildQueueManager(): ServerQueueManager {
  const config = getRedisQueueConfig();
  if (config.engine !== 'bullmq') {
    return new DisabledServerQueueManager(
      `Queue engine is "${config.engine}"; set CLAUDE_MEM_QUEUE_ENGINE=bullmq to activate the server queue manager.`,
    );
  }
  return new ActiveServerQueueManager(config);
}

async function initializePostgres(pool: PostgresPool, bootstrapSchema: boolean): Promise<ServerBootstrapStatus> {
  if (!bootstrapSchema) {
    return { initialized: false, schemaVersion: null, appliedAt: null };
  }

  await bootstrapServerPostgresSchema(pool);
  const result = await pool.query(
    `
      SELECT version, applied_at
      FROM server_beta_schema_migrations
      WHERE version = $1
    `,
    [SERVER_POSTGRES_SCHEMA_VERSION],
  );
  const row = result.rows[0] as { version?: number; applied_at?: Date | string } | undefined;

  return {
    initialized: row?.version === SERVER_POSTGRES_SCHEMA_VERSION,
    schemaVersion: typeof row?.version === 'number' ? row.version : null,
    appliedAt: row?.applied_at ? new Date(row.applied_at).toISOString() : null,
  };
}

function parseAuthMode(value: string | undefined): ServerAuthMode {
  if (value === 'local-dev' || value === 'disabled') {
    return value;
  }
  return 'api-key';
}
