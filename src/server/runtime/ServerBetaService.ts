// SPDX-License-Identifier: Apache-2.0

import type { Application } from 'express';
import { spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { Server, type RouteHandler } from '../../services/server/Server.js';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  captureProcessStartToken,
  verifyPidFileOwnership,
  type PidInfo,
} from '../../supervisor/process-registry.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { ServerV1PostgresRoutes } from '../routes/v1/ServerV1PostgresRoutes.js';
import { SessionsObservationsAdapter } from '../compat/SessionsObservationsAdapter.js';
import { SessionsSummarizeAdapter } from '../compat/SessionsSummarizeAdapter.js';
import { ActiveServerBetaQueueManager } from './ActiveServerBetaQueueManager.js';
import { ServerViewerRoutes } from './ServerViewerRoutes.js';
import type { ServerBetaServiceGraph, ServerBetaQueueLaneMetric } from './types.js';

const SERVER_BETA_RUNTIME = 'server-beta';
const DEFAULT_SERVER_BETA_HOST = '127.0.0.1';
const DEFAULT_SERVER_BETA_PORT = 37877;

export interface ServerBetaServiceOptions {
  graph: ServerBetaServiceGraph;
  host?: string;
  port?: number;
  persistRuntimeState?: boolean;
}

export interface ServerBetaRuntimeState {
  runtime: typeof SERVER_BETA_RUNTIME;
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  bootstrap: ServerBetaServiceGraph['postgres']['bootstrap'];
  boundaries: {
    queueManager: ReturnType<ServerBetaServiceGraph['queueManager']['getHealth']>;
    generationWorkerManager: ReturnType<ServerBetaServiceGraph['generationWorkerManager']['getHealth']>;
    providerRegistry: ReturnType<ServerBetaServiceGraph['providerRegistry']['getHealth']>;
    eventBroadcaster: ReturnType<ServerBetaServiceGraph['eventBroadcaster']['getHealth']>;
  };
}

class ServerBetaRuntimeInfoRoutes implements RouteHandler {
  constructor(private readonly graph: ServerBetaServiceGraph) {}

  setupRoutes(app: Application): void {
    app.get('/healthz', (_req, res) => {
      res.json({ status: 'ok', runtime: SERVER_BETA_RUNTIME });
    });

    // Phase 12 — `/v1/info` includes per-lane queue metrics so deploy probes
    // can read waiting/active/completed/failed/delayed/stalled without
    // hitting `/api/health`. Sampling is best-effort: a Redis blip surfaces
    // the lane with `unavailable: true` rather than crashing the route.
    app.get('/v1/info', async (_req, res) => {
      const queueLanes = await collectQueueLaneMetrics(this.graph);
      res.json({
        name: 'claude-mem-server',
        runtime: SERVER_BETA_RUNTIME,
        authMode: this.graph.authMode,
        postgres: {
          initialized: this.graph.postgres.bootstrap.initialized,
          schemaVersion: this.graph.postgres.bootstrap.schemaVersion,
        },
        boundaries: {
          queueManager: this.graph.queueManager.getHealth(),
          generationWorkerManager: this.graph.generationWorkerManager.getHealth(),
          providerRegistry: this.graph.providerRegistry.getHealth(),
          eventBroadcaster: this.graph.eventBroadcaster.getHealth(),
        },
        queueLanes,
      });
    });
  }
}

async function collectQueueLaneMetrics(
  graph: ServerBetaServiceGraph,
): Promise<ServerBetaQueueLaneMetric[]> {
  const manager = graph.queueManager;
  if (!(manager instanceof ActiveServerBetaQueueManager)) {
    return [];
  }
  try {
    return await manager.getLaneMetrics();
  } catch {
    // /api/health and /v1/info MUST never throw on a queue blip — surface
    // empty lanes so the rest of the payload still renders.
    return [];
  }
}

export class ServerBetaService {
  private readonly graph: ServerBetaServiceGraph;
  private readonly host: string;
  private readonly requestedPort: number;
  private boundPort: number | null = null;
  private readonly persistRuntimeState: boolean;
  private server: Server | null = null;
  private stopping = false;

