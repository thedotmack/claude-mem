// SPDX-License-Identifier: Apache-2.0
//
// The wire gateway daemon (plan D2): its own Bun process, never the worker.
// Lifecycle copied from src/server/runtime/ServerService.ts (start/stop/
// restart/status, foreground loop with signals, PID/port/state files).
//
// CLI output goes through process.stdout/stderr.write: the console API is banned in
// src/ (tests/logger-usage-standards.test.ts) and in this folder (plan Phase 1).

import { existsSync, rmSync } from 'fs';
import { homedir } from 'os';
import { resolve as resolvePath } from 'path';
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
import { pollUntil, readServiceStateFile, removeServiceState, restrictFileMode, waitForPidExit, writeServiceState, type ServiceStateFiles } from '../../shared/pid-state.js';
import {
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
  createWireTeamListenerFetchHandler,
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
  setWireGatewayRouteFeature,
  type WireGatewayCaptureSource,
} from './routes.js';
import { composeRelayObservers, createWireGatewayRelay, relayActivityCounts, type RelayObserver } from './relay/relay.js';
import { WireLaunchRegistry } from './identity/launch-registry.js';
import { DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS } from './relay/request-body.js';
import { createWireCapturePipeline, type WireCapturePipeline, type WireCapturePipelineOptions } from './capture/capture-pipeline.js';
import { createHookSpoolCaptureEventSink, createWorkerNudger, wireCaptureEventActivity } from './capture/capture-event-sink.js';
import { parseAllowList } from './shared/allow-list.js';
import { FailedKeyThrottle } from './shared/auth-throttle.js';
import { WireClientKeyStore, type WireClientKeyIdentity } from './shared/client-keys.js';
import { WireServerOutbox, serverOutboxActivity, type WireServerOutboxOptions } from './shared/server-outbox.js';
import { RefusalLogLimiter, sharedAdmissionActivity, type WireSharedMode } from './shared/shared-admission.js';
import { createSharedModeCaptureEventSink, isSessionCapturableInSharedMode } from './shared/shared-capture.js';
import { runWireKeysCli } from './shared/keys-cli.js';
import type { WireRecordingConsent } from './capture/turn-recorder.js';
import { PushEventLedger, createHookSpoolPushEventSpool, createPushEventsHandler, pushEventActivity, type PushEventSpool } from './ingest/push-events.js';
import { OtlpTraceReceiver, createOtlpTracesHandler, otlpActivity } from './ingest/otlp-receiver.js';
import { FOREIGN_SOURCE_SETTLE_MS, WireForeignCapture, foreignCaptureActivity, type CaptureSourceRuleOptions } from './ingest/foreign-capture.js';
import {
  MagpieRecordingsFollower,
  assertNotClaudeMemRecordings,
  defaultMagpieRecordingsDirectory,
  magpieFollowerActivity,
  magpieFollowerRequest,
  requestMagpieFollowerState,
} from './ingest/magpie-follower.js';
import { WireLiveTraceFeed, createLiveTraceHandlers } from './trace/live-trace-feed.js';
import { updateSettingsDocument } from '../../shared/settings-document.js';
import { RECORDED_STORE_SOFT_CAP_BYTES } from './capture/turn-recorder.js';
import {
  FileWireRecordingConsent,
  clearWireRecordings,
  readWireRecordingConsentFile,
  setWireRecordingConsent,
} from './privacy/recording-consent.js';
import { OutboundRedactionPlaceholders } from './privacy/outbound-redaction.js';
import { WireConversationLedger } from './ledger/conversation-ledger.js';
import { WireRewriteSeam, type WireRewriteStage } from './rewrite/rewrite-stage.js';
import { createEndlessModeStage } from './endless/endless-mode-stage.js';
import { createDurableHeaderStage, type DurableHeaderStageOptions } from './header/durable-header-stage.js';
import { WireObservationLookup } from './endless/observation-lookup.js';
import { formatEndlessModeReport, readEndlessModeReport } from './endless/endless-report.js';
import {
  CONTEXT_TIMEOUT_MS_SETTING,
  DEFAULT_CONTEXT_TIMEOUT_MS,
  createMemoryInjectionStage,
  type MemoryInjectionStageOptions,
} from './memory/memory-injection-stage.js';
import { createMemorySearchStage, type MemorySearchStageOptions } from './memory/memory-search-stage.js';
import { buildWireMemoryStatus, formatWireMemoryStatus, type WireMemoryStatus, type WireRouteFeaturesStatus } from './memory/memory-status.js';
import { createWireMcpHandler } from './mcp/mcp-http.js';
import { directHttpToolEnvironment } from './mcp/mcp-worker-environment.js';
import { captureEvent, shutdownTelemetry } from '../telemetry/telemetry.js';
import { runWireAgentCli, type WireAgentCliRuntime } from './wiring/wire-agent-cli.js';
import { requestJsonDirectly } from './direct-http.js';
import { defaultWiringDirectory } from './wiring/wiring-records.js';
import { currentAgentEnvironment } from './agents/agent-paths.js';
import { loadAgentRegistry } from './agents/agent-registry.js';
import type { AgentEnvironment } from './agents/types.js';
import { AgentLastSeenTracker, readLastSeenFile, type LastSeenFileReadResult } from './drift/last-seen.js';
import { ProbeAnswerCache, isLoopbackUrl, probeLookupFor, type ProbeLookup } from './drift/reachability.js';
import {
  evaluateWireAgentStatuses,
  formatWireIngestStatus,
  formatWireStatusReport,
  formatWireTeamStatus,
  withUrlSecretsMasked,
  type WireIngestStatus,
  type WireTeamStatus,
  type WireAgentStatusInputs,
  type WireStatusReport,
} from './drift/agent-status.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Bun.serve's idle timer, in seconds (max 255). It also bounds the wait before
// response headers; the relay disables it per relayed request with
// server.timeout(req, 0). Report 08 §Q2.
const WIRE_GATEWAY_IDLE_TIMEOUT_SECONDS = 255;

const START_READY_TIMEOUT_MS = 10_000;
const DRAIN_POLL_INTERVAL_MS = 50;

const PROCESS_REGISTRY_ID = 'wire-gateway';

