// SPDX-License-Identifier: Apache-2.0
//
// The wire gateway daemon (plan D2): its own Bun process, never the worker.
// Lifecycle copied from src/server/runtime/ServerService.ts (start/stop/
// restart/status, foreground loop with signals, PID/port/state files).
//
// CLI output goes through process.stdout/stderr.write: the console API is banned in
// src/ (tests/logger-usage-standards.test.ts) and in this folder (plan Phase 1).

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { Server } from 'bun';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import {
  DATA_DIR,
  USER_SETTINGS_PATH,
  WIRE_GATEWAY_FILE_MODE,
  ensureWireGatewayDirs,
  paths,
} from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import {
  captureProcessStartToken,
  createProcessRegistry,
  verifyPidFileOwnership,
  type PidInfo,
  type ProcessRegistry,
} from '../../supervisor/process-registry.js';
import { killProcessTree } from '../../shared/kill-process-tree.js';
import { formatHostForUrl } from '../../shared/worker-url.js';
import { spawnDaemon } from '../infrastructure/ProcessManager.js';
import { assertWireGatewayBun, loadWireGatewayConfig, type WireGatewayConfig } from './config.js';
import {
  WIRE_GATEWAY_IDENTITY_NAME,
  WIRE_GATEWAY_VERSION,
  createWireGatewayFetchHandler,
  jsonErrorResponse,
  wireGatewayIdentity,
} from './router.js';
import { installWireGatewayOsService, uninstallWireGatewayOsService } from './os-service.js';

// Bun.serve's idle timer, in seconds (max 255). It also bounds the wait before
// response headers; Phase 2 disables it per relayed request with
// server.timeout(req, 0). Report 08 §Q2.
const WIRE_GATEWAY_IDLE_TIMEOUT_SECONDS = 255;

// The CLI's `stop` waits for the daemon's drain plus this margin before it
// reports a failure (ServerService SERVER_STOP_EXIT_TIMEOUT_MS covers the same
// SIGTERM-to-exit window).
const STOP_EXIT_MARGIN_MS = 15_000;
const START_READY_TIMEOUT_MS = 10_000;
const DRAIN_POLL_INTERVAL_MS = 50;

const PROCESS_REGISTRY_ID = 'wire-gateway';

export interface WireGatewayServiceOptions {
  host: string;
  port: number;
  drainTimeoutMs: number;
  /** Write PID/port/state files and the process-registry entry. Off for in-process tests. */
  persistRuntimeState?: boolean;
  /** Test seam for the Bun gate; defaults to Bun.version. */
  bunVersion?: string;
  /**
   * Test seam: replaces the router (and the network guard inside it), so a
   * drain test can hold a request open before Phase 2's relay exists.
   */
  fetchHandler?: (request: Request, server: Server<undefined>) => Response | Promise<Response>;
}

export interface WireGatewayRuntimeState {
  name: typeof WIRE_GATEWAY_IDENTITY_NAME;
  version: string;
  instance: string;
  pid: number;
  port: number;
  host: string;
  startedAt: string;
}

export class WireGatewayService {
  private readonly options: WireGatewayServiceOptions;
  private readonly persistRuntimeState: boolean;
  private server: Server<undefined> | null = null;
  private processRegistry: ProcessRegistry | null = null;
  private stopPromise: Promise<void> | null = null;
  private startedAt: string | null = null;
  private draining = false;

  constructor(options: WireGatewayServiceOptions) {
    this.options = options;
    this.persistRuntimeState = options.persistRuntimeState ?? true;
  }

  async start(): Promise<void> {
    // Fail fast before anything binds (plan D10).
    assertWireGatewayBun(this.options.bunVersion ?? Bun.version);
    if (this.server) {
      return;
    }
    ensureWireGatewayDirs();

    const handleRequest = this.options.fetchHandler ?? createWireGatewayFetchHandler({ listenHost: this.options.host });
    this.draining = false;
    this.server = Bun.serve({
      hostname: this.options.host,
      port: this.options.port,
      idleTimeout: WIRE_GATEWAY_IDLE_TIMEOUT_SECONDS,
      fetch: (request, server) => {
        if (this.draining) {
          return jsonErrorResponse(503, 'api_error', 'the claude-mem wire gateway is shutting down; retry in a moment');
        }
        return handleRequest(request, server);
      },
      error(error) {
        logger.error('WIRE', 'Unhandled error in wire gateway request handler', {}, error);
        return jsonErrorResponse(500, 'api_error', 'the claude-mem wire gateway failed to handle this request');
      },
    });
    this.startedAt = new Date().toISOString();

    if (this.persistRuntimeState) {
      const state = this.runtimeState();
      writeWireGatewayState(state);
      this.processRegistry = createProcessRegistry(paths.wireGatewayProcessRegistry());
      this.processRegistry.register(PROCESS_REGISTRY_ID, {
        pid: process.pid,
        type: 'wire-gateway',
        startedAt: state.startedAt,
      });
      restrictToOwner(paths.wireGatewayProcessRegistry());
    }
    logger.info('WIRE', 'Wire gateway started', { host: this.options.host, port: this.port, pid: process.pid, version: WIRE_GATEWAY_VERSION });
  }