  constructor(options: ServerBetaServiceOptions) {
    this.graph = options.graph;
    this.host = options.host ?? process.env.CLAUDE_MEM_SERVER_HOST ?? DEFAULT_SERVER_BETA_HOST;
    this.requestedPort = options.port ?? getServerBetaPort();
    this.persistRuntimeState = options.persistRuntimeState ?? true;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = new Server({
      // #2572 — server runtime is reachable over the network in Docker, so it
      // emits hardening headers (the worker, loopback-only, does not).
      securityHeaders: true,
      getInitializationComplete: () => this.graph.postgres.bootstrap.initialized,
      getMcpReady: () => true,
      onShutdown: () => this.stop(),
      onRestart: async () => {
        await this.stop();
        await this.start();
      },
      workerPath: '',
      runtime: SERVER_BETA_RUNTIME,
      getAiStatus: () => ({
        provider: 'disabled',
        authMethod: this.graph.authMode,
        lastInteraction: null,
      }),
      // Phase 10 — surface BullMQ/Valkey health on /api/health so deploy
      // probes (and the Docker E2E) can confirm the queue engine without
      // peeking at /v1/info. The queue manager's getHealth() returns its
      // boundary descriptor; we shape it into the worker-compatible
      // ObservationQueueHealth schema the Server class expects.
      // Phase 12 — also include per-lane counts (waiting/active/completed/
      // failed/delayed/stalled) so deploy probes can monitor saturation.
      getQueueHealth: async () => {
        const health = this.graph.queueManager.getHealth();
        const details = (health.details ?? {}) as Record<string, unknown>;
        if (health.status !== 'active' || details.engine !== 'bullmq') {
          return null;
        }
        const lanes = await collectQueueLaneMetrics(this.graph);
        return {
          engine: 'bullmq' as const,
          redis: {
            status: 'ok' as const,
            mode: String(details.mode ?? 'unknown'),
            host: String(details.host ?? '127.0.0.1'),
            port: typeof details.port === 'number' ? details.port : 6379,
            prefix: String(details.prefix ?? 'claude_mem'),
          },
          lanes: lanes.map(lane => ({
            kind: lane.kind,
            name: lane.name,
            waiting: lane.waiting,
            active: lane.active,
            completed: lane.completed,
            failed: lane.failed,
            delayed: lane.delayed,
            stalled: lane.stalled,
            unavailable: lane.unavailable,
            ...(lane.unavailableReason ? { unavailableReason: lane.unavailableReason } : {}),
          })),
        };
      },
    });
    server.registerRoutes(new ServerBetaRuntimeInfoRoutes(this.graph));
    const v1Routes = new ServerV1PostgresRoutes({
      pool: this.graph.postgres.pool,
      queueManager: this.graph.queueManager,
      authMode: this.graph.authMode === 'disabled' ? 'api-key' : this.graph.authMode,
      runtime: SERVER_BETA_RUNTIME,
      // Session policy is read inside the routes (default 'per-event' from
      // resolveSessionGenerationPolicy(), env-overridable via
      // CLAUDE_MEM_SERVER_SESSION_POLICY). We do not duplicate it here.
    });
    server.registerRoutes(v1Routes);

    // Phase 9 — legacy compatibility adapters. These translate the old
    // `/api/sessions/observations` and `/api/sessions/summarize` worker
    // routes to the canonical Server beta event/job model. They share the
    // SAME shared services with /v1/* routes — never duplicate ingest or
    // session-end logic. New clients should hit /v1/* directly.
    const compatAuthMode = this.graph.authMode === 'disabled' ? 'api-key' : this.graph.authMode;
    server.registerRoutes(new SessionsObservationsAdapter({
      pool: this.graph.postgres.pool,
      ingestEvents: v1Routes.getIngestEventsService(),
      authMode: compatAuthMode,
    }));
    server.registerRoutes(new SessionsSummarizeAdapter({
      pool: this.graph.postgres.pool,
      endSession: v1Routes.getEndSessionService(),
      authMode: compatAuthMode,
    }));

    // #2552 — mount the Viewer UI static handler so the viewer loads on the
    // server runtime. Registered AFTER the /v1 and compat API routes so the
    // viewer's own API calls resolve against those; express.static only
    // matches existing files and the `/` GET only matches the root, so this
    // never shadows an API route.
    server.registerRoutes(new ServerViewerRoutes());

    server.finalizeRoutes();

    await server.listen(this.requestedPort, this.host);
    this.server = server;
    this.boundPort = resolveBoundPort(server) ?? this.requestedPort;
    if (this.persistRuntimeState) {
      writeServerBetaState(this.runtimeState());
    }
    logger.info('SYSTEM', 'Server beta started', { host: this.host, port: this.boundPort, pid: process.pid });
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    try {
      if (this.server) {
        try {
          await this.server.close();
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ERR_SERVER_NOT_RUNNING') {
            throw error;
          }
        }
        this.server = null;
      }
      await Promise.all([
        this.graph.queueManager.close(),
        this.graph.generationWorkerManager.close(),
        this.graph.providerRegistry.close(),
        this.graph.eventBroadcaster.close(),
      ]);
      await this.graph.postgres.pool.end();
    } finally {
      if (this.persistRuntimeState) {
        removeServerBetaState();
      }
      this.boundPort = null;
      this.stopping = false;
      logger.info('SYSTEM', 'Server beta stopped');
    }
  }

  getRuntimeState(): ServerBetaRuntimeState {
    return this.runtimeState();
  }

  private runtimeState(): ServerBetaRuntimeState {
    return {
      runtime: SERVER_BETA_RUNTIME,
      pid: process.pid,
      port: this.boundPort ?? this.requestedPort,
      host: this.host,
      startedAt: new Date().toISOString(),
      bootstrap: this.graph.postgres.bootstrap,
      boundaries: {
        queueManager: this.graph.queueManager.getHealth(),
        generationWorkerManager: this.graph.generationWorkerManager.getHealth(),
        providerRegistry: this.graph.providerRegistry.getHealth(),
        eventBroadcaster: this.graph.eventBroadcaster.getHealth(),
      },
    };
  }
}