/** Conversation ledgers past their retention are deleted at start and once a day. */
const CONVERSATION_LEDGER_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  /** Days of raw recordings kept (CLAUDE_MEM_WIRE_GATEWAY_RETENTION_DAYS). */
  retentionDays: number;
  /** CLAUDE_MEM_WIRE_GATEWAY_RECORDING=false: raw recording stays off whatever consent.json says. */
  recordingForcedOff?: boolean;
  /** CLAUDE_MEM_WIRE_GATEWAY_OUTBOUND_REDACTION: routes without their own setting mask secrets outbound. */
  outboundRedaction: boolean;
  /** CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS: forward subscription sign-ins instead of refusing them (D4). */
  forwardSubscriptionSignIns: boolean;
  /** Test seam: the placeholder table; defaults to one keyed by <DATA_DIR>/wire-gateway/redact.key. */
  outboundRedactionPlaceholders?: OutboundRedactionPlaceholders;
  /**
   * The rewrite stages, in request order (plan Phase 10). Absent: the
   * gateway's own, memory injection, Endless Mode and the hidden
   * memory_search tool (Phases 11–12), each on or off by its setting or a
   * route's feature.
   */
  rewriteStages?: WireRewriteStage[];
  /** Test seams for the memory stages (Phase 12) and the durable header: where context, rules and searches come from, keepalive pace, round cap. */
  memory?: {
    header?: Pick<DurableHeaderStageOptions, 'fetchHeader'>;
    injection?: Pick<MemoryInjectionStageOptions, 'fetchContext'>;
    search?: Pick<MemorySearchStageOptions, 'searcher' | 'keepaliveIntervalMs' | 'maxSearchRounds'>;
  };
  /** Serve claude-mem's MCP tools at /mcp (Phase 12). Defaults to on. */
  serveMcp?: boolean;
  /** Test seam: where Endless Mode learns which tool results have an observation; defaults to asking the worker. */
  observationLookup?: WireObservationLookup;
  /** The settings handed to rewrite stages (loadWireGatewayConfig's `rewriteSettings`). */
  rewriteSettings?: Readonly<Record<string, string>>;
  /** Test seam: the conversation ledger; defaults to one in <DATA_DIR>/wire-gateway/ledger. */
  conversationLedger?: WireConversationLedger;
  /**
   * Test seam: replaces the capture pipeline (recorder, assembler, turn
   * tracker) with this observer; nothing is then captured.
   */
  relayObserver?: RelayObserver;
  /** Test seams for the capture pipeline (its event sink, recording consent, timers). */
  capture?: Partial<WireCapturePipelineOptions>;
  /** Test seam: Bun.serve's idle timer in seconds; defaults to 255. */
  idleTimeoutSeconds?: number;
  /** CLAUDE_MEM_WIRE_GATEWAY_OTLP: serve POST /v1/traces (plan Phase 13 task 2). Defaults to on. */
  otlp?: boolean;
  /** CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR: follow magpie's recordings there (plan Phase 13 task 3); null or absent: off. */
  magpieRecordingsDirectory?: string | null;
  /** Test seams for the ways in from outside (plan Phase 13). */
  ingest?: {
    /** Where pushed events go; defaults to the hook spool plus a worker nudge. */
    pushSpool?: PushEventSpool;
    /** The accepted-event ledger; defaults to <DATA_DIR>/wire-gateway/state/push-events.jsonl. */
    pushLedgerFilePath?: string;
    /** The follower's state file and pace. */
    magpieStatePath?: string;
    magpiePollIntervalMs?: number;
    /** How long an OTLP delivery counts, and how long the follower waits before deciding a line (foreign-capture.ts). */
    foreignSourceSettleMs?: number;
    /** Where the one-source-per-agent rule looks (routes.json, agent descriptors, home). */
    captureSourceRule?: CaptureSourceRuleOptions;
  };
  /**
   * CLAUDE_MEM_WIRE_GATEWAY_SHARED (plan Phase 16): a second, team listener
   * (sharedHost:sharedPort) where other computers reach the relay with a
   * client key in the base URL, and their sessions' capture goes to each
   * key's claude-mem server runtime through the outbox. host:port stays the
   * loopback listener (this computer, no key).
   */
  shared?: boolean;
  /** CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST: the team listener's address. */
  sharedHost?: string;
  /** CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT: the team listener's port (0 picks one, for tests). */
  sharedPort?: number;
  /** CLAUDE_MEM_WIRE_GATEWAY_ALLOW_IPS (shared mode only). */
  allowIps?: string;
  /** Test seams for shared mode. */
  sharedMode?: {
    clientKeysFilePath?: string;
    outboxDirectory?: string;
    outbox?: Pick<WireServerOutboxOptions, 'send' | 'resolveHost' | 'retryBaseDelayMs' | 'retryMaxDelayMs' | 'tickIntervalMs' | 'retryWindowMs' | 'maxBytesPerKey' | 'maxBytesTotal'>;
    /** The team listener's socket peer address; defaults to server.requestIP. */
    peerAddressOf?: (request: Request, server: Server<undefined>) => string | null;
    throttle?: FailedKeyThrottle;
  };
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

/**
 * The stages the gateway runs, in request order (D7, plan Phase 10 task 1):
 * durable header → memory injection → Endless Mode → the memory_search
 * tool definition. The header goes before memory injection so the rules
 * sit before the timeline in the system prompt (Endless Mode v2 Phase 3).
 */
function defaultRewriteStages(
  observationLookup: WireObservationLookup,
  rewriteSettings: Readonly<Record<string, string>>,
  memory: WireGatewayServiceOptions['memory'] = {},
): WireRewriteStage[] {
  const contextTimeoutMs = Number(rewriteSettings[CONTEXT_TIMEOUT_MS_SETTING]) || DEFAULT_CONTEXT_TIMEOUT_MS;
  return [
    createDurableHeaderStage({ contextTimeoutMs, ...memory.header }),
    createMemoryInjectionStage({ contextTimeoutMs, ...memory.injection }),
    createEndlessModeStage({ observationLookup, contextTimeoutMs }),
    createMemorySearchStage({ ...memory.search }),
  ];
}

export interface WireGatewayRuntimeState {
  name: typeof WIRE_GATEWAY_IDENTITY_NAME;
  version: string;
  instance: string;
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  /** A shared gateway's team listener; absent on a single-user gateway. */
  sharedHost?: string;
  sharedPort?: number;
}

