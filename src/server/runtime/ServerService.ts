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
import { ServerV1PostgresRoutes } from '../routes/v1/ServerV1PostgresRoutes.js';
import { SessionsObservationsAdapter } from '../compat/SessionsObservationsAdapter.js';
import { SessionsSummarizeAdapter } from '../compat/SessionsSummarizeAdapter.js';
import { ActiveServerQueueManager } from './ActiveServerQueueManager.js';
import type { ServerServiceGraph, ServerQueueLaneMetric } from './types.js';

// Phase 1d retains the persisted runtime literal `'server-beta'`. Renaming the
// constant here keeps the TS identifier modern while preserving wire/storage
// back-compat. Plan §1d will handle the literal migration.
const SERVER_RUNTIME = 'server-beta';
const DEFAULT_SERVER_HOST = '127.0.0.1';
const DEFAULT_SERVER_PORT = 37877;

export interface ServerServiceOptions {
  graph: ServerServiceGraph;
  host?: string;
  port?: number;
  persistRuntimeState?: boolean;
}

export interface ServerRuntimeState {
  runtime: typeof SERVER_RUNTIME;
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  bootstrap: ServerServiceGraph['postgres']['bootstrap'];
  boundaries: {
    queueManager: ReturnType<ServerServiceGraph['queueManager']['getHealth']>;
    generationWorkerManager: ReturnType<ServerServiceGraph['generationWorkerManager']['getHealth']>;
    providerRegistry: ReturnType<ServerServiceGraph['providerRegistry']['getHealth']>;
    eventBroadcaster: ReturnType<ServerServiceGraph['eventBroadcaster']['getHealth']>;
  };
}

class ServerRuntimeInfoRoutes implements RouteHandler {
  constructor(private readonly graph: ServerServiceGraph) {}

