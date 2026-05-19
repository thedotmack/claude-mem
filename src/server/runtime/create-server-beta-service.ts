// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { createPostgresStorageRepositories, getSharedPostgresPool, SERVER_BETA_POSTGRES_SCHEMA_VERSION } from '../../storage/postgres/index.js';
import { bootstrapServerBetaPostgresSchema } from '../../storage/postgres/schema.js';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { getRedisQueueConfig } from '../queue/redis-config.js';
import { ActiveServerBetaQueueManager } from './ActiveServerBetaQueueManager.js';
import { ActiveServerBetaGenerationWorkerManager } from './ActiveServerBetaGenerationWorkerManager.js';
import { ClaudeObservationProvider } from '../generation/providers/ClaudeObservationProvider.js';
import { ClaudeHostBridgeProvider } from '../generation/providers/ClaudeHostBridgeProvider.js';
import { GeminiObservationProvider } from '../generation/providers/GeminiObservationProvider.js';
import { OpenRouterObservationProvider } from '../generation/providers/OpenRouterObservationProvider.js';
import type { ServerGenerationProvider } from '../generation/providers/shared/types.js';
import { ServerBetaService } from './ServerBetaService.js';
import { ModeManager } from '../../services/domain/ModeManager.js';
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
  // Phase 10: when true, skip building the generation worker. Used when the
  // service is just an HTTP front-end and a separate `server worker` process
  // consumes the BullMQ queues.
  generationDisabled?: boolean;
  // Phase 10: skip env validation (tests). Production code paths always run
  // validation so misconfiguration fails fast at startup.
  skipEnvValidation?: boolean;
}

// env validation. Server beta in Docker requires explicit, complete
// configuration. Missing pieces fail fast at startup rather than silently
// degrading. Required env when running in Docker:
//   - CLAUDE_MEM_SERVER_DATABASE_URL  (Postgres)
//   - CLAUDE_MEM_QUEUE_ENGINE=bullmq  (no in-memory queue in Docker)
//   - CLAUDE_MEM_REDIS_URL            (BullMQ requires Redis/Valkey)
//   - CLAUDE_MEM_AUTH_MODE != local-dev (auth must be real in Docker)
// `local-dev` bypass is only valid on a developer's loopback; in Docker the
// container is reachable via service-to-service networking and exposed ports,
// so the loopback assumption is invalid.
export interface ServerBetaEnvValidationOptions {
  env?: NodeJS.ProcessEnv;
  isDocker?: boolean;
}

