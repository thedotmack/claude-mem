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
  wireGatewaySubdirPath,
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
import {
  WIRE_GATEWAY_STOP_EXIT_MARGIN_MS,
  installWireGatewayOsService,
  uninstallWireGatewayOsService,
} from './os-service.js';
import {
  WireGatewayRoutesStore,
  addWireGatewayRoute,
  readWireGatewayRoutesFile,
  removeWireGatewayRoute,
  type WireGatewayCaptureSource,
} from './routes.js';
import { isLoopbackAddress } from './network-guard.js';
import { createWireGatewayRelay, relayActivityCounts, type RelayObserver } from './relay/relay.js';
import { WireLaunchRegistry } from './identity/launch-registry.js';
import { DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS } from './relay/request-body.js';
import { createWireCapturePipeline, type WireCapturePipeline, type WireCapturePipelineOptions } from './capture/capture-pipeline.js';
import { wireCaptureEventActivity } from './capture/capture-event-sink.js';
import { RECORDED_STORE_SOFT_CAP_BYTES } from './capture/turn-recorder.js';
import {
  FileWireRecordingConsent,
  clearWireRecordings,
  readWireRecordingConsentFile,
  setWireRecordingConsent,
} from './privacy/recording-consent.js';
import { OutboundRedactionPlaceholders } from './privacy/outbound-redaction.js';
import { captureEvent, shutdownTelemetry } from '../telemetry/telemetry.js';
import { runWireAgentCli, type WireAgentCliRuntime } from './wiring/wire-agent-cli.js';
import { requestJsonDirectly } from './direct-http.js';
import { defaultWiringDirectory } from './wiring/wiring-records.js';
import { currentAgentEnvironment } from './agents/agent-paths.js';
import { loadAgentRegistry } from './agents/agent-registry.js';
import type { AgentEnvironment } from './agents/types.js';
import { AgentLastSeenTracker, readLastSeenFile, type LastSeenFileReadResult } from './drift/last-seen.js';
import { ProbeAnswerCache, probeLookupFor, type ProbeLookup } from './drift/reachability.js';
import {
  evaluateWireAgentStatuses,
  formatWireStatusReport,
  type WireAgentStatusInputs,
  type WireStatusReport,
} from './drift/agent-status.js';

const DEFAULT_RETENTION_DAYS = 7;

// Bun.serve's idle timer, in seconds (max 255). It also bounds the wait before
// response headers; the relay disables it per relayed request with
// server.timeout(req, 0). Report 08 §Q2.
const WIRE_GATEWAY_IDLE_TIMEOUT_SECONDS = 255;

const START_READY_TIMEOUT_MS = 10_000;
const DRAIN_POLL_INTERVAL_MS = 50;

const PROCESS_REGISTRY_ID = 'wire-gateway';