  setupRoutes(app: Application): void {
    app.get('/healthz', (_req, res) => {
      res.json({ status: 'ok', runtime: SERVER_RUNTIME });
    });

    // Phase 12 — `/v1/info` includes per-lane queue metrics so deploy probes
    // can read waiting/active/completed/failed/delayed/stalled without
    // hitting `/api/health`. Sampling is best-effort: a Redis blip surfaces
    // the lane with `unavailable: true` rather than crashing the route.
    app.get('/v1/info', async (_req, res) => {
      const queueLanes = await collectQueueLaneMetrics(this.graph);
      res.json({
        name: 'claude-mem-server',
        runtime: SERVER_RUNTIME,
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
  graph: ServerServiceGraph,
): Promise<ServerQueueLaneMetric[]> {
  const manager = graph.queueManager;
  if (!(manager instanceof ActiveServerQueueManager)) {
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

export class ServerService {
  private readonly graph: ServerServiceGraph;
  private readonly host: string;
  private readonly requestedPort: number;
  private boundPort: number | null = null;
  private readonly persistRuntimeState: boolean;
  private server: Server | null = null;
  private stopping = false;

  constructor(options: ServerServiceOptions) {
    this.graph = options.graph;
    this.host = options.host ?? process.env.CLAUDE_MEM_SERVER_HOST ?? DEFAULT_SERVER_HOST;
    this.requestedPort = options.port ?? getServerPort();
    this.persistRuntimeState = options.persistRuntimeState ?? true;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = new Server({
      getInitializationComplete: () => this.graph.postgres.bootstrap.initialized,
      getMcpReady: () => true,
      onShutdown: () => this.stop(),
      onRestart: async () => {
        await this.stop();
        await this.start();
      },
      workerPath: '',
      runtime: SERVER_RUNTIME,
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
    server.registerRoutes(new ServerRuntimeInfoRoutes(this.graph));
    const v1Routes = new ServerV1PostgresRoutes({
      pool: this.graph.postgres.pool,
      queueManager: this.graph.queueManager,
      authMode: this.graph.authMode === 'disabled' ? 'api-key' : this.graph.authMode,
      runtime: SERVER_RUNTIME,
      // Session policy is read inside the routes (default 'per-event' from
      // resolveSessionGenerationPolicy(), env-overridable via
      // CLAUDE_MEM_SERVER_SESSION_POLICY). We do not duplicate it here.
    });
    server.registerRoutes(v1Routes);

    // Phase 9 — legacy compatibility adapters. These translate the old
    // `/api/sessions/observations` and `/api/sessions/summarize` worker
    // routes to the canonical Server event/job model. They share the
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

    server.finalizeRoutes();

    await server.listen(this.requestedPort, this.host);
    this.server = server;
    this.boundPort = resolveBoundPort(server) ?? this.requestedPort;
    if (this.persistRuntimeState) {
      writeServerState(this.runtimeState());
    }
    logger.info('SYSTEM', 'Server started', { host: this.host, port: this.boundPort, pid: process.pid });
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
        removeServerState();
      }
      this.boundPort = null;
      this.stopping = false;
      logger.info('SYSTEM', 'Server stopped');
    }
  }

  getRuntimeState(): ServerRuntimeState {
    return this.runtimeState();
  }

  private runtimeState(): ServerRuntimeState {
    return {
      runtime: SERVER_RUNTIME,
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

export async function runServerServiceCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? '--daemon';
  const port = getServerPort();
  const host = process.env.CLAUDE_MEM_SERVER_HOST ?? DEFAULT_SERVER_HOST;

  // Phase 10: `claude-mem server worker [start|--daemon]` runs the BullMQ
  // generation worker as a foregrounded process — no HTTP server, no route
  // registration. In Compose this becomes a separately scaled service.
  if (command === 'worker') {
    const sub = (argv[1] ?? '--daemon').toLowerCase();
    if (sub === 'start' || sub === '--daemon' || sub === 'run') {
      await runServerGenerationWorker();
      return;
    }
    console.error('Usage: server-service worker start');
    process.exit(1);
  }

  // `server api-key` mirrors the worker-service tooling but writes to the
  // Postgres `api_keys` table the server runtime actually reads from.
  // The legacy worker-service CLI talks to SQLite and would be invisible
  // to this stack.
  if (command === 'server' && argv[1]?.toLowerCase() === 'api-key') {
    await runServerApiKeyCli(argv.slice(2));
    return;
  }

  switch (command) {
    case 'start': {
      const existing = readServerPidFile();
      if (verifyPidFileOwnership(existing)) {
        console.log(JSON.stringify({ status: 'ready', runtime: SERVER_RUNTIME, pid: existing.pid, port: existing.port }));
        return;
      }
      const daemonPid = spawnServerDaemon(port);
      if (daemonPid === undefined) {
        console.error('Failed to spawn server daemon.');
        process.exit(1);
      }
      console.log(JSON.stringify({ status: 'starting', runtime: SERVER_RUNTIME, pid: daemonPid, port }));
      return;
    }

    case 'stop': {
      const existing = readServerPidFile();
      if (!verifyPidFileOwnership(existing)) {
        removeServerState();
        console.log('Server is not running');
        return;
      }
      process.kill(existing.pid, 'SIGTERM');
      await waitForPidExit(existing.pid, 5000);
      removeServerState();
      console.log('Server stopped');
      return;
    }

    case 'restart': {
      await runServerServiceCli(['stop']);
      await runServerServiceCli(['start']);
      return;
    }

    case 'status': {
      const state = readServerRuntimeState();
      const pidInfo = readServerPidFile();
      if (state && verifyPidFileOwnership(pidInfo)) {
        console.log('Server is running');
        console.log(`  PID: ${state.pid}`);
        console.log(`  Port: ${state.port}`);
        console.log(`  Runtime: ${state.runtime}`);
        console.log(`  Started: ${state.startedAt}`);
      } else {
        console.log('Server is not running');
      }
      return;
    }

    case '--daemon': {
      const existing = readServerPidFile();
      if (verifyPidFileOwnership(existing) || await isPortInUse(port, host)) {
        process.exit(0);
      }
      const { createServerService } = await import('./create-server-service.js');
      const service = await createServerService();
      const shutdown = async () => {
        await service.stop();
        process.exit(0);
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
      await service.start();
      return;
    }

    default:
      console.error('Usage: server-service start|stop|restart|status');
      process.exit(1);
  }
}

// Phase 10 — Postgres-backed `server api-key create|list|revoke` CLI. The
// legacy `worker-service.cjs server api-key` command talks to SQLite and
// is invisible to the server runtime, which reads keys from Postgres. Use
// this entrypoint inside Docker / Compose.
export async function runServerApiKeyCli(argv: string[]): Promise<void> {
  const sub = argv[0]?.toLowerCase();
  const options = parseFlagArgs(argv.slice(1));

  if (!process.env.CLAUDE_MEM_SERVER_DATABASE_URL) {
    console.error('CLAUDE_MEM_SERVER_DATABASE_URL is required for `server api-key` commands.');
    process.exit(1);
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
      // them. Otherwise, run the server bootstrap to get-or-create the
      // local team+project, then create a NEW key against those IDs with
      // the caller's requested scopes (the bootstrap key uses hook scopes,
      // which is the wrong default for an arbitrary CLI-issued key).
      let teamId = options.team ?? null;
      let projectId = options.project ?? null;
      if (!teamId || !projectId) {
        const { bootstrapServerApiKey } = await import('../../services/hooks/server-bootstrap.js');
        const result = await bootstrapServerApiKey({ pool, closePool: false });
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
        actorId: 'system:server-cli',
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
        console.error('Usage: server-service server api-key revoke <id>');
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
    console.error('Usage: server-service server api-key create|list|revoke');
    process.exit(1);
  } finally {
    // Pool is shared; do not close here. The process will exit and the
    // pool tears down via the shared module's process exit hook.
  }
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
// the same Postgres + Valkey/Redis the HTTP server service uses, but
// never opens an HTTP listener. In Compose this is a separate, horizontally
// scalable service. The HTTP server service should run with
// CLAUDE_MEM_GENERATION_DISABLED=true so generation only happens in this
// process.
export async function runServerGenerationWorker(): Promise<void> {
  const { validateServerEnv, createServerService } = await import('./create-server-service.js');
  validateServerEnv();
  // Build the service WITHOUT starting HTTP. We reuse createServerService
  // for pool + bootstrap + queue + generation worker wiring, but never call
  // service.start(). Generation is enabled here even if env says
  // CLAUDE_MEM_GENERATION_DISABLED, because this IS the generation worker.
  delete process.env.CLAUDE_MEM_GENERATION_DISABLED;
  const service = await createServerService();
  const state = service.getRuntimeState();
  logger.info('SYSTEM', 'Server generation worker started (no HTTP)', {
    pid: process.pid,
    queue: state.boundaries.queueManager,
    generation: state.boundaries.generationWorkerManager,
  });
  console.log(JSON.stringify({ status: 'worker-running', runtime: SERVER_RUNTIME, pid: process.pid }));

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

function getServerPort(): number {
  const parsed = Number.parseInt(process.env.CLAUDE_MEM_SERVER_PORT ?? '', 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  // UID-derived default for multi-account isolation: two users on the same
  // host get distinct ports without explicit configuration. Containerized
  // deployments always pass CLAUDE_MEM_SERVER_PORT so this branch is local-only.
  return DEFAULT_SERVER_PORT + ((process.getuid?.() ?? 77) % 100);
}

function spawnServerDaemon(port: number): number | undefined {
  const scriptPath = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [scriptPath, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_MEM_SERVER_PORT: String(port),
    },
  });
  child.unref();
  return child.pid;
}

function writeServerState(state: ServerRuntimeState): void {
  mkdirSync(dirname(paths.serverRuntime()), { recursive: true });
  const pidInfo: PidInfo = {
    pid: state.pid,
    port: state.port,
    startedAt: state.startedAt,
    startToken: captureProcessStartToken(state.pid) ?? undefined,
  };
  writeFileSync(paths.serverPid(), JSON.stringify(pidInfo, null, 2));
  writeFileSync(paths.serverPort(), `${state.port}\n`);
  writeFileSync(paths.serverRuntime(), JSON.stringify(state, null, 2));
}

function readServerPidFile(): PidInfo | null {
  if (!existsSync(paths.serverPid())) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(paths.serverPid(), 'utf-8')) as PidInfo;
  } catch {
    return null;
  }
}

function readServerRuntimeState(): ServerRuntimeState | null {
  if (!existsSync(paths.serverRuntime())) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(paths.serverRuntime(), 'utf-8')) as ServerRuntimeState;
  } catch {
    return null;
  }
}

function removeServerState(): void {
  rmSync(paths.serverPid(), { force: true });
  rmSync(paths.serverPort(), { force: true });
  rmSync(paths.serverRuntime(), { force: true });
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

if (
  process.argv[1]?.endsWith('ServerService.ts') ||
  process.argv[1]?.endsWith('server-service.cjs') ||
  // Plan §1c line 149: keep fallback so installs still booting from the
  // pre-rename plugin cache (server-beta-service.cjs) continue to dispatch.
  process.argv[1]?.endsWith('ServerBetaService.ts') ||
  process.argv[1]?.endsWith('server-beta-service.cjs')
) {
  runServerServiceCli().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
