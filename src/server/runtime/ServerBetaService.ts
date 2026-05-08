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
import type { ServerBetaServiceGraph } from './types.js';

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

    app.get('/v1/info', (_req, res) => {
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
      });
    });
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
    });
    server.registerRoutes(new ServerBetaRuntimeInfoRoutes(this.graph));
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

export async function runServerBetaCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? '--daemon';
  const port = getServerBetaPort();
  const host = process.env.CLAUDE_MEM_SERVER_HOST ?? DEFAULT_SERVER_BETA_HOST;

  switch (command) {
    case 'start': {
      const existing = readServerBetaPidFile();
      if (verifyPidFileOwnership(existing)) {
        console.log(JSON.stringify({ status: 'ready', runtime: SERVER_BETA_RUNTIME, pid: existing.pid, port: existing.port }));
        return;
      }
      const daemonPid = spawnServerBetaDaemon(port);
      if (daemonPid === undefined) {
        console.error('Failed to spawn server beta daemon.');
        process.exit(1);
      }
      console.log(JSON.stringify({ status: 'starting', runtime: SERVER_BETA_RUNTIME, pid: daemonPid, port }));
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
      await runServerBetaCli(['stop']);
      await runServerBetaCli(['start']);
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
      return;
    }

    default:
      console.error('Usage: server-beta-service start|stop|restart|status');
      process.exit(1);
  }
}

function getServerBetaPort(): number {
  const parsed = Number.parseInt(process.env.CLAUDE_MEM_SERVER_PORT ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SERVER_BETA_PORT;
}

function spawnServerBetaDaemon(port: number): number | undefined {
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