/** The content-free `wire_gateway_started` event repeats once a day with its counters (like worker_started). */
const TELEMETRY_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface WireGatewayServiceOptions {
  host: string;
  port: number;
  drainTimeoutMs: number;
  /** CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES. */
  maxRequestBytes: number;
  /** A request body silent this long is answered 408. Test seam; defaults to 60 s. */
  requestBodyIdleTimeoutMs?: number;
  /** Test seam: routes.json path; defaults to <DATA_DIR>/wire-gateway/routes.json. */
  routesFilePath?: string;
  /** Test seam: how often routes.json's stamp is looked at; defaults to once a second. */
  routesReloadCheckIntervalMs?: number;
  /** Days of raw recordings kept (CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS); defaults to 7. */
  retentionDays?: number;
  /** CLAUDE_MEM_WIRE_GATEWAY_RECORDING=false: raw recording stays off whatever consent.json says. */
  recordingForcedOff?: boolean;
  /** CLAUDE_MEM_WIRE_GATEWAY_OUTBOUND_REDACTION: routes without their own setting mask secrets outbound. */
  outboundRedaction?: boolean;
  /** Test seam: the placeholder table; defaults to one keyed by <DATA_DIR>/wire-gateway/redact.key. */
  outboundRedactionPlaceholders?: OutboundRedactionPlaceholders;
  /**
   * Test seam: replaces the capture pipeline (recorder, assembler, turn
   * tracker) with this observer; nothing is then captured.
   */
  relayObserver?: RelayObserver;
  /** Test seams for the capture pipeline (its event sink, recording consent, timers). */
  capture?: Partial<WireCapturePipelineOptions>;
  /** Test seam: Bun.serve's idle timer in seconds; defaults to 255. */
  idleTimeoutSeconds?: number;
  /** Write PID/port/state files and the process-registry entry. Off for in-process tests. */
  persistRuntimeState?: boolean;
  /** Test seam for the Bun gate; defaults to Bun.version. */
  bunVersion?: string;
  /**
   * Test seam: replaces the router (and the network guard inside it), so a
   * drain test can hold a request open before Phase 2's relay exists.
   */
  fetchHandler?: (request: Request, server: Server<undefined>) => Response | Promise<Response>;
  /** Test seams for GET /wire/status: where the drift checks look. Default to the real data dir and home. */
  status?: {
    lastSeenFilePath?: string;
    wiringDirectory?: string;
    agentEnvironment?: AgentEnvironment;
    userAgentsDirectory?: string;
  } & Pick<WireAgentStatusInputs, 'probeIdentity' | 'probeThroughProxy' | 'readSystemProxy'>;
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
  /** What this instance wrote to the PID file; stop removes the state files only while they still say this. */
  private writtenPidInfo: PidInfo | null = null;
  private stopPromise: Promise<void> | null = null;
  private startedAt: string | null = null;
  private draining = false;
  /** Recorder, assembler and turn tracker; null while stopped or when a test replaced the observer. */
  private capturePipeline: WireCapturePipeline | null = null;
  /** Launcher sessions live as long as the process (Phase 4 task 10). */
  private readonly launchRegistry = new WireLaunchRegistry();
  /** Placeholders live as long as the process; requests bring their values back after a restart. */
  private readonly outboundRedactionPlaceholders: OutboundRedactionPlaceholders;
  private telemetryHeartbeat: ReturnType<typeof setInterval> | null = null;
  /** When each agent's last request arrived (Phase 9 task 1); persisted while runtime state is. */
  readonly agentLastSeen: AgentLastSeenTracker;
  /** Reachability answers for GET /wire/status, refreshed in the background. */
  private readonly statusProbeAnswers = new ProbeAnswerCache();

  constructor(options: WireGatewayServiceOptions) {
    this.options = options;
    this.persistRuntimeState = options.persistRuntimeState ?? true;
    this.agentLastSeen = new AgentLastSeenTracker({ filePath: options.status?.lastSeenFilePath });
    // The key file is read (or written) on first use only.
    this.outboundRedactionPlaceholders = options.outboundRedactionPlaceholders ?? new OutboundRedactionPlaceholders();
  }

  async start(): Promise<void> {
    // Fail fast before anything binds (plan D10).
    assertWireGatewayBun(this.options.bunVersion ?? Bun.version);
    if (this.server) {
      return;
    }
    ensureWireGatewayDirs();

    this.capturePipeline = this.options.relayObserver
      ? null
      : createWireCapturePipeline({
        retentionDays: this.options.retentionDays ?? DEFAULT_RETENTION_DAYS,
        consent: new FileWireRecordingConsent({ recordingForcedOff: this.options.recordingForcedOff ?? false }),
        ...this.options.capture,
      });
    const relay = createWireGatewayRelay({
      routesStore: new WireGatewayRoutesStore({
        routesFilePath: this.options.routesFilePath,
        reloadCheckIntervalMs: this.options.routesReloadCheckIntervalMs,
      }),
      maxRequestBytes: this.options.maxRequestBytes,
      requestBodyIdleTimeoutMs: this.options.requestBodyIdleTimeoutMs ?? DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS,
      observer: this.options.relayObserver ?? this.capturePipeline?.relayObserver,
      launchRegistry: this.launchRegistry,
      outboundRedaction: {
        placeholders: this.outboundRedactionPlaceholders,
        enabledByDefault: this.options.outboundRedaction ?? false,
      },
      noteRequestFromAgent: agentId => this.agentLastSeen.noteRequestFromAgent(agentId),
    });
    const handleRequest = this.options.fetchHandler
      ?? createWireGatewayFetchHandler({
        listenHost: this.options.host,
        relay,
        launchRegistry: this.launchRegistry,
        statusReport: () => this.statusReport(),
      });
    this.draining = false;
    this.server = Bun.serve({
      hostname: this.options.host,
      port: this.options.port,
      idleTimeout: this.options.idleTimeoutSeconds ?? WIRE_GATEWAY_IDLE_TIMEOUT_SECONDS,
      // Bun answers a Content-Length over this with its own 413 before the
      // handler runs, so it sits above the relay's limit: the relay enforces
      // the real one (chunked bodies too) and answers in the agent's protocol.
      maxRequestBodySize: this.options.maxRequestBytes * 2,
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
    if (this.persistRuntimeState || this.options.status?.lastSeenFilePath) this.agentLastSeen.startPersisting();

    if (this.persistRuntimeState) {
      const state = this.runtimeState();
      this.writtenPidInfo = writeWireGatewayState(state);
      this.processRegistry = createProcessRegistry(paths.wireGatewayProcessRegistry());
      this.processRegistry.register(PROCESS_REGISTRY_ID, {
        pid: process.pid,
        type: 'wire-gateway',
        startedAt: state.startedAt,
      });
      restrictToOwner(paths.wireGatewayProcessRegistry());
      this.startTelemetry();
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

  /**
   * Content-free telemetry (plan Phase 6 task 4): counters and flags only,
   * never bodies, URLs, paths or headers. captureEvent applies the consent
   * chain and the property whitelist (telemetry/scrub.ts).
   */
  private startTelemetry(): void {
    const routeCount = countWireGatewayRoutes();
    captureEvent('wire_gateway_started', {
      trigger: 'start',
      ...(routeCount !== null ? { wire_routes_count: routeCount } : {}),
    });
    this.telemetryHeartbeat = setInterval(() => {
      const heartbeatRouteCount = countWireGatewayRoutes();
      captureEvent('wire_gateway_started', {
        trigger: 'heartbeat',
        ...(heartbeatRouteCount !== null ? { wire_routes_count: heartbeatRouteCount } : {}),
        wire_requests_relayed_count: relayActivityCounts.exchangesRelayed,
        wire_capture_events_count: wireCaptureEventActivity.eventsSpooled,
        wire_rewrites_applied_count: relayActivityCounts.requestsRewritten,
      });
    }, TELEMETRY_HEARTBEAT_INTERVAL_MS);
    this.telemetryHeartbeat.unref?.();
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

  /**
   * GET /wire/status: every agent's drift state from this process's view —
   * in-memory lastSeen, cached probe answers (a missing or stale one is
   * started in the background and reads as `unknown` until it lands).
   */
  async statusReport(): Promise<WireStatusReport> {
    const origin = `http://${formatHostForUrl(this.options.host)}:${this.port}`;
    const status = this.options.status ?? {};
    return buildWireStatusReport({
      gateway: { origin, running: true, version: WIRE_GATEWAY_VERSION, startedAt: this.startedAt ?? undefined },
      capture: this.capturePipeline ? { unattributedEventCount: this.capturePipeline.assembler.unattributedEventCount } : null,
      environment: status.agentEnvironment ?? currentAgentEnvironment(),
      wiringDirectory: status.wiringDirectory ?? defaultWiringDirectory(),
      routesFilePath: this.options.routesFilePath ?? paths.wireGatewayRoutes(),
      userAgentsDirectory: status.userAgentsDirectory,
      lastSeen: { kind: 'read', lastSeenByAgent: this.agentLastSeen.snapshot() },
      gatewayStartedAt: this.startedAt ? Date.parse(this.startedAt) : null,
      lookupProbe: probeLookupFor(this.statusProbeAnswers, 'cached-only'),
      probeIdentity: status.probeIdentity,
      probeThroughProxy: status.probeThroughProxy,
      readSystemProxy: status.readSystemProxy,
    });
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
      // After the drain, so in-flight exchanges were assembled; turn ends still in their quiet are dropped.
      this.capturePipeline?.dispose();
      this.capturePipeline = null;
      this.agentLastSeen.stopPersisting();
      if (this.persistRuntimeState || this.options.status?.lastSeenFilePath) this.agentLastSeen.flush();
      if (this.persistRuntimeState) {
        removeWireGatewayStateIfOwnedBy(this.writtenPidInfo);
        this.writtenPidInfo = null;
        this.processRegistry?.unregister(PROCESS_REGISTRY_ID, process.pid);
        this.processRegistry = null;
        restrictToOwner(paths.wireGatewayProcessRegistry());
        if (this.telemetryHeartbeat) clearInterval(this.telemetryHeartbeat);
        this.telemetryHeartbeat = null;
        await shutdownTelemetry();
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
// Status report (plan Phase 9), shared by GET /wire/status and `wire status`

interface WireStatusReportInputs extends Omit<WireAgentStatusInputs, 'descriptors' | 'gatewayOrigin' | 'lookupProbe'> {
  gateway: WireStatusReport['gateway'];
  capture: WireStatusReport['capture'];
  userAgentsDirectory?: string;
  lookupProbe: ProbeLookup;
}

export async function buildWireStatusReport(inputs: WireStatusReportInputs): Promise<WireStatusReport> {
  const registry = loadAgentRegistry({ userAgentsDirectory: inputs.userAgentsDirectory });
  const { agents, problems } = await evaluateWireAgentStatuses({
    ...inputs,
    gatewayOrigin: inputs.gateway.origin,
    descriptors: registry.descriptors,
  });
  return {
    generatedAt: new Date().toISOString(),
    gateway: inputs.gateway,
    capture: inputs.capture,
    problems: [...registry.refusals.map(refusal => `refused agent descriptor ${refusal}`), ...problems],
    agents,
  };
}

/** The running gateway's own report, for what only it knows (in-memory lastSeen, capture counters); null when it does not answer. */
export async function fetchRunningWireGatewayStatus(origin: string): Promise<WireStatusReport | null> {
  const answer = await requestJsonDirectly<WireStatusReport>({ url: `${origin}/wire/status`, timeoutMs: 2_000 });
  return answer?.statusCode === 200 ? answer.body : null;
}

/**
 * `claude-mem wire status`: the same report, with every probe waited for (a
 * CLI is not a request path). lastSeen and capture counters come from the
 * running gateway when it answers, else from state/last-seen.json.
 */
async function wireStatusReportForCli(config: WireGatewayConfig): Promise<WireStatusReport> {
  const running = readRunningWireGatewayPid();
  const state = running ? readWireGatewayRuntimeState() : null;
  const origin = `http://${formatHostForUrl(config.host)}:${config.port}`;
  const daemonReport = running ? await fetchRunningWireGatewayStatus(origin) : null;
  let lastSeen: LastSeenFileReadResult = readLastSeenFile();
  if (daemonReport) {
    const fromDaemon: Record<string, number> = lastSeen.kind === 'read' ? { ...lastSeen.lastSeenByAgent } : {};
    for (const agent of daemonReport.agents) {
      if (agent.lastSeenAt) fromDaemon[agent.agentId] = Math.max(fromDaemon[agent.agentId] ?? 0, Date.parse(agent.lastSeenAt));
    }
    lastSeen = { kind: 'read', lastSeenByAgent: fromDaemon };
  }
  return buildWireStatusReport({
    gateway: running && state
      ? { origin, running: true, version: state.version, startedAt: state.startedAt }
      : { origin, running: false },
    capture: daemonReport?.capture ?? null,
    environment: currentAgentEnvironment(),
    wiringDirectory: defaultWiringDirectory(),
    routesFilePath: paths.wireGatewayRoutes(),
    lastSeen,
    gatewayStartedAt: running && state ? Date.parse(state.startedAt) : null,
    lookupProbe: probeLookupFor(new ProbeAnswerCache(), 'wait'),
  });
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

function writeWireGatewayState(state: WireGatewayRuntimeState): PidInfo {
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
  return pidInfo;
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

function sameWireGatewayInstance(a: PidInfo, b: PidInfo): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt && a.startToken === b.startToken;
}

/**
 * Remove the PID/port/runtime files only while the PID file still names
 * `owner` (or is gone). A replacement that started in the meantime (worker
 * autostart, another `wire start`) has rewritten the PID file, and its state
 * stays. Returns whether the files were removed.
 */
export function removeWireGatewayStateIfOwnedBy(owner: PidInfo | null): boolean {
  const current = readWireGatewayPidFile();
  if (current && !(owner && sameWireGatewayInstance(current, owner))) {
    logger.debug('WIRE', 'Wire gateway state files belong to another instance; leaving them', { ownerPid: owner?.pid, currentPid: current.pid });
    return false;
  }
  rmSync(paths.wireGatewayPid(), { force: true });
  rmSync(paths.wireGatewayPort(), { force: true });
  rmSync(paths.wireGatewayRuntime(), { force: true });
  return true;
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

/** Never through a proxy (direct-http.ts). null: not up yet (connection refused) or not ours; the caller polls until its deadline. */
export async function probeWireGatewayIdentity(host: string, port: number): Promise<{ version: string } | null> {
  const answer = await requestJsonDirectly<{ name?: unknown; version?: unknown }>({
    url: `http://${formatHostForUrl(host)}:${port}/wire/identity`,
    timeoutMs: 1_000,
  });
  const body = answer?.statusCode === 200 ? answer.body : null;
  return body?.name === WIRE_GATEWAY_IDENTITY_NAME && typeof body.version === 'string' ? { version: body.version } : null;
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
  const recorded = readWireGatewayPidFile();
  const existing = verifyPidFileOwnership(recorded) ? recorded : null;
  if (!existing) {
    // Stale files from a gateway that died without cleanup.
    removeWireGatewayStateIfOwnedBy(recorded);
    return false;
  }
  if (process.platform === 'win32') {
    // process.kill(pid, 'SIGTERM') is TerminateProcess on Windows: no graceful
    // drain exists there, so tree-kill like ServerService does.
    await killProcessTree(existing.pid);
  } else {
    process.kill(existing.pid, 'SIGTERM');
  }
  await waitForPidExit(existing, drainTimeoutMs + WIRE_GATEWAY_STOP_EXIT_MARGIN_MS);
  if (verifyPidFileOwnership(existing)) {
    throw new Error(`Wire gateway PID ${existing.pid} did not exit; leaving its PID file in place.`);
  }
  removeWireGatewayStateIfOwnedBy(existing);
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
  try {
    return Object.keys(readWireGatewayRoutesFile(routesPath).routes).length;
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
  writeStderrLine('  status [--json]    print whether it runs, and each wired agent\'s state (ok, unwired, replaced,');
  writeStderrLine('                     unreachable, proxied, bypassed, unknown) with a fix');
  writeStderrLine('  service install    start it at login (launchd, systemd --user, or a logon task)');
  writeStderrLine('  service uninstall  remove that login item');
  writeStderrLine('  routes add <routeId> --agent <id> --upstream <url> [--capture wire|native]');
  writeStderrLine('                     relay http://<host>:<port>/r/<routeId>/… to <url>/…');
  writeStderrLine('  routes list        print every route');
  writeStderrLine('  routes remove <routeId>');
  writeStderrLine('  consent            print whether raw recording is on');
  writeStderrLine('  consent --record   turn raw recording on (needs a terminal)');
  writeStderrLine('  consent --off      turn raw recording off');
  writeStderrLine('  clear              delete every raw recording');
  writeStderrLine('  connect <agent> [--capture wire|native]');
  writeStderrLine('                     point the agent\'s base URLs at the gateway (and start it at login)');
  writeStderrLine('  disconnect <agent> put back what connect changed');
  writeStderrLine('  preview <agent> [--disconnect]');
  writeStderrLine('                     show what connect (or disconnect) would change, changing nothing');
  writeStderrLine('  run <agent> -- <args>');
  writeStderrLine('                     start the agent through a launcher session (env-only agents)');
}

/** The daemon lifecycle the wiring commands need (see wiring/wire-agent-cli.ts). */
function wireAgentCliRuntime(config: WireGatewayConfig): WireAgentCliRuntime {
  return {
    config,
    bunPath: process.execPath,
    scriptPath: wireGatewayScriptPath(),
    startDaemon: async () => {
      const result = await startWireGatewayDaemon(config);
      if (result.status !== 'ready') {
        throw new Error(`the wire gateway did not answer on port ${config.port} within ${START_READY_TIMEOUT_MS / 1000} s`);
      }
    },
    stopDaemon: async () => {
      await stopRunningWireGateway(config.drainTimeoutMs);
    },
    writeLine: writeStdoutLine,
    writeErrorLine: writeStderrLine,
  };
}

export interface WireConsentCliOptions {
  /** Whether a person is at the terminal; enabling needs one. */
  stdinIsTerminal: boolean;
  config: Pick<WireGatewayConfig, 'retentionDays' | 'recordingForcedOff'>;
  /** Test seams. */
  consentFilePath?: string;
  recordingsDirectory?: string;
  writeLine?: (line: string) => void;
  writeErrorLine?: (line: string) => void;
}

/**
 * `claude-mem wire consent [--record|--off]` (plan Phase 6 task 1). Turning
 * recording on needs a terminal, as `telemetry enable` does
 * (src/npx-cli/commands/telemetry.ts runTelemetryEnable), and first says what
 * is kept, where and for how long. Returns the exit code.
 */
export function runWireConsentCli(args: string[], options: WireConsentCliOptions): number {
  const writeLine = options.writeLine ?? writeStdoutLine;
  const writeErrorLine = options.writeErrorLine ?? writeStderrLine;
  const recordingsDirectory = options.recordingsDirectory ?? wireGatewaySubdirPath('recordings');
  const consentFilePath = options.consentFilePath ?? paths.wireGatewayConsent();

  if (args.includes('--record')) {
    if (!options.stdinIsTerminal) {
      writeErrorLine('wire consent --record needs an interactive terminal: recording is turned on only by a person who asked for it.');
      return 1;
    }
    writeLine('Raw wire recording keeps, on this computer only:');
    writeLine('  - the text of each exchange an agent sends through the wire gateway, and the reply');
    writeLine('    (secrets replaced by [REDACTED:KIND]; request and response headers are never kept)');
    writeLine(`  - in ${recordingsDirectory}`);
    writeLine(`  - for ${options.config.retentionDays} days (CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS), at most ${Math.round(RECORDED_STORE_SOFT_CAP_BYTES / (1024 * 1024))} MiB in all, oldest removed first`);
    writeLine('Memory capture into claude-mem works without it. Nothing is uploaded; cloud sync never reads it.');
    const consent = setWireRecordingConsent(true, consentFilePath);
    writeLine(`Raw wire recording is ON (generation ${consent.generation}).`);
    if (options.config.recordingForcedOff) {
      writeLine('CLAUDE_MEM_WIRE_GATEWAY_RECORDING=false is set, so nothing is recorded until it is removed.');
    }
    writeLine('Turn it off: claude-mem wire consent --off   Delete what was kept: claude-mem wire clear');
    return 0;
  }

  if (args.includes('--off')) {
    const consent = setWireRecordingConsent(false, consentFilePath);
    writeLine(`Raw wire recording is OFF (generation ${consent.generation}). What was already kept stays until it ages out or: claude-mem wire clear`);
    return 0;
  }

  if (args.length > 0) {
    writeErrorLine('Usage: wire consent [--record|--off]');
    return 1;
  }

  const consent = readWireRecordingConsentFile(consentFilePath);
  const on = consent?.recording === true && !options.config.recordingForcedOff;
  writeLine(`Raw wire recording: ${on ? 'ON' : 'OFF'}`);
  if (options.config.recordingForcedOff) writeLine('  Forced off by CLAUDE_MEM_WIRE_GATEWAY_RECORDING=false');
  writeLine(`  Decided: ${consent?.decidedAt || 'never (off until you run: claude-mem wire consent --record)'}`);
  writeLine(`  Kept in: ${recordingsDirectory}, ${options.config.retentionDays} days`);
  return 0;
}

/** `claude-mem wire clear`: delete every raw recording; in-flight saves are refused. */
export function runWireClearCli(options: { consentFilePath?: string; recordingsDirectory?: string; writeLine?: (line: string) => void } = {}): number {
  const writeLine = options.writeLine ?? writeStdoutLine;
  clearWireRecordings({ consentFilePath: options.consentFilePath, recordingsDirectory: options.recordingsDirectory });
  writeLine('Deleted every raw wire recording. Saves still in flight are refused.');
  writeLine('Memories that capture already created stay in claude-mem; manage those from the viewer or the memory tools.');
  return 0;
}

/** `--name value` pairs after the positional arguments. Throws on a flag with no value. */
function parseFlagValues(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} needs a value`);
    }
    flags[arg.slice(2)] = value;
    index++;
  }
  return { positional, flags };
}

/** A route whose upstream is this gateway would relay to itself forever. */
function assertUpstreamIsNotThisGateway(upstreamBaseUrl: string, config: WireGatewayConfig): void {
  let upstream: URL;
  try {
    upstream = new URL(upstreamBaseUrl);
  } catch {
    return; // addWireGatewayRoute reports the bad URL
  }
  const upstreamHost = upstream.hostname.replace(/^\[|\]$/g, '');
  const upstreamPort = upstream.port || (upstream.protocol === 'https:' ? '443' : '80');
  const pointsAtLoopback = upstreamHost === 'localhost' || isLoopbackAddress(upstreamHost);
  if (pointsAtLoopback && upstreamPort === String(config.port)) {
    throw new Error(`Upstream ${upstreamBaseUrl} is this wire gateway (port ${config.port}); a route must point at the provider.`);
  }
}

function runWireGatewayRoutesCli(args: string[], config: WireGatewayConfig): void {
  const action = args[0];
  const { positional, flags } = parseFlagValues(args.slice(1));

  if (action === 'add') {
    const routeId = positional[0];
    if (!routeId || !flags.agent || !flags.upstream) {
      throw new Error('Usage: routes add <routeId> --agent <id> --upstream <url> [--capture wire|native]');
    }
    const captureSource = flags.capture ?? 'wire';
    if (captureSource !== 'wire' && captureSource !== 'native') {
      throw new Error('--capture must be "wire" or "native"');
    }
    assertUpstreamIsNotThisGateway(flags.upstream, config);
    const route = addWireGatewayRoute({
      routeId,
      agentId: flags.agent,
      upstreamBaseUrl: flags.upstream,
      captureSource: captureSource as WireGatewayCaptureSource,
    });
    writeStdoutLine(`Route ${routeId} → ${route.upstreamBaseUrl} (agent ${route.agentId}, capture ${route.captureSource})`);
    writeStdoutLine(`  Base URL for the agent: http://${formatHostForUrl(config.host)}:${config.port}/r/${routeId}`);
    return;
  }

  if (action === 'list') {
    const routes = Object.entries(readWireGatewayRoutesFile().routes);
    if (routes.length === 0) {
      writeStdoutLine('No wire gateway routes');
      return;
    }
    for (const [routeId, route] of routes) {
      writeStdoutLine(`${routeId}  agent=${route.agentId}  capture=${route.captureSource}  upstream=${route.upstreamBaseUrl}`);
    }
    return;
  }

  if (action === 'remove') {
    const routeId = positional[0];
    if (!routeId) {
      throw new Error('Usage: routes remove <routeId>');
    }
    writeStdoutLine(removeWireGatewayRoute(routeId) ? `Removed route ${routeId}` : `No route ${routeId}`);
    return;
  }

  printWireGatewayUsage();
  process.exitCode = 1;
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
      const report = await wireStatusReportForCli(config);
      if (argv.slice(1).includes('--json')) {
        writeStdoutLine(JSON.stringify(report, null, 2));
        return;
      }
      const [headline, ...rest] = formatWireStatusReport(report);
      writeStdoutLine(headline);
      const running = readRunningWireGatewayPid();
      if (running && report.gateway.running) writeStdoutLine(`  PID: ${running.pid}`);
      for (const line of rest) writeStdoutLine(line);
      return;
    }

    case 'service': {
      const action = argv[1];
      if (action === 'install') {
        writeStdoutLine(installWireGatewayOsService({
          bunPath: process.execPath,
          scriptPath: wireGatewayScriptPath(),
          drainTimeoutMs: config.drainTimeoutMs,
        }));
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

    case 'routes': {
      runWireGatewayRoutesCli(argv.slice(1), config);
      return;
    }

    case 'consent': {
      process.exitCode = runWireConsentCli(argv.slice(1), { stdinIsTerminal: process.stdin.isTTY === true, config });
      return;
    }

    case 'clear': {
      process.exitCode = runWireClearCli();
      return;
    }

    case 'connect':
    case 'disconnect':
    case 'preview':
    case 'run': {
      process.exitCode = await runWireAgentCli(command, argv.slice(1), wireAgentCliRuntime(config));
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