function resolveBoundPort(server: Server): number | null {
  const address = server.getHttpServer()?.address();
  return address && typeof address !== 'string' ? address.port : null;
}

// #2444 — `start` is foreground by default; `--daemon`/`-d` opts into the
// detached background daemon. Exported so the CLI contract is unit-testable
// without spawning a real service.
export function startCommandWantsDaemon(startArgs: string[]): boolean {
  return startArgs.some(flag => flag === '--daemon' || flag === '-d');
}

export async function runServerBetaCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? '--daemon';
  const port = getServerBetaPort();
  const host = process.env.CLAUDE_MEM_SERVER_HOST ?? DEFAULT_SERVER_BETA_HOST;

  // Phase 10: `claude-mem server worker [start|--daemon]` runs the BullMQ
  // generation worker as a foregrounded process — no HTTP server, no route
  // registration. In Compose this becomes a separately scaled service.
  if (command === 'worker') {
    const sub = (argv[1] ?? '--daemon').toLowerCase();
    if (sub === 'start' || sub === '--daemon' || sub === 'run') {
      await runServerBetaGenerationWorker();
      return;
    }
    console.error('Usage: server-beta-service worker start');
    process.exit(1);
  }

  // `server api-key create|list|revoke|migrate-scopes` mirrors the
  // worker-service tooling but writes to the Postgres `api_keys` table the
  // server-beta runtime actually reads from. The legacy worker-service CLI
  // talks to SQLite and would be invisible to this stack.
  if (command === 'server' && argv[1]?.toLowerCase() === 'api-key') {
    await runServerBetaApiKeyCli(argv.slice(2));
    return;
  }

  // #2572 — `server keys` lists ACTIVE keys (never printing secrets) and
  // `server jobs` lists/inspects queued generation jobs. Both read the
  // Postgres backend the server-beta runtime uses.
  if (command === 'server' && argv[1]?.toLowerCase() === 'keys') {
    await runServerBetaKeysCli(argv.slice(2));
    return;
  }
  if (command === 'server' && argv[1]?.toLowerCase() === 'jobs') {
    await runServerBetaJobsCli(argv.slice(2));
    return;
  }

  switch (command) {
    case 'start': {
      const existing = readServerBetaPidFile();
      if (verifyPidFileOwnership(existing)) {
        console.log(JSON.stringify({ status: 'ready', runtime: SERVER_BETA_RUNTIME, pid: existing.pid, port: existing.port }));
        return;
      }

      // #2444 — `start` runs in the FOREGROUND by default so the server is
      // usable under systemd `Type=simple` (the supervisor owns the PID and
      // restart policy). Detached daemonization is an explicit opt-in via
      // `start --daemon`, preserving the old behavior for ad-hoc local use.
      const wantsDaemon = startCommandWantsDaemon(argv.slice(1));
      if (wantsDaemon) {
        const daemonPid = spawnServerBetaDaemon(port);
        if (daemonPid === undefined) {
          console.error('Failed to spawn server beta daemon.');
          process.exit(1);
        }
        console.log(JSON.stringify({ status: 'starting', runtime: SERVER_BETA_RUNTIME, pid: daemonPid, port }));
        return;
      }

      // Foreground path: run the service in THIS process and block until a
      // shutdown signal. Identical wiring to the internal `--daemon` worker
      // process, but attached to the controlling terminal / unit.
      await runServerBetaForeground(port, host);
      return;
    }

    case 'stop': {
      const existing = readServerBetaPidFile();
      if (!verifyPidFileOwnership(existing)) {
        removeServerBetaState();
        console.log('Server beta is not running');
        return;
      }
      process.kill(existing.pid, 'SIGTERM');
      await waitForPidExit(existing.pid, 5000);
      removeServerBetaState();
      console.log('Server beta stopped');
      return;
    }

    case 'restart': {
      // restart implies a managed background daemon (there is no foreground
      // process to hand control back to), so it re-spawns detached.
      await runServerBetaCli(['stop']);
      await runServerBetaCli(['start', '--daemon']);
      return;
    }

    case 'status': {
      const state = readServerBetaRuntimeState();
      const pidInfo = readServerBetaPidFile();
      if (state && verifyPidFileOwnership(pidInfo)) {
        console.log('Server beta is running');
        console.log(`  PID: ${state.pid}`);
        console.log(`  Port: ${state.port}`);
        console.log(`  Runtime: ${state.runtime}`);
        console.log(`  Started: ${state.startedAt}`);
      } else {
        console.log('Server beta is not running');
      }
      return;
    }

    case '--daemon': {
      // Internal entrypoint executed by the detached child spawned via
      // `start --daemon`. Runs the same foreground loop in the child process.
      await runServerBetaForeground(port, host);
      return;
    }

    default:
      console.error('Usage: server-beta-service start [--daemon] | stop | restart | status');
      console.error('  start            run the server in the foreground (default; systemd Type=simple)');
      console.error('  start --daemon   detach and run as a background daemon');
      console.error('  stop             stop a running daemon');
      console.error('  restart          stop then start (daemon)');
      console.error('  status           print runtime status');
      console.error('  server api-key create|list|revoke|migrate-scopes   manage Postgres API keys');
      console.error('  server keys                                        list active keys (no secrets)');
      console.error('  server jobs [list|inspect <id>]                    list/inspect generation jobs');
      process.exit(1);
  }
}