  /**
   * Stop accepting connections, let in-flight requests (streams included)
   * finish for up to drainTimeoutMs, then force-close what is left.
   */
  stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopPromise = this.drainAndClose().finally(() => {
        this.stopPromise = null;
      });
    }
    return this.stopPromise;
  }

  get port(): number {
    if (!this.server?.port) {
      throw new Error('Wire gateway is not listening');
    }
    return this.server.port;
  }

  get pendingRequests(): number {
    return this.server?.pendingRequests ?? 0;
  }

  getRuntimeState(): WireGatewayRuntimeState {
    return this.runtimeState();
  }

  private async drainAndClose(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    try {
      // Drain without server.stop(false): probed on Bun 1.3.9, a stop(true)
      // that follows stop(false) closes nothing, so a hung stream could never
      // be force-closed. The listener stays up and answers new requests 503
      // while in-flight ones finish; then stop(true) closes every connection.
      // https://bun.sh/docs/api/http#server-stop
      this.draining = true;
      const deadline = Date.now() + this.options.drainTimeoutMs;
      while (server.pendingRequests > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
      }
      if (server.pendingRequests > 0) {
        logger.warn('WIRE', 'Drain timeout reached; force-closing in-flight requests', {
          pendingRequests: server.pendingRequests,
          drainTimeoutMs: this.options.drainTimeoutMs,
        });
      }
      await server.stop(true);
    } finally {
      this.server = null;
      this.startedAt = null;
      this.draining = false;
      if (this.persistRuntimeState) {
        removeWireGatewayState();
        this.processRegistry?.unregister(PROCESS_REGISTRY_ID, process.pid);
        this.processRegistry = null;
        restrictToOwner(paths.wireGatewayProcessRegistry());
      }
      logger.info('WIRE', 'Wire gateway stopped');
    }
  }

  private runtimeState(): WireGatewayRuntimeState {
    return {
      ...wireGatewayIdentity(),
      pid: process.pid,
      port: this.port,
      host: this.options.host,
      startedAt: this.startedAt ?? new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// State files (ServerService writeServerState/readServerPidFile pattern)

function restrictToOwner(filePath: string): void {
  if (process.platform !== 'win32' && existsSync(filePath)) chmodSync(filePath, WIRE_GATEWAY_FILE_MODE);
}

function writePrivateFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: WIRE_GATEWAY_FILE_MODE });
  // writeFileSync's mode applies only when it creates the file.
  restrictToOwner(filePath);
}

function writeWireGatewayState(state: WireGatewayRuntimeState): void {
  ensureWireGatewayDirs();
  const pidInfo: PidInfo = {
    pid: state.pid,
    port: state.port,
    startedAt: state.startedAt,
    startToken: captureProcessStartToken(state.pid) ?? undefined,
  };
  writePrivateFile(paths.wireGatewayPid(), JSON.stringify(pidInfo, null, 2));
  writePrivateFile(paths.wireGatewayPort(), `${state.port}\n`);
  writePrivateFile(paths.wireGatewayRuntime(), JSON.stringify(state, null, 2));
}

function readJsonStateFile<T>(filePath: string, label: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('WIRE', `Failed to read wire gateway ${label}`, { path: filePath }, err);
    return null;
  }
}

export function readWireGatewayPidFile(): PidInfo | null {
  return readJsonStateFile<PidInfo>(paths.wireGatewayPid(), 'PID file');
}

export function readWireGatewayRuntimeState(): WireGatewayRuntimeState | null {
  return readJsonStateFile<WireGatewayRuntimeState>(paths.wireGatewayRuntime(), 'runtime state file');
}

function removeWireGatewayState(): void {
  rmSync(paths.wireGatewayPid(), { force: true });
  rmSync(paths.wireGatewayPort(), { force: true });
  rmSync(paths.wireGatewayRuntime(), { force: true });
}

/** The live gateway's PID info, or null when none of ours is running. */
function readRunningWireGatewayPid(): PidInfo | null {
  const pidInfo = readWireGatewayPidFile();
  return verifyPidFileOwnership(pidInfo) ? pidInfo : null;
}

// ---------------------------------------------------------------------------
// Lifecycle operations shared by the CLI and the worker's autostart

export type WireGatewayStartStatus = 'ready' | 'starting';