export interface ServerBetaEnvValidationResult {
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

export function validateServerBetaEnv(
  options: ServerBetaEnvValidationOptions = {},
): ServerBetaEnvValidationResult {
  const env = options.env ?? process.env;
  const isDocker = options.isDocker ?? detectDockerEnvironment(env);
  const errors: string[] = [];

  const runtime = (env.CLAUDE_MEM_RUNTIME ?? '').trim();
  if (!runtime) {
    // Warn but allow — defaulted to 'worker' upstream; we log a warning so
    // operators know server-beta is the active runtime here.
    if (isDocker) {
      logger.warn('SYSTEM', 'CLAUDE_MEM_RUNTIME unset; server-beta container assumes runtime=server-beta');
    }
  } else if (runtime !== 'server-beta' && isDocker) {
    errors.push(
      `CLAUDE_MEM_RUNTIME=${runtime} is invalid in Docker; the server-beta image only runs CLAUDE_MEM_RUNTIME=server-beta.`,
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
    errors.push('CLAUDE_MEM_SERVER_DATABASE_URL is required to start server-beta (Postgres connection string).');
  } else if (isDocker) {
    // fix — inside Docker, the Postgres host must be a service name
    // (e.g. 'postgres'), not 127.0.0.1/localhost/::1. A loopback URL points
    // at the container itself, which has no Postgres listener, and every
    // request will fail with ECONNREFUSED.
    const loopback = detectLoopbackHost(env.CLAUDE_MEM_SERVER_DATABASE_URL);
    if (loopback) {
      errors.push(
        `CLAUDE_MEM_SERVER_DATABASE_URL points to loopback host '${loopback}' inside a container; use the service hostname 'postgres' (or the compose service name) instead.`,
      );
    }
  }

  const hasRedisUrl = Boolean((env.CLAUDE_MEM_REDIS_URL ?? '').trim());
  if (queueEngine === 'bullmq' && !hasRedisUrl) {
    errors.push('CLAUDE_MEM_REDIS_URL is required when CLAUDE_MEM_QUEUE_ENGINE=bullmq.');
  } else if (isDocker && hasRedisUrl) {
    // fix — same loopback guard for Redis/Valkey. Compose uses
    // 'redis://valkey:6379'; the container has no Redis listener on 127.0.0.1.
    const loopback = detectLoopbackHost(env.CLAUDE_MEM_REDIS_URL);
    if (loopback) {
      errors.push(
        `CLAUDE_MEM_REDIS_URL points to loopback host '${loopback}' inside a container; use the service hostname 'valkey' (or the compose service name) instead.`,
      );
    }
  }

  if (errors.length > 0) {
    const message = [
      'server-beta startup configuration is invalid:',
      ...errors.map(line => `  - ${line}`),
    ].join('\n');
    throw new Error(message);
  }

  return {
    isDocker,
    runtime: runtime || 'server-beta',
    authMode,
    queueEngine: queueEngine || 'disabled',
    hasDatabaseUrl,
    hasRedisUrl,
  };
}

// detectLoopbackHost — helper. Returns the offending host string if
// the URL's host parses to a loopback alias, or null otherwise. Tolerant of
// non-URL inputs (returns null) so this only enforces the rule when the
// caller supplied a syntactically valid URL.
function detectLoopbackHost(rawUrl: string | undefined): string | null {
  const value = (rawUrl ?? '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') {
      return host;
    }
    return null;
  } catch {
    // Not a parseable URL; let later code surface a clearer error.
    return null;
  }
}

export async function createServerBetaService(
  options: CreateServerBetaServiceOptions = {},
): Promise<ServerBetaService> {
  if (!options.skipEnvValidation) {
    validateServerBetaEnv();
  }
  const pool = options.pool ?? getSharedPostgresPool({ requireDatabaseUrl: true });
  const bootstrap = await initializePostgres(pool, options.bootstrapSchema ?? true);
  const queueManager = options.queueManager ?? buildQueueManager();
  const generationDisabled = options.generationDisabled
    ?? (process.env.CLAUDE_MEM_GENERATION_DISABLED === '1'
      || process.env.CLAUDE_MEM_GENERATION_DISABLED === 'true');
  const generationWorkerManager = options.generationWorkerManager
    ?? (generationDisabled
      ? (() => {
          // fix — surface why generation is off so operators see the
          // reason in logs instead of guessing why no observations are produced.
          logger.warn(
            'SYSTEM',
            'Generation worker is DISABLED (CLAUDE_MEM_GENERATION_DISABLED is set). This server runs HTTP only; a separate `claude-mem server worker start` process must consume BullMQ queues to produce observations.',
          );
          return new DisabledServerBetaGenerationWorkerManager(
            'CLAUDE_MEM_GENERATION_DISABLED is set; this server runs HTTP only. A separate `claude-mem server worker start` process consumes the BullMQ queues.',
          );
        })()
      : buildGenerationWorkerManager(pool, queueManager, options.generationProvider));
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

  // fix — ensure the singleton ModeManager has a mode loaded before the
  // first generation job. Pre-fix, every generation worker threw
  //   "Error: No mode loaded. Call loadMode() first."
  // because createServerBetaService never primed the singleton.
  //
  // Mode is read from CLAUDE_MEM_MODE (default 'code'). Failures are logged
  // but non-fatal so the HTTP server can still come up — the worker will
  // surface a clearer error on first job attempt. CLAUDE_MEM_MODES_DIR can
  // point at an explicit modes directory inside Docker (see ModeManager).
  const modeName = (process.env.CLAUDE_MEM_MODE ?? 'code').trim() || 'code';
  try {
    const mode = ModeManager.getInstance().loadMode(modeName);
    logger.info('SYSTEM', `server-beta: ModeManager loaded mode "${mode.name}" (${modeName}).`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(
      'SYSTEM',
      `server-beta: ModeManager.loadMode("${modeName}") failed: ${detail}. Generation jobs will fail until the mode loads. Set CLAUDE_MEM_MODES_DIR to point at your plugin/modes directory if it lives outside the package root.`,
    );
  }

  return new ServerBetaService({ graph });
}

function buildGenerationWorkerManager(
  pool: PostgresPool,
  queueManager: ServerBetaQueueManager,
  injectedProvider?: ServerGenerationProvider,
): ServerBetaGenerationWorkerManager {
  if (!(queueManager instanceof ActiveServerBetaQueueManager)) {
    // fix — log why generation is off so operators see the reason.
    logger.warn(
      'SYSTEM',
      'Generation worker DISABLED: queue manager is not active. Fix: set CLAUDE_MEM_QUEUE_ENGINE=bullmq and ensure CLAUDE_MEM_REDIS_URL points at a reachable Valkey/Redis instance.',
    );
    return new DisabledServerBetaGenerationWorkerManager(
      'queue manager is disabled; set CLAUDE_MEM_QUEUE_ENGINE=bullmq to enable provider generation.',
    );
  }
  const provider = injectedProvider ?? buildServerGenerationProviderFromEnv();
  if (!provider) {
    // fix — provider env is the most common silent-degrade case.
    // Surface CLAUDE_MEM_SERVER_PROVIDER + key status so operators know exactly
    // which variable is missing.
    const providerName = (process.env.CLAUDE_MEM_SERVER_PROVIDER ?? '').trim() || '(unset)';
    const hasAnthropic = Boolean((process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_MEM_ANTHROPIC_API_KEY ?? '').trim());
    const hasGemini = Boolean((process.env.GEMINI_API_KEY ?? process.env.CLAUDE_MEM_GEMINI_API_KEY ?? '').trim());
    const hasOpenRouter = Boolean((process.env.OPENROUTER_API_KEY ?? process.env.CLAUDE_MEM_OPENROUTER_API_KEY ?? '').trim());
    logger.warn(
      'SYSTEM',
      `Generation worker DISABLED: no provider configured. CLAUDE_MEM_SERVER_PROVIDER=${providerName}, ANTHROPIC_API_KEY=${hasAnthropic ? 'set' : 'unset'}, GEMINI_API_KEY=${hasGemini ? 'set' : 'unset'}, OPENROUTER_API_KEY=${hasOpenRouter ? 'set' : 'unset'}. Fix: set CLAUDE_MEM_SERVER_PROVIDER (claude|gemini|openrouter) and the matching API key.`,
    );
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
      // subscription OAuth path. The creds file is read FRESH per
      // generate() request so when the host bind-mounts ~/.claude/.credentials.json,
      // we pick up token refreshes and account switches without restarting the
      // container. Falls back to ANTHROPIC_API_KEY (api-key auth) when no creds
      // are available. The Host-Bridge mode (Phase 2, opt-in via
      // CLAUDE_MEM_CLAUDE_BRIDGE_URL) bypasses both paths and proxies to the
      // host's Claude CLI for 100% live behaviour on macOS Keychain installs.
      const bridgeUrl = (process.env.CLAUDE_MEM_CLAUDE_BRIDGE_URL ?? '').trim();
      const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_MEM_ANTHROPIC_API_KEY ?? '';
      const probeToken = readClaudeOAuthToken();
      if (!bridgeUrl && !probeToken && !apiKey) return null;

      // Phase 2 wiring: prefer host-bridge when configured. The bridge
      // forwards every prompt to the host's `claude` CLI — 100% live
      // (account switches, token refreshes, model selection) for installs
      // that only have macOS Keychain credentials.
      if (bridgeUrl) {
        const bridgeToken = readClaudeHostBridgeToken();
        if (!bridgeToken) {
          logger.warn(
            'SYSTEM',
            'CLAUDE_MEM_CLAUDE_BRIDGE_URL is set but host-bridge token file is missing; ' +
              'falling back to subscription file or api-key auth.',
          );
        } else {
          const bridgeOpts: { bridgeUrl: string; bridgeToken: string; model?: string } = {
            bridgeUrl,
            bridgeToken,
          };
          if (process.env.CLAUDE_MEM_SERVER_MODEL) bridgeOpts.model = process.env.CLAUDE_MEM_SERVER_MODEL;
          logger.info('SYSTEM', 'Claude generation provider configured', {
            authMethod: 'host-bridge',
            bridge: bridgeUrl,
            model: bridgeOpts.model ?? '(host-bridge default)',
          });
          return new ClaudeHostBridgeProvider(bridgeOpts);
        }
      }

      const opts: {
        apiKey?: string;
        oauthToken?: string;
        oauthResolver?: () => string | undefined;
        model?: string;
      } = {};
      if (probeToken) {
        opts.oauthResolver = () => readClaudeOAuthToken();
      }
      if (apiKey) opts.apiKey = apiKey;
      if (process.env.CLAUDE_MEM_SERVER_MODEL) opts.model = process.env.CLAUDE_MEM_SERVER_MODEL;
      logger.info('SYSTEM', 'Claude generation provider configured', {
        authMethod: probeToken ? 'subscription (live file)' : 'api-key',
        model: opts.model ?? '(default)',
      });
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

/**
 * Read the Claude Code subscription OAuth access token from a
 * mounted credentials file. Used by buildServerGenerationProviderFromEnv()
 * to enable subscription-billed observation generation inside the Docker
 * worker container without requiring an ANTHROPIC_API_KEY.
 *
 * Lookup order (first hit wins):
 *   1. CLAUDE_MEM_CLAUDE_CREDS_FILE env var (explicit path)
 *   2. ~/.claude/.credentials.json (standard Claude CLI location)
 *
 * The credentials.json is the same format the @anthropic-ai/claude-code CLI
 * writes after `claude login` — a JSON object with a `claudeAiOauth.accessToken`
 * field (`sk-ant-oat01-...`). That token is a valid Anthropic API Bearer.
 *
 * Returns undefined when no creds file exists or the token is expired.
 * Token-refresh is not handled here (Phase 2); the worker logs the expiry
 * and falls back to the API-key path automatically.
 */
function readClaudeOAuthToken(): string | undefined {
  const explicit = (process.env.CLAUDE_MEM_CLAUDE_CREDS_FILE ?? '').trim();
  const home = process.env.HOME ?? '/root';
  const candidates = [
    explicit,
    `${home}/.claude/.credentials.json`,
  ].filter((p) => p && existsSync(p));

  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
        claudeAiOauth?: {
          accessToken?: string;
          expiresAt?: number;
        };
      };
      const oauth = raw.claudeAiOauth;
      if (!oauth?.accessToken) continue;
      if (typeof oauth.expiresAt === 'number' && oauth.expiresAt < Date.now()) {
        logger.warn('SYSTEM', 'Claude OAuth token expired; falling back to API key', {
          path,
          expiredMsAgo: Date.now() - oauth.expiresAt,
        });
        continue;
      }
      return oauth.accessToken;
    } catch (err) {
      logger.debug('SYSTEM', 'Could not read Claude credentials file', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return undefined;
}

/**
 * Read the host-bridge Bearer token.
 *
 * The token is written by the install script to ~/.claude-mem/host-bridge-token
 * (chmod 600) and bind-mounted into the container at
 * /run/secrets/claude-host-bridge-token. CLAUDE_MEM_CLAUDE_BRIDGE_TOKEN_FILE
 * can override the in-container path for tests.
 *
 * Returns undefined when no token file is present; the factory then falls
 * back to the file-mount or api-key paths so the worker keeps generating
 * even if the bridge wiring is half-installed.
 */
function readClaudeHostBridgeToken(): string | undefined {
  const explicit = (process.env.CLAUDE_MEM_CLAUDE_BRIDGE_TOKEN_FILE ?? '').trim();
  const home = process.env.HOME ?? '/root';
  const candidates = [
    explicit,
    '/run/secrets/claude-host-bridge-token',
    `${home}/.claude-mem/host-bridge-token`,
  ].filter((p) => p && existsSync(p));

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (raw.length > 0) return raw;
    } catch (err) {
      logger.debug('SYSTEM', 'Could not read host-bridge token file', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return undefined;
}