// #2444 — shared foreground run loop. Builds the service in THIS process,
// installs signal handlers, and blocks until shutdown. Used both by `start`
// (default, foreground) and by the internal `--daemon` child process.
async function runServerBetaForeground(port: number, host: string): Promise<void> {
  const existing = readServerBetaPidFile();
  if (verifyPidFileOwnership(existing) || await isPortInUse(port, host)) {
    process.exit(0);
  }
  const { createServerBetaService } = await import('./create-server-beta-service.js');
  const service = await createServerBetaService();
  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await service.start();
}

// Phase 10 — Postgres-backed `server api-key create|list|revoke` CLI. The
// legacy `worker-service.cjs server api-key` command talks to SQLite and
// is invisible to the server-beta runtime, which reads keys from
// Postgres. Use this entrypoint inside Docker / Compose.
// #2572 — wrong-runtime guard.
//
// The server-beta operability commands (`api-key`, `keys`, `jobs`) only make
// sense in the server-beta runtime, whose canonical store is Postgres. If they
// are invoked in a worker-only context — `CLAUDE_MEM_RUNTIME` set to `worker`,
// or no `CLAUDE_MEM_SERVER_DATABASE_URL` configured — we fail fast with an
// actionable message instead of crashing later with an opaque pool error.
export function assertServerRuntimeForCli(
  commandLabel: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const runtime = (env.CLAUDE_MEM_RUNTIME ?? '').trim().toLowerCase();
  if (runtime && runtime !== 'server-beta') {
    throw new Error(
      `\`server ${commandLabel}\` is a server-beta runtime command, but CLAUDE_MEM_RUNTIME=${runtime}. ` +
        'Set CLAUDE_MEM_RUNTIME=server-beta (and CLAUDE_MEM_SERVER_DATABASE_URL) to run server operations, ' +
        'or use the worker CLI (`worker-service ...`) for the worker runtime.',
    );
  }
  if (!(env.CLAUDE_MEM_SERVER_DATABASE_URL ?? '').trim()) {
    throw new Error(
      `CLAUDE_MEM_SERVER_DATABASE_URL is required for \`server ${commandLabel}\`. ` +
        'This command talks to the server-beta Postgres backend; export the connection string before running it.',
    );
  }
}