export interface WireGatewayStartResult {
  status: WireGatewayStartStatus;
  pid: number | undefined;
  port: number;
  version: string;
}

function wireGatewayScriptPath(): string {
  return typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
}

async function probeWireGatewayIdentity(host: string, port: number): Promise<{ version: string } | null> {
  try {
    const response = await fetch(`http://${formatHostForUrl(host)}:${port}/wire/identity`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return null;
    const body = await response.json() as { name?: unknown; version?: unknown };
    return body.name === WIRE_GATEWAY_IDENTITY_NAME && typeof body.version === 'string' ? { version: body.version } : null;
  } catch {
    // Not up yet (connection refused) or not ours; the caller polls until its deadline.
    return null;
  }
}

async function waitForWireGatewayIdentity(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeWireGatewayIdentity(host, port)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

/** Waits until the process the PID file names is gone; its start token guards against PID reuse. */
async function waitForPidExit(pidInfo: PidInfo, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!verifyPidFileOwnership(pidInfo)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Stop the running daemon and wait for its drain. Returns false when none was
 * running. Throws when the process outlives the drain window, leaving its PID
 * file in place so the next `start` cannot race a live daemon.
 */
export async function stopRunningWireGateway(drainTimeoutMs: number): Promise<boolean> {
  const existing = readRunningWireGatewayPid();
  if (!existing) {
    removeWireGatewayState();
    return false;
  }
  if (process.platform === 'win32') {
    // process.kill(pid, 'SIGTERM') is TerminateProcess on Windows: no graceful
    // drain exists there, so tree-kill like ServerService does.
    await killProcessTree(existing.pid);
  } else {
    process.kill(existing.pid, 'SIGTERM');
  }
  await waitForPidExit(existing, drainTimeoutMs + STOP_EXIT_MARGIN_MS);
  if (verifyPidFileOwnership(existing)) {
    throw new Error(`Wire gateway PID ${existing.pid} did not exit; leaving its PID file in place.`);
  }
  removeWireGatewayState();
  return true;
}

/**
 * Start the daemon in the background unless the same version already runs.
 * A running gateway of another version is drained and replaced.
 */
export async function startWireGatewayDaemon(
  config: WireGatewayConfig,
  scriptPath: string = wireGatewayScriptPath(),
): Promise<WireGatewayStartResult> {
  assertWireGatewayBun();

  const running = readRunningWireGatewayPid();
  if (running) {
    const state = readWireGatewayRuntimeState();
    if (state?.version === WIRE_GATEWAY_VERSION) {
      return { status: 'ready', pid: running.pid, port: running.port, version: WIRE_GATEWAY_VERSION };
    }
    logger.info('WIRE', 'Replacing a wire gateway of another version', { runningVersion: state?.version ?? 'unknown', version: WIRE_GATEWAY_VERSION });
    await stopRunningWireGateway(config.drainTimeoutMs);
  }

  ensureWireGatewayDirs();
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  // spawnDaemon sanitizes the env and runs `<bun> <script> --daemon`. It also
  // sets CLAUDE_MEM_WORKER_PORT to the port it is given; the gateway needs the
  // real worker port there (later phases call the worker), so pass it back.
  const pid = spawnDaemon(scriptPath, config.port, {
    CLAUDE_MEM_WORKER_PORT: settings.CLAUDE_MEM_WORKER_PORT,
    CLAUDE_MEM_WIRE_GATEWAY_PORT: String(config.port),
    CLAUDE_MEM_DATA_DIR: DATA_DIR,
  });
  if (pid === undefined) {
    throw new Error('Failed to spawn the wire gateway daemon.');
  }
  const ready = await waitForWireGatewayIdentity(config.host, config.port, START_READY_TIMEOUT_MS);
  // spawnDaemon returns 0 on Windows (Start-Process yields no pid).
  return { status: ready ? 'ready' : 'starting', pid: pid > 0 ? pid : undefined, port: config.port, version: WIRE_GATEWAY_VERSION };
}

/** Number of routes in routes.json; 0 when the file is absent; null when it cannot be read. */
export function countWireGatewayRoutes(routesPath: string = paths.wireGatewayRoutes()): number | null {
  if (!existsSync(routesPath)) {
    return 0;
  }
  try {
    const parsed = JSON.parse(readFileSync(routesPath, 'utf-8')) as { routes?: unknown };
    if (!parsed.routes || typeof parsed.routes !== 'object' || Array.isArray(parsed.routes)) {
      return null;
    }
    return Object.keys(parsed.routes).length;
  } catch (error) {
    logger.warn('WIRE', 'Failed to read wire gateway routes', { path: routesPath }, error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}

/**
 * Worker boot hook (plan D14): make sure the gateway runs while routes exist.
 * An unreadable routes.json counts as "routes may exist" (unknown is not
 * empty), so wired agents never lose their gateway to a corrupt file.
 */
export async function ensureWireGatewayRunning(scriptPath: string): Promise<void> {
  const config = loadWireGatewayConfig();
  if (!config.autostart) {
    return;
  }
  const routeCount = countWireGatewayRoutes();
  if (routeCount === 0) {
    return;
  }
  if (!existsSync(scriptPath)) {
    logger.warn('WIRE', 'Wire gateway script not found; not starting the gateway', { scriptPath });
    return;
  }
  const result = await startWireGatewayDaemon(config, scriptPath);
  logger.info('WIRE', 'Wire gateway ensured at worker boot', { ...result, routeCount: routeCount ?? 'unknown' });
}

// ---------------------------------------------------------------------------
// CLI

function writeStdoutLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function writeStderrLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Foreground run loop, used by `start --foreground` (the OS service) and the
 * internal `--daemon` child. A running gateway of the same version means there
 * is nothing to do (exit 0, so a KeepAlive/Restart=on-failure supervisor does
 * not respawn it); another version is drained and replaced.
 */
async function runWireGatewayForeground(config: WireGatewayConfig): Promise<void> {
  const running = readRunningWireGatewayPid();
  if (running && running.pid !== process.pid) {
    const state = readWireGatewayRuntimeState();
    if (state?.version === WIRE_GATEWAY_VERSION) {
      logger.info('WIRE', 'Wire gateway already running', { pid: running.pid, port: running.port });
      process.exit(0);
    }
    await stopRunningWireGateway(config.drainTimeoutMs);
  }

  const service = new WireGatewayService(config);
  // A failed drain is logged and exits non-zero instead of leaving an unhandled rejection.
  const shutdown = () => {
    service.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('WIRE', 'Wire gateway shutdown failed', {}, error instanceof Error ? error : new Error(String(error)));
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await service.start();
}

function printWireGatewayUsage(): void {
  writeStderrLine('Usage: wire-gateway-service <command>');
  writeStderrLine('  start              start the wire gateway in the background');
  writeStderrLine('  start --foreground run it in this process (what the OS service runs)');
  writeStderrLine('  stop               drain in-flight streams, then stop');
  writeStderrLine('  restart            stop, then start in the background');
  writeStderrLine('  status             print whether it runs, and where');
  writeStderrLine('  service install    start it at login (launchd, systemd --user, or a logon task)');
  writeStderrLine('  service uninstall  remove that login item');
}

export async function runWireGatewayServiceCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  const config = loadWireGatewayConfig();

  switch (command) {
    case 'start': {
      if (argv.slice(1).includes('--foreground')) {
        await runWireGatewayForeground(config);
        return;
      }
      const result = await startWireGatewayDaemon(config);
      writeStdoutLine(JSON.stringify(result));
      return;
    }

    case '--daemon': {
      // Internal entrypoint of the detached child spawned by `start`.
      await runWireGatewayForeground(config);
      return;
    }

    case 'stop': {
      const stopped = await stopRunningWireGateway(config.drainTimeoutMs);
      writeStdoutLine(stopped ? 'Wire gateway stopped' : 'Wire gateway is not running');
      return;
    }

    case 'restart': {
      await stopRunningWireGateway(config.drainTimeoutMs);
      const result = await startWireGatewayDaemon(config);
      writeStdoutLine(JSON.stringify(result));
      return;
    }

    case 'status': {
      const running = readRunningWireGatewayPid();
      const state = readWireGatewayRuntimeState();
      if (running && state) {
        writeStdoutLine('Wire gateway is running');
        writeStdoutLine(`  PID: ${state.pid}`);
        writeStdoutLine(`  Address: http://${formatHostForUrl(state.host)}:${state.port}`);
        writeStdoutLine(`  Version: ${state.version}`);
        writeStdoutLine(`  Started: ${state.startedAt}`);
      } else {
        writeStdoutLine('Wire gateway is not running');
      }
      return;
    }

    case 'service': {
      const action = argv[1];
      if (action === 'install') {
        writeStdoutLine(installWireGatewayOsService({ bunPath: process.execPath, scriptPath: wireGatewayScriptPath() }));
        return;
      }
      if (action === 'uninstall') {
        writeStdoutLine(uninstallWireGatewayOsService());
        return;
      }
      printWireGatewayUsage();
      process.exitCode = 1;
      return;
    }

    default:
      printWireGatewayUsage();
      process.exitCode = 1;
  }
}

if (
  process.argv[1]?.endsWith('WireGatewayService.ts') ||
  process.argv[1]?.endsWith('wire-gateway-service.cjs')
) {
  runWireGatewayServiceCli().catch(error => {
    writeStderrLine(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