export class WireGatewayService {
  private readonly options: WireGatewayServiceOptions;
  private readonly persistRuntimeState: boolean;
  private server: Server<undefined> | null = null;
  /** A shared gateway's team listener (plan Phase 16); null otherwise. */
  private teamServer: Server<undefined> | null = null;
  private sharedMode: WireSharedMode | null = null;
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
  /**
   * Each client key's own placeholders (shared mode), by record id. Bounded
   * by keys.json: a namespace whose record is gone is let go when another is
   * made, and each holds at most OUTBOUND_REDACTION_MAX_HELD_VALUES values.
   */
  private readonly memberRedactionPlaceholders = new Map<string, { name: string; placeholders: OutboundRedactionPlaceholders }>();
  private telemetryHeartbeat: ReturnType<typeof setInterval> | null = null;
  /** When each agent's last request arrived (Phase 9 task 1); persisted while runtime state is. */
  readonly agentLastSeen: AgentLastSeenTracker;
  /** Reachability answers for GET /wire/status, refreshed in the background. */
  private readonly statusProbeAnswers = new ProbeAnswerCache();
  /** Every conversation's rewrites, kept across restarts (plan Phase 10 task 5). */
  readonly conversationLedger: WireConversationLedger;
  /** The rewrite stages and their health. */
  readonly rewriteSeam: WireRewriteSeam;
  /** Endless Mode's cache of which tool results have an observation, filled in the background. */
  readonly observationLookup: WireObservationLookup;
  private ledgerPruneTimer: ReturnType<typeof setInterval> | null = null;
  /** The live call feed behind GET /wire/trace and /wire/call (plan Phase 13 task 4); null while stopped. */
  liveTraceFeed: WireLiveTraceFeed | null = null;
  /** magpie's recordings, followed into capture (plan Phase 13 task 3); null when off or stopped. */
  magpieFollower: MagpieRecordingsFollower | null = null;
  /** Shared mode's outbox to the claude-mem server runtime (plan Phase 16); null when not shared or stopped. */
  serverOutbox: WireServerOutbox | null = null;

  constructor(options: WireGatewayServiceOptions) {
    this.options = options;
    this.persistRuntimeState = options.persistRuntimeState ?? true;
    this.agentLastSeen = new AgentLastSeenTracker({ filePath: options.status?.lastSeenFilePath });
    // The key file is read (or written) on first use only.
    this.outboundRedactionPlaceholders = options.outboundRedactionPlaceholders ?? new OutboundRedactionPlaceholders();
    this.conversationLedger = options.conversationLedger ?? new WireConversationLedger();
    this.observationLookup = options.observationLookup ?? new WireObservationLookup();
    this.rewriteSeam = new WireRewriteSeam({
      stages: options.rewriteStages ?? defaultRewriteStages(this.observationLookup, options.rewriteSettings ?? {}, options.memory),
    });
  }

  /** The host's placeholders for its own agents; a client key's own namespace for a member's request. */
  private outboundRedactionPlaceholdersFor(clientKey: WireClientKeyIdentity | null): OutboundRedactionPlaceholders {
    if (!clientKey) return this.outboundRedactionPlaceholders;
    const held = this.memberRedactionPlaceholders.get(clientKey.keyId);
    if (held) return held.placeholders;
    const clientKeys = this.sharedMode?.clientKeys;
    for (const [keyId, entry] of this.memberRedactionPlaceholders) {
      const lookup = clientKeys?.lookupByName(entry.name);
      if (lookup && (lookup.kind === 'absent' || (lookup.kind === 'found' && lookup.identity.keyId !== keyId))) this.memberRedactionPlaceholders.delete(keyId);
    }
    const placeholders = this.outboundRedactionPlaceholders.forNamespace(`client-key:${clientKey.keyId}`);
    this.memberRedactionPlaceholders.set(clientKey.keyId, { name: clientKey.name, placeholders });
    return placeholders;
  }