export async function runServerBetaApiKeyCli(argv: string[]): Promise<void> {
  const sub = argv[0]?.toLowerCase();
  const options = parseFlagArgs(argv.slice(1));

  try {
    assertServerRuntimeForCli('api-key');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  // #2560 — `api-key migrate-scopes <id>` brings a key's scope set up to a
  // working default (or an explicit --scope list). The pure helper
  // migrateServerApiKeyScopes() backs the SQLite path; here we apply the same
  // semantics against the Postgres `api_keys` table the server-beta runtime
  // reads from.
  if (sub === 'migrate-scopes') {
    await migrateServerBetaApiKeyScopes(argv.slice(1));
    return;
  }

  const { getSharedPostgresPool } = await import('../../storage/postgres/index.js');
  const { PostgresAuthRepository } = await import('../../storage/postgres/auth.js');
  const { createHash, randomBytes } = await import('crypto');
  const pool = getSharedPostgresPool({ requireDatabaseUrl: true });
  const repo = new PostgresAuthRepository(pool);

  try {
    if (sub === 'create') {
      const scopes = (options.scope ?? options.scopes ?? 'memories:read')
        .split(',')
        .map((scope: string) => scope.trim())
        .filter(Boolean);
      // Resolve team/project. If the caller passed --team/--project, honor
      // them. Otherwise, run the server-beta bootstrap to get-or-create the
      // local team+project, then create a NEW key against those IDs with
      // the caller's requested scopes (the bootstrap key uses hook scopes,
      // which is the wrong default for an arbitrary CLI-issued key).
      let teamId = options.team ?? null;
      let projectId = options.project ?? null;
      if (!teamId || !projectId) {
        const { bootstrapServerBetaApiKey } = await import('../../services/hooks/server-beta-bootstrap.js');
        const result = await bootstrapServerBetaApiKey({ pool, closePool: false });
        teamId = result.teamId;
        projectId = result.projectId;
      }
      const rawKey = `cmem_${randomBytes(24).toString('hex')}`;
      const keyHash = createHash('sha256').update(rawKey).digest('hex');
      const created = await repo.createApiKey({
        keyHash,
        teamId,
        projectId,
        scopes,
        actorId: 'system:server-beta-cli',
      });
      console.log(JSON.stringify({
        id: created.id,
        key: rawKey,
        name: options.name ?? 'server-api-key',
        teamId,
        projectId,
        scopes,
      }, null, 2));
      return;
    }

    if (sub === 'list') {
      // Bound the result set to prevent unintentional cross-tenant key
      // metadata disclosure when an admin runs `api-key list` on a shared
      // host. Default page is 100; --team filters to a single tenant.
      const teamFilter = options.team ?? null;
      const limitArg = Number.parseInt(options.limit ?? '100', 10);
      const offsetArg = Number.parseInt(options.offset ?? '0', 10);
      const limit = Number.isFinite(limitArg) && limitArg > 0 && limitArg <= 500
        ? limitArg
        : 100;
      const offset = Number.isFinite(offsetArg) && offsetArg >= 0 ? offsetArg : 0;
      const where = teamFilter ? 'WHERE team_id = $1' : '';
      const params: unknown[] = teamFilter ? [teamFilter, limit, offset] : [limit, offset];
      const limitIdx = teamFilter ? 2 : 1;
      const offsetIdx = teamFilter ? 3 : 2;
      const result = await pool.query<{
        id: string;
        team_id: string | null;
        project_id: string | null;
        scopes: unknown;
        revoked_at: Date | null;
        expires_at: Date | null;
        last_used_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, team_id, project_id, scopes, revoked_at, expires_at, last_used_at, created_at
         FROM api_keys
         ${where}
         ORDER BY created_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      );
      console.log(JSON.stringify({
        teamId: teamFilter,
        limit,
        offset,
        count: result.rows.length,
        keys: result.rows.map(row => ({
          id: row.id,
          teamId: row.team_id,
          projectId: row.project_id,
          scopes: row.scopes,
          status: row.revoked_at ? 'revoked' : 'active',
          lastUsedAt: row.last_used_at?.toISOString() ?? null,
          expiresAt: row.expires_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
        })),
      }, null, 2));
      return;
    }

    if (sub === 'revoke') {
      const id = argv[1];
      if (!id) {
        console.error('Usage: server-beta-service server api-key revoke <id>');
        process.exit(1);
      }
      const result = await pool.query(
        `UPDATE api_keys SET revoked_at = now()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id`,
        [id],
      );
      if (result.rowCount === 0) {
        console.error(`API key not found or already revoked: ${id}`);
        process.exit(1);
      }
      console.log(JSON.stringify({ id, status: 'revoked' }, null, 2));
      return;
    }

    console.error(`Unknown server api-key subcommand: ${sub ?? '(none)'}`);
    console.error('Usage: server-beta-service server api-key create|list|revoke|migrate-scopes');
    process.exit(1);
  } finally {
    // Pool is shared; do not close here. The process will exit and the
    // pool tears down via the shared module's process exit hook.
  }
}

// #2560 — Postgres scope migration. Mirrors migrateServerApiKeyScopes() (the
// SQLite helper) for the server-beta Postgres `api_keys` table: re-issues a
// key's scope set so an operator can bring legacy/empty-scope keys up to a
// working default (or an explicit --scope list). Defaults to the same
// read+write memory scopes the v1 routes require.
const DEFAULT_SERVER_KEY_SCOPES = ['memories:read', 'memories:write'];

export async function migrateServerBetaApiKeyScopes(argv: string[]): Promise<void> {
  const id = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
  const options = parseFlagArgs(argv);
  if (!id) {
    console.error('Usage: server-beta-service server api-key migrate-scopes <id> [--scope a,b]');
    process.exit(1);
  }
  const scopes = (options.scope ?? options.scopes ?? DEFAULT_SERVER_KEY_SCOPES.join(','))
    .split(',')
    .map(scope => scope.trim())
    .filter(Boolean);

  const { getSharedPostgresPool } = await import('../../storage/postgres/index.js');
  const pool = getSharedPostgresPool({ requireDatabaseUrl: true });
  const result = await pool.query<{ id: string; scopes: unknown }>(
    `UPDATE api_keys
       SET scopes = $2::jsonb, updated_at = now()
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING id, scopes`,
    [id, JSON.stringify(scopes)],
  );
  if (result.rowCount === 0) {
    console.error(`API key not found or revoked: ${id}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ id, scopes, status: 'scopes-migrated' }, null, 2));
}

// #2572 — pure serialization for `server keys`. SECURITY: this is the ONLY
// shaping of a key row the `keys` command emits, and it deliberately copies
// only non-secret metadata — never `key_hash` or any raw key material. Exported
// so a test can prove no secret field can leak regardless of the input row.
export interface ServerKeyRow {
  id: string;
  team_id: string | null;
  project_id: string | null;
  scopes: unknown;
  expires_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  // A leaked/extra secret column should NEVER appear in the output.
  key_hash?: string;
}

export function serializeActiveServerKeyRow(row: ServerKeyRow): Record<string, unknown> {
  return {
    id: row.id,
    teamId: row.team_id,
    projectId: row.project_id,
    scopes: row.scopes,
    status: 'active',
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

// #2572 — `server keys`: list ACTIVE (non-revoked, non-expired) keys. NEVER
// prints the raw key or its hash — only non-secret metadata. This is a thin
// operator convenience over `api-key list` that filters to usable keys.
export async function runServerBetaKeysCli(argv: string[]): Promise<void> {
  try {
    assertServerRuntimeForCli('keys');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const options = parseFlagArgs(argv);
  const teamFilter = options.team ?? null;
  const limitArg = Number.parseInt(options.limit ?? '100', 10);
  const limit = Number.isFinite(limitArg) && limitArg > 0 && limitArg <= 500 ? limitArg : 100;

  const { getSharedPostgresPool } = await import('../../storage/postgres/index.js');
  const pool = getSharedPostgresPool({ requireDatabaseUrl: true });
  const where = teamFilter
    ? 'WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND team_id = $2'
    : 'WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())';
  const params: unknown[] = teamFilter ? [limit, teamFilter] : [limit];
  const result = await pool.query<{
    id: string;
    team_id: string | null;
    project_id: string | null;
    scopes: unknown;
    expires_at: Date | null;
    last_used_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, team_id, project_id, scopes, expires_at, last_used_at, created_at
       FROM api_keys
       ${where}
       ORDER BY created_at DESC
       LIMIT $1`,
    params,
  );
  // SECURITY: serializeActiveServerKeyRow omits key_hash and any raw key
  // material — only non-secret metadata is emitted.
  console.log(JSON.stringify({
    teamId: teamFilter,
    count: result.rows.length,
    keys: result.rows.map(serializeActiveServerKeyRow),
  }, null, 2));
}

// #2572 — `server jobs [list|inspect <id>]`: list or inspect queued generation
// jobs from the Postgres `observation_generation_jobs` table the server-beta
// runtime and its BullMQ workers share.
export async function runServerBetaJobsCli(argv: string[]): Promise<void> {
  try {
    assertServerRuntimeForCli('jobs');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const sub = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list').toLowerCase();

  const { getSharedPostgresPool } = await import('../../storage/postgres/index.js');
  const pool = getSharedPostgresPool({ requireDatabaseUrl: true });

  if (sub === 'inspect') {
    const id = argv[1];
    if (!id) {
      console.error('Usage: server-beta-service server jobs inspect <id>');
      process.exit(1);
    }
    const result = await pool.query(
      `SELECT id, project_id, team_id, source_type, source_id, status, attempts,
              max_attempts, created_at, completed_at, failed_at, last_error, payload
         FROM observation_generation_jobs WHERE id = $1`,
      [id],
    );
    if (result.rowCount === 0) {
      console.error(`Generation job not found: ${id}`);
      process.exit(1);
    }
    console.log(JSON.stringify(result.rows[0], null, 2));
    return;
  }

  // list (default)
  const options = parseFlagArgs(sub === 'list' ? argv.slice(1) : argv);
  const status = options.status ?? null;
  const limitArg = Number.parseInt(options.limit ?? '50', 10);
  const limit = Number.isFinite(limitArg) && limitArg > 0 && limitArg <= 500 ? limitArg : 50;
  const params: unknown[] = [limit];
  let where = '';
  if (status) {
    params.unshift(status);
    where = 'WHERE status = $1';
  }
  const limitIdx = params.length;
  const result = await pool.query<{
    id: string;
    project_id: string;
    team_id: string;
    source_type: string;
    status: string;
    attempts: number;
    created_at: Date;
  }>(
    `SELECT id, project_id, team_id, source_type, status, attempts, created_at
       FROM observation_generation_jobs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx}`,
    params,
  );
  console.log(JSON.stringify({
    status: status ?? 'any',
    count: result.rows.length,
    jobs: result.rows.map(row => ({
      id: row.id,
      projectId: row.project_id,
      teamId: row.team_id,
      sourceType: row.source_type,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at.toISOString(),
    })),
  }, null, 2));
}

function parseFlagArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const equalsIdx = arg.indexOf('=');
      if (equalsIdx > -1) {
        out[arg.slice(2, equalsIdx)] = arg.slice(equalsIdx + 1);
      } else {
        out[arg.slice(2)] = argv[i + 1] ?? '';
        i += 1;
      }
    }
  }
  return out;
}

// Phase 10 — generation-worker-only entrypoint. Starts BullMQ workers against
// the same Postgres + Valkey/Redis the HTTP server-beta service uses, but
// never opens an HTTP listener. In Compose this is a separate, horizontally
// scalable service. The HTTP server-beta service should run with
// CLAUDE_MEM_GENERATION_DISABLED=true so generation only happens in this
// process.
export async function runServerBetaGenerationWorker(): Promise<void> {
  const { validateServerBetaEnv, createServerBetaService } = await import('./create-server-beta-service.js');
  validateServerBetaEnv();
  // Build the service WITHOUT starting HTTP. We reuse createServerBetaService
  // for pool + bootstrap + queue + generation worker wiring, but never call
  // service.start(). Generation is enabled here even if env says
  // CLAUDE_MEM_GENERATION_DISABLED, because this IS the generation worker.
  delete process.env.CLAUDE_MEM_GENERATION_DISABLED;
  const service = await createServerBetaService();
  const state = service.getRuntimeState();
  logger.info('SYSTEM', 'Server beta generation worker started (no HTTP)', {
    pid: process.pid,
    queue: state.boundaries.queueManager,
    generation: state.boundaries.generationWorkerManager,
  });
  console.log(JSON.stringify({ status: 'worker-running', runtime: SERVER_BETA_RUNTIME, pid: process.pid }));

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await service.stop();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  // Block forever — Workers run in background via BullMQ. Without this the
  // process would exit and BullMQ jobs would never be consumed.
  await new Promise<void>(() => {});
}