  async start(): Promise<void> {
    // Fail fast before anything binds (plan D10).
    assertWireGatewayBun(this.options.bunVersion ?? Bun.version);
    if (this.server) {
      return;
    }
    ensureWireGatewayDirs();
    // Fail fast, before any timer starts: following claude-mem's own recordings would capture them twice.
    if (this.options.magpieRecordingsDirectory) assertNotClaudeMemRecordings(this.options.magpieRecordingsDirectory);

    const retentionDays = this.options.retentionDays;
    const consent: WireRecordingConsent = this.options.capture?.consent
      ?? new FileWireRecordingConsent({ recordingForcedOff: this.options.recordingForcedOff ?? false });
    const liveTraceFeed = new WireLiveTraceFeed({ consent });
    this.liveTraceFeed = liveTraceFeed;
    // Shared mode (plan Phase 16): client keys, the outbox, and capture only of sessions the client named.
    const sharedSeams = this.options.sharedMode ?? {};
    const clientKeys = this.options.shared ? new WireClientKeyStore({ filePath: sharedSeams.clientKeysFilePath }) : null;
    if (clientKeys && !this.options.sharedPort && this.options.sharedPort !== 0) {
      throw new Error('a shared wire gateway needs CLAUDE_MEM_WIRE_GATEWAY_SHARED_PORT: the team listener');
    }
    this.serverOutbox = clientKeys
      ? new WireServerOutbox({
        directory: sharedSeams.outboxDirectory,
        lookupKey: name => clientKeys.lookupByName(name),
        retentionMs: retentionDays * DAY_MS,
        ...sharedSeams.outbox,
      })
      : null;
    this.sharedMode = clientKeys
      ? { allowList: parseAllowList(this.options.allowIps ?? ''), clientKeys, throttle: sharedSeams.throttle ?? new FailedKeyThrottle(), refusalLog: new RefusalLogLimiter() }
      : null;
    const sharedCapture: Partial<WireCapturePipelineOptions> = clientKeys && this.serverOutbox
      ? {
        isSessionCapturable: isSessionCapturableInSharedMode,
        eventSink: createSharedModeCaptureEventSink({
          localSink: this.options.capture?.eventSink ?? createHookSpoolCaptureEventSink(),
          outbox: this.serverOutbox,
          lookupKey: name => clientKeys.lookupByName(name),
        }),
      }
      : {};
    this.capturePipeline = this.options.relayObserver
      ? null
      : createWireCapturePipeline({
        retentionDays,
        consent,
        ...this.options.capture,
        ...sharedCapture,
        extraReplyConsumers: [liveTraceFeed.replyConsumer],
      });
    const relayObserver = this.options.relayObserver ?? this.capturePipeline?.relayObserver;
    const ingest = this.options.ingest ?? {};
    const pushEvents = createPushEventsHandler({
      spool: ingest.pushSpool ?? createHookSpoolPushEventSpool({ nudgeWorker: createWorkerNudger() }),
      ledger: new PushEventLedger(ingest.pushLedgerFilePath ?? paths.wireGatewayPushEventLedger(), retentionDays * DAY_MS),
      requestBodyIdleTimeoutMs: this.options.requestBodyIdleTimeoutMs,
    });
    // OTLP spans and magpie's recordings feed the relay's own assembler and turn tracker.
    const foreignCapture = this.capturePipeline
      ? new WireForeignCapture({ assembler: this.capturePipeline.assembler, turnTracker: this.capturePipeline.turnTracker, settleMs: ingest.foreignSourceSettleMs })
      : null;
    const otlpTraces = foreignCapture && (this.options.otlp ?? true)
      ? createOtlpTracesHandler({
        // Which copy of an exchange is taken (OTLP, recordings, the agent's own spans): foreign-capture.ts.
        receiver: new OtlpTraceReceiver(foreignCapture, ingest.captureSourceRule),
        requestBodyIdleTimeoutMs: this.options.requestBodyIdleTimeoutMs,
      })
      : undefined;
    if (foreignCapture && this.options.magpieRecordingsDirectory) {
      this.magpieFollower = new MagpieRecordingsFollower({
        directory: this.options.magpieRecordingsDirectory,
        capture: foreignCapture,
        statePath: ingest.magpieStatePath,
        pollIntervalMs: ingest.magpiePollIntervalMs,
        captureSourceRule: ingest.captureSourceRule,
      });
    }
    const relay = createWireGatewayRelay({
      routesStore: new WireGatewayRoutesStore({
        routesFilePath: this.options.routesFilePath,
        reloadCheckIntervalMs: this.options.routesReloadCheckIntervalMs,
      }),
      maxRequestBytes: this.options.maxRequestBytes,
      requestBodyIdleTimeoutMs: this.options.requestBodyIdleTimeoutMs ?? DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS,
      observer: relayObserver ? composeRelayObservers(relayObserver, liveTraceFeed.relayObserver) : liveTraceFeed.relayObserver,
      launchRegistry: this.launchRegistry,
      outboundRedaction: {
        placeholdersFor: clientKey => this.outboundRedactionPlaceholdersFor(clientKey),
        enabledByDefault: this.options.outboundRedaction,
      },
      noteRequestFromAgent: agentId => this.agentLastSeen.noteRequestFromAgent(agentId),
      forwardSubscriptionSignIns: this.options.forwardSubscriptionSignIns,
      rewriteSeam: this.rewriteSeam,
      conversationLedger: this.conversationLedger,
      rewriteSettings: this.options.rewriteSettings,
    });
    this.pruneConversationLedgers();
    this.ledgerPruneTimer = setInterval(() => this.pruneConversationLedgers(), CONVERSATION_LEDGER_PRUNE_INTERVAL_MS);
    this.ledgerPruneTimer.unref?.();
    const handleRequest = this.options.fetchHandler
      ?? createWireGatewayFetchHandler({
        listenHost: this.options.host,
        relay,
        launchRegistry: this.launchRegistry,
        statusReport: () => this.statusReport(),
        routesReport: () => buildWireRoutesReport(this.options.routesFilePath ?? paths.wireGatewayRoutes(), this.options.rewriteSettings ?? {}),
        pushEvents,
        otlpTraces,
        liveTrace: createLiveTraceHandlers(liveTraceFeed),
        mcp: this.options.serveMcp === false ? undefined : createWireMcpHandler({
          // Loaded on the first /mcp request: the table reads settings and the worker's script path.
          toolTable: () => import('../../servers/mcp-tool-table.js').then(table => table.buildClaudeMemToolTable(directHttpToolEnvironment())),
          version: WIRE_GATEWAY_VERSION,
        }),
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
    if (this.sharedMode) {
      const handleTeamRequest = createWireTeamListenerFetchHandler({ shared: this.sharedMode, relay, peerAddressOf: sharedSeams.peerAddressOf });
      try {
        this.teamServer = Bun.serve({
          hostname: this.options.sharedHost ?? '0.0.0.0',
          port: this.options.sharedPort ?? 0,
          idleTimeout: this.options.idleTimeoutSeconds ?? WIRE_GATEWAY_IDLE_TIMEOUT_SECONDS,
          maxRequestBodySize: this.options.maxRequestBytes * 2,
          fetch: (request, server) => {
            if (this.draining) {
              return jsonErrorResponse(503, 'api_error', 'the claude-mem wire gateway is shutting down; retry in a moment');
            }
            return handleTeamRequest(request, server);
          },
          error(error) {
            logger.error('WIRE', 'Unhandled error in wire gateway team listener handler', {}, error);
            return jsonErrorResponse(500, 'api_error', 'the claude-mem wire gateway failed to handle this request');
          },
        });
      } catch (error) {
        // Fail fast: a shared gateway without its team listener would serve nobody it was set up for.
        await this.server.stop(true);
        this.server = null;
        throw error;
      }
    }
    this.startedAt = new Date().toISOString();
    this.magpieFollower?.start();
    this.serverOutbox?.start();
    if (this.persistRuntimeState || this.options.status?.lastSeenFilePath) this.agentLastSeen.startPersisting();

    if (this.persistRuntimeState) {
      const state = this.runtimeState();
      ensureWireGatewayDirs();
      this.writtenPidInfo = writeServiceState(wireGatewayStateFiles(), state);
      this.processRegistry = createProcessRegistry(paths.wireGatewayProcessRegistry());
      this.processRegistry.register(PROCESS_REGISTRY_ID, {
        pid: process.pid,
        type: 'wire-gateway',
        startedAt: state.startedAt,
      });
      restrictFileMode(paths.wireGatewayProcessRegistry(), WIRE_GATEWAY_FILE_MODE);
      this.startTelemetry();
    }
    logger.info('WIRE', 'Wire gateway started', {
      host: this.options.host, port: this.port, pid: process.pid, version: WIRE_GATEWAY_VERSION, shared: this.options.shared === true,
      ...(this.teamServer ? { teamListener: `${formatHostForUrl(this.options.sharedHost ?? '0.0.0.0')}:${this.teamServer.port}` } : {}),
    });
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
    const emitStarted = (trigger: 'start' | 'heartbeat', counts: Record<string, number> = {}) => {
      const routeCount = countWireGatewayRoutes();
      captureEvent('wire_gateway_started', { trigger, ...(routeCount !== null ? { wire_routes_count: routeCount } : {}), ...counts });
    };
    emitStarted('start');
    this.telemetryHeartbeat = setInterval(() => emitStarted('heartbeat', {
      wire_requests_relayed_count: relayActivityCounts.exchangesRelayed,
      wire_capture_events_count: wireCaptureEventActivity.eventsSpooled,
      wire_rewrites_applied_count: relayActivityCounts.requestsRewritten,
    }), TELEMETRY_HEARTBEAT_INTERVAL_MS);
    this.telemetryHeartbeat.unref?.();
  }

  get port(): number {
    if (!this.server?.port) {
      throw new Error('Wire gateway is not listening');
    }
    return this.server.port;
  }

  /** The team listener's port (shared mode). */
  get sharedPort(): number {
    if (!this.teamServer?.port) {
      throw new Error('Wire gateway has no team listener');
    }
    return this.teamServer.port;
  }

  get pendingRequests(): number {
    return (this.server?.pendingRequests ?? 0) + (this.teamServer?.pendingRequests ?? 0);
  }

  /**
   * GET /wire/status: every agent's drift state from this process's view —
   * in-memory lastSeen, cached probe answers (a missing or stale one is
   * started in the background and reads as `unknown` until it lands).
   */
  async statusReport(): Promise<WireStatusReport> {
    const origin = `http://${formatHostForUrl(this.options.host)}:${this.port}`;
    const status = this.options.status ?? {};
    const report = await buildWireStatusReport({
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
    const memory = memoryStatusOf(this.options.routesFilePath ?? paths.wireGatewayRoutes(), this.options.rewriteSettings ?? {}, this.rewriteSeam.health.states());
    const ingest: WireIngestStatus = {
      push: { ...pushEventActivity },
      otlp: { enabled: (this.options.otlp ?? true) && this.capturePipeline !== null, ...otlpActivity },
      magpie: {
        directory: this.magpieFollower?.directory ?? null,
        ...magpieFollowerActivity,
        exchanges: foreignCaptureActivity.magpie.exchanges,
        skippedOtherSource: foreignCaptureActivity.magpie.skippedOtherSource,
      },
    };
    const team = this.teamStatus();
    return { ...report, ...(memory ? { memory } : {}), ingest, ...(team ? { team } : {}) };
  }

  /** `wire status`'s team section (shared mode): where members connect, and counts only. */
  private teamStatus(): WireTeamStatus | null {
    if (!this.teamServer || !this.sharedMode) return null;
    return {
      listener: `http://${formatHostForUrl(this.options.sharedHost ?? '0.0.0.0')}:${this.teamServer.port}`,
      clientKeys: this.sharedMode.clientKeys.keyCount(),
      admission: { ...sharedAdmissionActivity },
      outbox: { ...serverOutboxActivity, pending: this.serverOutbox?.pendingCount() ?? 0 },
    };
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
      this.liveTraceFeed?.releaseWaiters();
      const deadline = Date.now() + this.options.drainTimeoutMs;
      while (this.pendingRequests > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, DRAIN_POLL_INTERVAL_MS));
      }
      if (this.pendingRequests > 0) {
        logger.warn('WIRE', 'Drain timeout reached; force-closing in-flight requests', {
          pendingRequests: this.pendingRequests,
          drainTimeoutMs: this.options.drainTimeoutMs,
        });
      }
      await this.teamServer?.stop(true);
      await server.stop(true);
    } finally {
      this.server = null;
      this.teamServer = null;
      this.sharedMode?.refusalLog.flush();
      this.sharedMode = null;
      this.startedAt = null;
      this.draining = false;
      this.magpieFollower?.stop();
      this.magpieFollower = null;
      // Pending events stay on disk for the next start.
      await this.serverOutbox?.stop();
      this.serverOutbox = null;
      this.liveTraceFeed = null;
      // After the drain, so in-flight exchanges were assembled; turn ends still in their quiet are dropped.
      this.capturePipeline?.dispose();
      this.capturePipeline = null;
      if (this.ledgerPruneTimer) clearInterval(this.ledgerPruneTimer);
      this.ledgerPruneTimer = null;
      this.agentLastSeen.stopPersisting();
      if (this.persistRuntimeState || this.options.status?.lastSeenFilePath) this.agentLastSeen.flush();
      if (this.persistRuntimeState) {
        removeWireGatewayStateIfOwnedBy(this.writtenPidInfo);
        this.writtenPidInfo = null;
        this.processRegistry?.unregister(PROCESS_REGISTRY_ID, process.pid);
        this.processRegistry = null;
        restrictFileMode(paths.wireGatewayProcessRegistry(), WIRE_GATEWAY_FILE_MODE);
        if (this.telemetryHeartbeat) clearInterval(this.telemetryHeartbeat);
        this.telemetryHeartbeat = null;
        await shutdownTelemetry();
      }
      logger.info('WIRE', 'Wire gateway stopped');
    }
  }

  private pruneConversationLedgers(): void {
    try {
      const deleted = this.conversationLedger.pruneExpired();
      if (deleted > 0) logger.info('WIRE', 'Pruned expired conversation ledgers', { deleted });
    } catch (error) {
      logger.warn('WIRE', 'Could not prune conversation ledgers', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** What runtime.json says while this gateway runs. */
  runtimeState(): WireGatewayRuntimeState {
    return {
      ...wireGatewayIdentity(),
      pid: process.pid,
      port: this.port,
      host: this.options.host,
      startedAt: this.startedAt ?? new Date().toISOString(),
      ...(this.teamServer ? { sharedHost: this.options.sharedHost ?? '0.0.0.0', sharedPort: this.teamServer.port } : {}),
    };
  }
}

// ---------------------------------------------------------------------------
// Status report (plan Phase 9), shared by GET /wire/status and `wire status`

/** The memory features per route (plan Phase 12); null when routes.json cannot be read (unknown ≠ empty). */
function memoryStatusOf(
  routesFilePath: string,
  rewriteSettings: Readonly<Record<string, string>>,
  stages: WireMemoryStatus['stages'],
): WireMemoryStatus | null {
  try {
    return buildWireMemoryStatus(readWireGatewayRoutesFile(routesFilePath).routes, rewriteSettings, stages);
  } catch (error) {
    logger.debug('WIRE', 'No memory status: routes.json could not be read', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** One route as GET /wire/routes shows it: memory-status's feature switches plus where it goes. */
export interface WireRouteReport extends WireRouteFeaturesStatus {
  /** The upstream base URL as written, its user:password and secret-named query values masked (withUrlSecretsMasked; it is shown in the viewer). */
  upstream: string;
  createdAt: string;
}

/**
 * GET /wire/routes (plan Phase 15): every route, its upstream and its
 * feature switches as the gateway's settings decide them. Throws when
 * routes.json cannot be read: an unreadable file is never "no routes".
 */
export function buildWireRoutesReport(routesFilePath: string, rewriteSettings: Readonly<Record<string, string>>): { routes: WireRouteReport[] } {
  const routes = readWireGatewayRoutesFile(routesFilePath).routes;
  return {
    routes: buildWireMemoryStatus(routes, rewriteSettings, null).routes.map(features => {
      const route = routes[features.routeId];
      return { ...features, upstream: String(withUrlSecretsMasked(route.upstreamBaseUrl)), createdAt: route.createdAt };
    }),
  };
}

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

/**
 * How long a GET /wire/status to the running gateway may take: it answers from
 * cached probe answers and a few small files and never waits on a probe, so
 * anything slower means the gateway is stuck. Shared by `wire status` and the
 * viewer's proxy route.
 */
export const WIRE_STATUS_REQUEST_TIMEOUT_MS = 2_000;

/** The running gateway's own report, for what only it knows (in-memory lastSeen, capture counters); null when it does not answer. */
export async function fetchRunningWireGatewayStatus(origin: string): Promise<WireStatusReport | null> {
  const answer = await requestJsonDirectly<WireStatusReport>({ url: `${origin}/wire/status`, timeoutMs: WIRE_STATUS_REQUEST_TIMEOUT_MS });
  return answer?.statusCode === 200 ? answer.body : null;
}

/** Where `wire status` asks: the running gateway's own saved address, the configured one only when none runs. */
export function wireStatusGatewayOrigin(config: Pick<WireGatewayConfig, 'host' | 'port'>, runningState: Pick<WireGatewayRuntimeState, 'host' | 'port'> | null): string {
  const { host, port } = runningState ?? config;
  return `http://${formatHostForUrl(host)}:${port}`;
}

/**
 * `claude-mem wire status`: the same report, with every probe waited for (a
 * CLI is not a request path). lastSeen and capture counters come from the
 * running gateway when it answers, else from state/last-seen.json.
 */
async function wireStatusReportForCli(config: WireGatewayConfig): Promise<WireStatusReport> {
  const running = readRunningWireGatewayPid();
  const state = running ? readWireGatewayRuntimeState() : null;
  const origin = wireStatusGatewayOrigin(config, state);
  const daemonReport = running ? await fetchRunningWireGatewayStatus(origin) : null;
  let lastSeen: LastSeenFileReadResult = readLastSeenFile();
  if (daemonReport) {
    const fromDaemon: Record<string, number> = lastSeen.kind === 'read' ? { ...lastSeen.lastSeenByAgent } : {};
    for (const agent of daemonReport.agents) {
      if (agent.lastSeenAt) fromDaemon[agent.agentId] = Math.max(fromDaemon[agent.agentId] ?? 0, Date.parse(agent.lastSeenAt));
    }
    lastSeen = { kind: 'read', lastSeenByAgent: fromDaemon };
  }
  const report = await buildWireStatusReport({
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
  // The settings as this CLI reads them are what a gateway started now would use.
  const memory = memoryStatusOf(paths.wireGatewayRoutes(), config.rewriteSettings, daemonReport?.memory?.stages ?? null);
  return { ...report, ...(memory ? { memory } : {}), ...(daemonReport?.ingest ? { ingest: daemonReport.ingest } : {}), ...(daemonReport?.team ? { team: daemonReport.team } : {}) };
}

// ---------------------------------------------------------------------------
// State files (ServerService writeServerState/readServerPidFile pattern)

/** Paths read on each use: tests and the CLI point CLAUDE_MEM_DATA_DIR elsewhere. */
function wireGatewayStateFiles(): ServiceStateFiles {
  return { pidFile: paths.wireGatewayPid(), portFile: paths.wireGatewayPort(), runtimeFile: paths.wireGatewayRuntime(), fileMode: WIRE_GATEWAY_FILE_MODE };
}

export function readWireGatewayPidFile(): PidInfo | null {
  return readServiceStateFile<PidInfo>(paths.wireGatewayPid(), 'WIRE', 'wire gateway PID file');
}

export function readWireGatewayRuntimeState(): WireGatewayRuntimeState | null {
  return readServiceStateFile<WireGatewayRuntimeState>(paths.wireGatewayRuntime(), 'WIRE', 'wire gateway runtime state file');
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
  removeServiceState(wireGatewayStateFiles());
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
  const ready = await pollUntil(async () => (await probeWireGatewayIdentity(config.host, config.port)) !== null, START_READY_TIMEOUT_MS);
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
  logUncaughtWireGatewayFailures();
  await service.start();
}

/**
 * The daemon's stdio is ignored, so an uncaught error would end it with no
 * trace (a gateway died that way once, seen live). Log it and keep relaying,
 * as the worker daemon does: the agents wired through it would otherwise
 * fail until someone noticed.
 */
export function logUncaughtWireGatewayFailures(): void {
  process.on('uncaughtException', (error) => {
    logger.error('WIRE', 'Uncaught exception in the wire gateway; it keeps running', {}, error instanceof Error ? error : new Error(String(error)));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('WIRE', 'Unhandled rejection in the wire gateway; it keeps running', {}, reason instanceof Error ? reason : new Error(String(reason)));
  });
}

function printWireGatewayUsage(): void {
  writeStderrLine('Usage: wire-gateway-service <command>');
  writeStderrLine('  start              start the wire gateway in the background');
  writeStderrLine('  start --foreground run it in this process (what the OS service runs)');
  writeStderrLine('  stop               drain in-flight streams, then stop');
  writeStderrLine('  restart            stop, then start in the background');
  writeStderrLine('  status [--json]    print whether it runs, and each wired agent\'s state (ok, unwired, replaced,');
  writeStderrLine('                     unreachable, proxied, bypassed, unknown) with a fix, and each route\'s memory injection,');
  writeStderrLine('                     memory_search and Endless Mode');
  writeStderrLine('  status --endless [--json]');
  writeStderrLine('                     Endless Mode per agent: cache read:write before and after the first cull, tokens saved (each cull once)');
  writeStderrLine('  service install    start it at login (launchd, systemd --user, or a logon task)');
  writeStderrLine('  service uninstall  remove that login item');
  writeStderrLine('  routes add <routeId> --agent <id> --upstream <url> [--capture wire|native]');
  writeStderrLine('                     relay http://<host>:<port>/r/<routeId>/… to <url>/…');
  writeStderrLine('  routes list        print every route');
  writeStderrLine('  routes remove <routeId>');
  writeStderrLine('  routes endless <routeId> on|off|default');
  writeStderrLine('                     turn Endless Mode on or off for one route, live (default: CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE,');
  writeStderrLine('                     read at start: change it, then restart)');
  writeStderrLine('  routes memory <routeId> on|off|default');
  writeStderrLine('                     memory injection for one route, live (default: CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION, capture=wire routes)');
  writeStderrLine('  routes header <routeId> on|off|default');
  writeStderrLine('                     the durable header (My Rules) for one route, live (default: CLAUDE_MEM_WIRE_GATEWAY_DURABLE_HEADER, capture=wire routes)');
  writeStderrLine('  routes search <routeId> on|off|default');
  writeStderrLine('                     the hidden memory_search tool for one route, live (default: CLAUDE_MEM_WIRE_GATEWAY_MEMORY_SEARCH_TOOL)');
  writeStderrLine('  consent            print whether raw recording is on');
  writeStderrLine('  consent --record   turn raw recording on (needs a terminal)');
  writeStderrLine('  consent --off      turn raw recording off');
  writeStderrLine('  clear              delete every raw recording (and the live trace\'s bodies)');
  writeStderrLine('  magpie enable [--backfill] [--dir <path>]');
  writeStderrLine('                     follow magpie\'s recordings (~/.config/magpie/gateway-conversations) into memory capture');
  writeStderrLine('  magpie disable     stop following them');
  writeStderrLine('  keys add <name> --server-url <url> --server-project <id> [--server-api-key <key>]');
  writeStderrLine('                     shared team gateway: make a client key (shown once) whose members\' memory goes to that');
  writeStderrLine('                     claude-mem server runtime (the API key may come from CLAUDE_MEM_WIRE_SERVER_API_KEY instead)');
  writeStderrLine('  keys list          print every client key\'s name and server (never a key)');
  writeStderrLine('  keys remove <name> refuse that key from now on');
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

export interface WireMagpieCliOptions {
  /** Test seams. */
  settingsPath?: string;
  statePath?: string;
  environment?: { env: NodeJS.ProcessEnv; home: string };
  writeLine?: (line: string) => void;
  writeErrorLine?: (line: string) => void;
}

/**
 * `claude-mem wire magpie enable [--backfill] [--dir <path>]` and `disable`
 * (plan Phase 13 task 3): find magpie's recordings, say where the follower
 * starts, and set CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR. The gateway
 * reads it at start. Returns the exit code.
 */
export function runWireMagpieCli(args: string[], options: WireMagpieCliOptions = {}): number {
  const writeLine = options.writeLine ?? writeStdoutLine;
  const writeErrorLine = options.writeErrorLine ?? writeStderrLine;
  const settingsPath = options.settingsPath ?? USER_SETTINGS_PATH;
  const action = args[0];
  const flags = args.slice(1);
  const environment = options.environment ?? { env: process.env, home: homedir() };

  if (action === 'enable') {
    const backfill = flags.includes('--backfill');
    const dirFlagIndex = flags.indexOf('--dir');
    const unknownFlag = flags.find((flag, index) => flag !== '--backfill' && flag !== '--dir' && !(dirFlagIndex >= 0 && index === dirFlagIndex + 1));
    if (unknownFlag !== undefined || (dirFlagIndex >= 0 && !flags[dirFlagIndex + 1])) {
      writeErrorLine('Usage: wire magpie enable [--backfill] [--dir <magpie gateway-conversations folder>]');
      return 1;
    }
    const directory = resolvePath(dirFlagIndex >= 0 ? flags[dirFlagIndex + 1] : defaultMagpieRecordingsDirectory(environment));
    if (!existsSync(directory)) {
      writeErrorLine(`No magpie recordings at ${directory}.`);
      writeErrorLine('Turn on magpie\'s conversation recording first, or name the folder: claude-mem wire magpie enable --dir <path>');
      return 1;
    }
    assertNotClaudeMemRecordings(directory);
    const request = magpieFollowerRequest(directory, backfill);
    // The setting first, then the request: a running follower acts on a request at once, so it is written only once
    // nothing else can fail; when it cannot be written, the setting goes back to what it was, so a failed enable changes nothing.
    const settingKey = 'CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR';
    let previousSetting: unknown;
    const written = updateSettingsDocument(settingsPath, {}, {}, target => {
      previousSetting = target[settingKey];
      target[settingKey] = directory;
    });
    if (written.status === 'refused') {
      writeErrorLine(`Could not write ${settingsPath}: ${written.error instanceof Error ? written.error.message : String(written.error)}`);
      return 1;
    }
    try {
      requestMagpieFollowerState(request, options.statePath);
    } catch (error) {
      writeErrorLine(`Could not write the follower's start request: ${error instanceof Error ? error.message : String(error)}`);
      if (written.status === 'created') {
        rmSync(settingsPath, { force: true });
      } else if (written.status === 'updated') {
        const restored = updateSettingsDocument(settingsPath, {}, {}, target => {
          if (previousSetting === undefined) delete target[settingKey];
          else target[settingKey] = previousSetting;
        });
        if (restored.status === 'refused') {
          writeErrorLine(`…and ${settingsPath} could not be put back (${restored.error instanceof Error ? restored.error.message : String(restored.error)}): set ${settingKey} back to ${JSON.stringify(previousSetting ?? '')} yourself`);
        }
      }
      return 1;
    }
    const settleSeconds = FOREIGN_SOURCE_SETTLE_MS / 1000;
    writeLine(`Following magpie's recordings in ${directory}`);
    writeLine(backfill
      ? '  from the start of every recording there (--backfill): what magpie kept becomes memories too'
      : `  from now on: the ${Object.keys(request.files).length} recording(s) there now are read from their end, unless the follower already follows this folder (then it goes on from where it got to)`);
    writeLine('  Agents claude-mem already captures (a wire route, or its own integration such as Claude Code\'s hooks) are skipped.');
    writeLine(`  Each line is read ${settleSeconds} s after it appears. If magpie's OTLP export (with bodies) also reaches claude-mem, it is used instead:`);
    writeLine(`  a line is skipped when magpie's spans for its agent arrived within ${settleSeconds} s of it, and so is an agent that sends its own GenAI spans.`);
    writeLine('  magpie records only calls that name a session; its OTLP export covers the rest, and work outside its gateway (MAGPIE_OTEL_SESSIONS=true).');
    if (environment.env.CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR !== undefined && environment.env.CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR !== directory) {
      writeLine('  Note: CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR is set in this environment and overrides settings.json.');
    }
    writeLine('A gateway already following this folder starts there at its next look (within seconds).');
    writeLine('Otherwise the gateway reads this at start: claude-mem wire restart');
    return 0;
  }

  if (action === 'disable' && flags.length === 0) {
    const written = updateSettingsDocument(settingsPath, { CLAUDE_MEM_WIRE_GATEWAY_MAGPIE_RECORDINGS_DIR: '' });
    if (written.status === 'refused') {
      writeErrorLine(`Could not write ${settingsPath}: ${written.error instanceof Error ? written.error.message : String(written.error)}`);
      return 1;
    }
    writeLine('No longer following magpie\'s recordings. A running gateway stops at its next start: claude-mem wire restart');
    return 0;
  }

  writeErrorLine('Usage: wire magpie enable [--backfill] [--dir <path>] | disable');
  return 1;
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
  // A URL that does not parse is not loopback: addWireGatewayRoute reports it.
  if (!isLoopbackUrl(upstreamBaseUrl)) return;
  const upstream = new URL(upstreamBaseUrl);
  const upstreamPort = upstream.port || (upstream.protocol === 'https:' ? '443' : '80');
  if (upstreamPort === String(config.port)) {
    throw new Error(`Upstream ${upstreamBaseUrl} is this wire gateway (port ${config.port}); a route must point at the provider.`);
  }
}

/** `routes <action> <routeId> on|off|default`: each feature's per-route switch. */
const ROUTE_FEATURE_SWITCHES: Record<string, { feature: 'endlessMode' | 'memoryInjection' | 'durableHeader' | 'memorySearchTool'; setting: string; settingDefault: string; title: string; listLabel: string }> = {
  endless: { feature: 'endlessMode', setting: 'CLAUDE_MEM_WIRE_GATEWAY_ENDLESS_MODE', settingDefault: 'false', title: 'Endless Mode', listLabel: 'endless' },
  memory: { feature: 'memoryInjection', setting: 'CLAUDE_MEM_WIRE_GATEWAY_MEMORY_INJECTION', settingDefault: 'true', title: 'Memory injection', listLabel: 'memory' },
  header: { feature: 'durableHeader', setting: 'CLAUDE_MEM_WIRE_GATEWAY_DURABLE_HEADER', settingDefault: 'true', title: 'The durable header (My Rules)', listLabel: 'header' },
  search: { feature: 'memorySearchTool', setting: 'CLAUDE_MEM_WIRE_GATEWAY_MEMORY_SEARCH_TOOL', settingDefault: 'false', title: 'The hidden memory_search tool', listLabel: 'search' },
};

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
      const switches = Object.entries(ROUTE_FEATURE_SWITCHES)
        .map(([, feature]) => (route.features?.[feature.feature] === undefined ? '' : `  ${feature.listLabel}=${route.features[feature.feature] ? 'on' : 'off'}`))
        .join('');
      writeStdoutLine(`${routeId}  agent=${route.agentId}  capture=${route.captureSource}  upstream=${route.upstreamBaseUrl}${switches}`);
    }
    return;
  }

  if (Object.hasOwn(ROUTE_FEATURE_SWITCHES, action)) {
    // The per-route kill switches (plan Phases 11–12): `off` wins over the setting.
    const feature = ROUTE_FEATURE_SWITCHES[action];
    const [routeId, state] = positional;
    const enabledByState: Record<string, boolean | undefined> = { on: true, off: false, default: undefined };
    if (!routeId || state === undefined || !Object.hasOwn(enabledByState, state)) {
      throw new Error(`Usage: routes ${action} <routeId> on|off|default`);
    }
    if (!setWireGatewayRouteFeature(routeId, feature.feature, enabledByState[state])) {
      throw new Error(`No route ${routeId}`);
    }
    const followsSetting = `follows ${feature.setting} (${config.rewriteSettings[feature.setting] ?? feature.settingDefault}${feature.feature === 'memoryInjection' || feature.feature === 'durableHeader' ? ', for capture=wire routes' : ''}; `
      + 'a running gateway reads that setting at start, so a change to it needs claude-mem wire restart)';
    writeStdoutLine(`${feature.title} for route ${routeId}: ${state === 'default' ? followsSetting : state} (a running gateway applies the route change within a second)`);
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
      if (argv.slice(1).includes('--endless')) {
        const endlessReport = readEndlessModeReport(config.retentionDays);
        if (argv.slice(1).includes('--json')) {
          writeStdoutLine(JSON.stringify({ agents: endlessReport }, null, 2));
          return;
        }
        for (const line of formatEndlessModeReport(endlessReport, config.retentionDays)) writeStdoutLine(line);
        return;
      }
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
      if (report.memory) for (const line of formatWireMemoryStatus(report.memory, report.gateway.origin)) writeStdoutLine(line);
      if (report.ingest) for (const line of formatWireIngestStatus(report.ingest)) writeStdoutLine(line);
      if (report.team) {
        for (const line of formatWireTeamStatus(report.team, report.gateway.origin)) writeStdoutLine(line);
      } else if (config.shared) {
        writeStdoutLine('');
        writeStdoutLine(`Shared team gateway (not running): its team listener would be http://${formatHostForUrl(config.sharedHost)}:${config.sharedPort} (client key required); ${report.gateway.origin} stays this computer's`);
      }
      return;
    }

    case 'service': {
      const action = argv[1];
      if (action === 'install') {
        writeStdoutLine(installWireGatewayOsService({
          bunPath: process.execPath,
          scriptPath: wireGatewayScriptPath(),
          drainTimeoutMs: config.drainTimeoutMs,
          host: config.host,
          port: config.port,
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

    case 'magpie': {
      process.exitCode = runWireMagpieCli(argv.slice(1));
      return;
    }

    case 'keys': {
      process.exitCode = await runWireKeysCli(argv.slice(1), { config });
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