function getServerBetaPort(): number {
  const parsed = Number.parseInt(process.env.CLAUDE_MEM_SERVER_PORT ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  // UID-derived default for multi-account isolation: two users on the same
  // host get distinct ports without explicit configuration. Containerized
  // deployments always pass CLAUDE_MEM_SERVER_PORT so this branch is local-only.
  return DEFAULT_SERVER_BETA_PORT + ((process.getuid?.() ?? 77) % 100);
}

function spawnServerBetaDaemon(port: number): number | undefined {
  const scriptPath = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [scriptPath, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    // Strip host CLI bleed-through (CLAUDE_CODE_*, including EFFORT_LEVEL) and
    // Anthropic credentials before handing env to the detached daemon. The
    // daemon re-reads credentials from ~/.claude-mem/.env at SDK spawn time.
    // See env-isolation discipline (#2357 / #2375).
    env: {
      ...sanitizeEnv(process.env),
      CLAUDE_MEM_SERVER_PORT: String(port),
    },
  });
  child.unref();
  return child.pid;
}

function writeServerBetaState(state: ServerBetaRuntimeState): void {
  mkdirSync(dirname(paths.serverBetaRuntime()), { recursive: true });
  const pidInfo: PidInfo = {
    pid: state.pid,
    port: state.port,
    startedAt: state.startedAt,
    startToken: captureProcessStartToken(state.pid) ?? undefined,
  };
  writeFileSync(paths.serverBetaPid(), JSON.stringify(pidInfo, null, 2));
  writeFileSync(paths.serverBetaPort(), `${state.port}\n`);
  writeFileSync(paths.serverBetaRuntime(), JSON.stringify(state, null, 2));
}

function readServerBetaPidFile(): PidInfo | null {
  if (!existsSync(paths.serverBetaPid())) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(paths.serverBetaPid(), 'utf-8')) as PidInfo;
  } catch {
    return null;
  }
}

function readServerBetaRuntimeState(): ServerBetaRuntimeState | null {
  if (!existsSync(paths.serverBetaRuntime())) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(paths.serverBetaRuntime(), 'utf-8')) as ServerBetaRuntimeState;
  } catch {
    return null;
  }
}

function removeServerBetaState(): void {
  rmSync(paths.serverBetaPid(), { force: true });
  rmSync(paths.serverBetaPort(), { force: true });
  rmSync(paths.serverBetaRuntime(), { force: true });
}

async function isPortInUse(port: number, host: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!verifyPidFileOwnership({ pid, port: 0, startedAt: '' })) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

if (process.argv[1]?.endsWith('ServerBetaService.ts') || process.argv[1]?.endsWith('server-beta-service.cjs')) {
  runServerBetaCli().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
