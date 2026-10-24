// SPDX-License-Identifier: Apache-2.0
//
// `claude-mem wire status` and `GET /wire/status` (plan Phase 9): for each
// agent, whether its requests really reach the gateway, as one of
//
//   ok           wired, answering, and nothing says otherwise
//   unwired      a base-URL key the agent uses now does not point at the
//                gateway (a provider switched or added, a route removed)
//   replaced     a value connect wrote was changed to something else; reported,
//                never reverted silently
//   unreachable  the address the agent is given does not answer as the gateway
//   proxied      the agent's proxy settings send gateway requests through a
//                proxy that does not pass them on
//   bypassed     the agent was used since connect, yet none of its requests
//                reached the gateway (it still runs on its old config)
//   unknown      something needed cannot be read, or a probe has no answer yet
//
// each with a fix. Order and rules from magpie internal/agent/applied.go:
// 114-261 (Drift, bypassed) and 802-837 (lastJSONLTime), MIT, Copyright (c)
// 2026 yetone. A file that cannot be read gives `unknown`, never `ok`.

import type { WireMemoryStatus } from '../memory/memory-status.js';
import { closeSync, fstatSync, openSync, readSync } from 'fs';
import { isSecretFieldName } from '../../../utils/redaction.js';
import { readConfigFileBytes } from '../edit/config-file.js';
import { readWireGatewayRoutesFile, type WireGatewayCaptureSource, type WireGatewayRoute } from '../routes.js';
import type { AgentDescriptor, AgentEnvironment, AgentLastUsedDescriptor } from '../agents/types.js';
import { readConfigValue } from '../wiring/config-document.js';
import { readCurrentBaseUrlTargets } from '../wiring/wiring-engine.js';
import { readAppliedRecords, type AppliedAgentRecord } from '../wiring/wiring-records.js';
import type { LastSeenFileReadResult } from './last-seen.js';
import {
  isLoopbackUrl,
  probeIdentityDirectly,
  probeIdentityThroughProxy,
  proxyRouteFor,
  readMacSystemProxySettings,
  type ProbeLookup,
  type ProxyRoute,
  type SystemProxySettings,
} from './reachability.js';

export type WireAgentState = 'ok' | 'unwired' | 'replaced' | 'unreachable' | 'proxied' | 'bypassed' | 'unknown';

export interface WireAgentStatus {
  agentId: string;
  name: string;
  state: WireAgentState;
  detail: string;
  /** What to run or change; null when nothing is needed. */
  fix: string | null;
  captureSource: WireGatewayCaptureSource | null;
  routeIds: string[];
  /** When `wire connect` wired it; null for routes made by `wire run` or by hand. */
  connectedAt: string | null;
  lastSeenAt: string | null;
  lastUsedAt: string | null;
  /** The key the state is about (unwired, replaced). */
  field?: { filePath: string; keyPath: string; now: unknown; want?: unknown };
  /** The proxy in the way (proxied); credentials removed. */
  proxy?: { url: string; source: string };
  notes: string[];
}

export interface WireStatusReport {
  generatedAt: string;
  gateway: { origin: string; running: boolean; version?: string; startedAt?: string };
  /** From the running gateway only. */
  capture: { unattributedEventCount: number } | null;
  /** Files that could not be read, so some agents may be missing or unknown. */
  problems: string[];
  agents: WireAgentStatus[];
  /** Per route: memory injection, the hidden memory_search tool and Endless Mode (plan Phase 12); absent when routes.json could not be read. */
  memory?: WireMemoryStatus;
  /** The ways in from outside (plan Phase 13), from the running gateway only. */
  ingest?: WireIngestStatus;
  /** A shared gateway's team listener and outbox (plan Phase 16), from the running gateway only. */
  team?: WireTeamStatus;
}

/** Content-free: where members connect, and counts. */
export interface WireTeamStatus {
  /** The team listener (every request there needs a client key). */
  listener: string;
  /** Keys in keys.json; null when it does not read (every keyed request is then answered 503). */
  clientKeys: number | null;
  admission: { admitted: number; refusedNotAllowed: number; refusedNoKey: number; refusedWrongKey: number; refusedThrottled: number; refusedHostOnly: number; refusedKeysUnreadable: number };
  outbox: { pending: number; queued: number; duplicates: number; delivered: number; retried: number; rejected: number; expired: number; refusedFull: number; orphaned: number };
}

/** The `wire status` lines for a shared gateway. */
export function formatWireTeamStatus(team: WireTeamStatus, loopbackOrigin: string): string[] {
  const { admission, outbox } = team;
  return [
    '',
    'Shared team gateway:',
    `  team listener ${team.listener}: a client key is required for every request (/k/<key>/r/<route>/…), loopback included; point your TLS proxy here`,
    `  loopback listener ${loopbackOrigin}: this computer's own agents (no key), /wire/*, /mcp; never point a proxy here`,
    `  client keys: ${team.clientKeys === null ? 'keys.json does not read: every keyed request is refused (503) until it is repaired' : team.clientKeys}`,
    `  since start: ${admission.admitted} admitted; refused ${admission.refusedNoKey} without a key, ${admission.refusedWrongKey} wrong key, ${admission.refusedThrottled} throttled (429), ${admission.refusedNotAllowed} off the allow list, ${admission.refusedHostOnly} host-only endpoint, ${admission.refusedKeysUnreadable} keys.json unreadable`,
    `  outbox: ${outbox.pending} pending; since start ${outbox.queued} queued, ${outbox.delivered} delivered, ${outbox.duplicates} duplicate(s), ${outbox.retried} retried, ${outbox.rejected} rejected (${outbox.orphaned} of a removed key), ${outbox.expired} expired, ${outbox.refusedFull} lost (pending full)`,
  ];
}

/** Content-free counters of the push endpoint, the OTLP receiver and the magpie follower since the gateway started. */
export interface WireIngestStatus {
  push: { postsAnswered: number; eventsAccepted: number; eventsSkipped: number; postsRefused: number };
  otlp: { enabled: boolean; postsAnswered: number; postsFailed: number; spansCaptured: number; spansMetadataOnly: number; spansRejected: number; spansSkippedOtherSource: number };
  magpie: {
    /** The folder followed; null when the follower is off. */
    directory: string | null;
    polls: number;
    linesRead: number;
    linesMalformed: number;
    linesSkippedHelper: number;
    oversizedLinesSkipped: number;
    filesRestarted: number;
    symlinksSkipped: number;
    statesTakenUp: number;
    requestsUnreadable: number;
    exchanges: number;
    skippedOtherSource: number;
  };
}

/** The `wire status` lines for the ways in from outside. */
export function formatWireIngestStatus(ingest: WireIngestStatus): string[] {
  const { push, otlp, magpie } = ingest;
  return [
    '',
    'Ways in from outside (since the gateway started):',
    `  push  POST /v1/claude-mem/events: ${push.eventsAccepted} event(s) accepted, ${push.eventsSkipped} skipped as already accepted, ${push.postsRefused} post(s) refused`,
    otlp.enabled
      ? `  otlp  POST /v1/traces: ${otlp.spansCaptured} span(s) captured, ${otlp.spansMetadataOnly} metadata-only, ${otlp.spansRejected} rejected, ${otlp.spansSkippedOtherSource} skipped (agent captured another way), ${otlp.postsFailed} post(s) failed (answered 503, see the log)`
      : '  otlp  off (CLAUDE_MEM_WIRE_GATEWAY_OTLP=false)',
    magpie.directory
      ? `  magpie following ${magpie.directory}: ${magpie.linesRead} line(s) read, ${magpie.exchanges} captured, ${magpie.skippedOtherSource} skipped (agent captured another way), ${magpie.linesMalformed} malformed${magpie.requestsUnreadable > 0 ? `, ${magpie.requestsUnreadable} unreadable wire magpie enable request(s) (see the log)` : ''}`
      : '  magpie off (claude-mem wire magpie enable)',
  ];
}

export interface WireAgentStatusInputs {
  environment: AgentEnvironment;
  /** `http://127.0.0.1:<port>`: where the gateway listens now. */
  gatewayOrigin: string;
  wiringDirectory: string;
  routesFilePath: string;
  descriptors: AgentDescriptor[];
  lastSeen: LastSeenFileReadResult;
  /** When the running gateway started (epoch ms); null when it is not running. */
  gatewayStartedAt: number | null;
  lookupProbe: ProbeLookup;
  /** Test seams. */
  probeIdentity?: (baseUrl: string) => Promise<boolean>;
  probeThroughProxy?: (baseUrl: string, proxyUrl: string) => Promise<boolean>;
  readSystemProxy?: () => Promise<SystemProxySettings | null>;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// The agent's own record of use (magpie lastJSONLTime)

/** magpie reads the last 64 KiB of a prompt log. */
export const LAST_USED_TAIL_BYTES = 64 * 1024;
/** A request leaves within moments of a prompt; a use younger than this may still be in flight (magpie bypassed). */
export const BYPASS_GRACE_MS = 30_000;
/** A request this close before a use still counts as that use's. */
export const BYPASS_SEEN_SLACK_MS = 2_000;
/** Seconds or milliseconds: anything above this is milliseconds (magpie lastJSONLTime). */
const MILLISECOND_TIMESTAMP_THRESHOLD = 1e12;
export type LastUsedReadResult =
  | { kind: 'none' }
  | { kind: 'used'; at: number }
  | { kind: 'unreadable'; reason: string };

function isMissingFile(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The newest timestamp in the last 64 KiB of the agent's prompt log, skipping `/` commands where it asks. */
export function readAgentLastUsed(lastUsed: AgentLastUsedDescriptor, environment: AgentEnvironment): LastUsedReadResult {
  const filePath = lastUsed.path(environment);
  let text: string;
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = openSync(filePath, 'r');
    const size = fstatSync(fileDescriptor).size;
    const start = Math.max(0, size - LAST_USED_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    let filled = 0;
    while (filled < buffer.length) {
      const read = readSync(fileDescriptor, buffer, filled, buffer.length - filled, start + filled);
      if (read === 0) break;
      filled += read;
    }
    text = buffer.subarray(0, filled).toString('utf-8');
  } catch (error) {
    if (isMissingFile(error)) return { kind: 'none' };
    return { kind: 'unreadable', reason: `${filePath} cannot be read (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    if (fileDescriptor !== null) closeSync(fileDescriptor);
  }
  let newestSeconds = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      // The first line of a tail is usually cut, and a log may hold other lines: skip them.
      continue;
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue;
    const fields = record as Record<string, unknown>;
    if (lastUsed.slashCommandTextField) {
      const promptText = fields[lastUsed.slashCommandTextField];
      if (typeof promptText === 'string' && promptText.trim().startsWith('/')) continue;
    }
    const value = fields[lastUsed.field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    const seconds = Math.floor(value > MILLISECOND_TIMESTAMP_THRESHOLD ? value / 1000 : value);
    newestSeconds = Math.max(newestSeconds, seconds);
  }
  return newestSeconds === 0 ? { kind: 'none' } : { kind: 'used', at: newestSeconds * 1000 };
}

/**
 * magpie's bypassed(): used after connect and while this gateway was up,
 * long enough ago for its request to have arrived, and no request of the
 * agent arrived since (lastSeen null: never).
 */
export function isBypassed(usedAt: number, connectedAt: number, gatewayStartedAt: number, lastSeenAt: number | null, now: number): boolean {
  return usedAt > gatewayStartedAt
    && usedAt > connectedAt
    && now - usedAt > BYPASS_GRACE_MS
    && (lastSeenAt === null || lastSeenAt < usedAt - BYPASS_SEEN_SLACK_MS);
}

// ---------------------------------------------------------------------------
// Where a value points

/** Where `/r/<routeId>` sits in a URL value: the base before it, or null when it names none of the routes. */
function routeBaseOf(value: unknown, routeIds: Iterable<string>): string | null {
  if (typeof value !== 'string' || value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  for (const routeId of routeIds) {
    const marker = `/r/${routeId}`;
    let index = url.pathname.indexOf(marker);
    while (index !== -1) {
      const after = url.pathname.charAt(index + marker.length);
      if (after === '' || after === '/') return `${url.origin}${url.pathname.slice(0, index)}`;
      index = url.pathname.indexOf(marker, index + 1);
    }
  }
  return null;
}

/** The gateway itself: loopback (any spelling) on its port, with no path in front of /r/. */
function isGatewayOriginItself(base: string, gatewayOrigin: string): boolean {
  try {
    const url = new URL(base);
    const gateway = new URL(gatewayOrigin);
    return isLoopbackUrl(base) && url.protocol === 'http:' && url.port === gateway.port && (url.pathname === '' || url.pathname === '/');
  } catch {
    return false;
  }
}

function withoutCredentials(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    return url.href.replace(/\/$/, '');
  } catch {
    return '(unparseable proxy URL)';
  }
}

const MASKED_URL_SECRET = '***';

/**
 * A URL a config holds, safe to print and to serve from GET /wire/status: its
 * userinfo (`user:password@`) and secret-named query values (`?api_key=`,
 * `?token=`) become `***`. Anything that is not a URL string is returned as is.
 */
export function withUrlSecretsMasked<T>(value: T): T | string {
  if (typeof value !== 'string' || value === '') return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Not a URL: a base-URL key holds nothing else worth masking.
    return value;
  }
  let masked = false;
  if (url.username || url.password) {
    url.username = MASKED_URL_SECRET;
    url.password = '';
    masked = true;
  }
  for (const name of new Set(url.searchParams.keys())) {
    if (!isSecretFieldName(name)) continue;
    url.searchParams.set(name, MASKED_URL_SECRET);
    masked = true;
  }
  // Re-serialize only when something was masked, so a clean value reads exactly as written.
  if (!masked) return value;
  // URL adds a "/" path to a bare origin; a value written without one is shown without one.
  const writtenWithoutPath = url.pathname === '/' && !/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\//i.test(value);
  return writtenWithoutPath ? url.href.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)\//i, '$1') : url.href;
}

function describeValue(value: unknown): string {
  return value === undefined ? '(absent)' : JSON.stringify(value);
}

function clockTime(epochMs: number): string {
  const date = new Date(epochMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Evaluation

type Verdict =
  | { state: 'reaches' }
  | { state: 'pending'; detail: string }
  | { state: 'elsewhere' };

interface EvaluationContext {
  inputs: WireAgentStatusInputs;
  routes: Record<string, WireGatewayRoute> | null;
  probeIdentity: (baseUrl: string) => Promise<boolean>;
  probeThroughProxy: (baseUrl: string, proxyUrl: string) => Promise<boolean>;
  readSystemProxy: () => Promise<SystemProxySettings | null>;
  now: number;
}

async function identityAnswer(context: EvaluationContext, base: string) {
  return context.inputs.lookupProbe(`identity ${base}`, () => context.probeIdentity(base));
}

/** Whether a value sends the agent to the gateway: directly, or through a base that answers as it (a reverse proxy). */
async function pointsAtGateway(context: EvaluationContext, value: unknown, routeIds: Iterable<string>): Promise<Verdict> {
  const base = routeBaseOf(value, routeIds);
  if (base === null) return { state: 'elsewhere' };
  if (isGatewayOriginItself(base, context.inputs.gatewayOrigin)) return { state: 'reaches' };
  const answer = await identityAnswer(context, base);
  if (!answer.known) return { state: 'pending', detail: `checking whether ${base} answers as the wire gateway; ask again in a moment` };
  return answer.value ? { state: 'reaches' } : { state: 'elsewhere' };
}

function reconnectFix(agentId: string): string {
  return `claude-mem wire disconnect ${agentId} && claude-mem wire connect ${agentId}`;
}

/** The descriptor's notes, which hold whatever the state (Phase 8 carry-overs: Gemini's trusted folders, OpenCode's merged files). */
function agentNotes(descriptor: AgentDescriptor | undefined, record: AppliedAgentRecord | undefined, environment: AgentEnvironment): string[] {
  if (!descriptor?.statusNotes) return [];
  const connectedFilePaths = Object.fromEntries(Object.entries(record?.files ?? {}).map(([fileKey, file]) => [fileKey, file.path]));
  return descriptor.statusNotes({ environment, connectedFilePaths });
}

async function evaluateConnectedAgent(
  context: EvaluationContext,
  agentId: string,
  record: AppliedAgentRecord,
): Promise<WireAgentStatus> {
  const { inputs } = context;
  const descriptor = inputs.descriptors.find((candidate) => candidate.id === agentId);
  const lastSeenAt = inputs.lastSeen.kind === 'read' ? inputs.lastSeen.lastSeenByAgent[agentId] ?? null : null;
  const status: WireAgentStatus = {
    agentId,
    name: descriptor?.name ?? agentId,
    state: 'ok',
    detail: '',
    fix: null,
    captureSource: record.captureSource,
    routeIds: record.routeIds,
    connectedAt: record.at,
    lastSeenAt: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(),
    lastUsedAt: null,
    notes: agentNotes(descriptor, record, inputs.environment),
  };
  const conclude = (state: WireAgentState, detail: string, fix: string | null, extra: Partial<WireAgentStatus> = {}): WireAgentStatus =>
    Object.assign(status, { state, detail, fix }, extra);

  if (!descriptor) {
    return conclude('unknown', `${agentId} was connected, but no agent descriptor has that id any more (a removed user descriptor?)`,
      `put its descriptor back under the wire gateway's agents folder, then: claude-mem wire disconnect ${agentId}`);
  }
  const name = descriptor.name;
  const knownRouteIds = new Set([...record.routeIds, ...Object.keys(context.routes ?? {})]);
  let pendingDetail: string | null = null;

  // What connect wrote, read back.
  const wiredBases = new Set<string>();
  const recordedKeys = new Set<string>();
  let replacedFinding: WireAgentStatus['field'] | null = null;
  try {
    for (const [fileKey, fields] of Object.entries(record.fields)) {
      const file = record.files[fileKey];
      if (!file) continue;
      for (const [keyPath, written] of Object.entries(fields)) {
        const writtenBase = routeBaseOf(written, record.routeIds);
        if (writtenBase === null) continue; // an identity switch, not a base URL
        recordedKeys.add(`${file.path}\u0000${keyPath}`);
        const current = readConfigValue(file.format, file.path, readConfigFileBytes(file.path), keyPath);
        if (Bun.deepEquals(current, written, true)) {
          wiredBases.add(writtenBase);
          continue;
        }
        const verdict = await pointsAtGateway(context, current, knownRouteIds);
        if (verdict.state === 'reaches') {
          wiredBases.add(routeBaseOf(current, knownRouteIds)!);
        } else if (verdict.state === 'pending') {
          pendingDetail ??= verdict.detail;
        } else {
          replacedFinding ??= { filePath: file.path, keyPath, now: withUrlSecretsMasked(current), want: withUrlSecretsMasked(written) };
        }
      }
    }
  } catch (error) {
    return conclude('unknown', `${name}'s config cannot be read: ${errorText(error)}`, 'fix or restore that file, then ask again');
  }

  // What the agent's files point it at now.
  let unwiredFinding: { detail: string; field?: WireAgentStatus['field'] } | null = null;
  if (context.routes !== null) {
    const missingRouteIds = record.routeIds.filter((routeId) => !Object.hasOwn(context.routes!, routeId));
    if (missingRouteIds.length > 0) {
      unwiredFinding = { detail: `route(s) ${missingRouteIds.join(', ')} were removed, so ${name}'s requests get 404 from the gateway` };
    }
  }
  if (!unwiredFinding) {
    try {
      for (const target of readCurrentBaseUrlTargets(descriptor, inputs.environment)) {
        if (recordedKeys.has(`${target.filePath}\u0000${target.keyPath}`)) continue;
        const field = { filePath: target.filePath, keyPath: target.keyPath, now: withUrlSecretsMasked(target.value) };
        if (typeof target.value === 'string' && target.value !== '') {
          const verdict = await pointsAtGateway(context, target.value, knownRouteIds);
          if (verdict.state === 'reaches') {
            wiredBases.add(routeBaseOf(target.value, knownRouteIds)!);
            continue;
          }
          if (verdict.state === 'pending') {
            pendingDetail ??= verdict.detail;
            continue;
          }
          unwiredFinding = { detail: `${target.filePath}: ${target.keyPath} sends ${name} to ${withUrlSecretsMasked(target.value)}, not through the gateway`, field };
          break;
        }
        if (target.value === undefined && target.defaultUpstream) {
          unwiredFinding = { detail: `${target.filePath}: ${target.keyPath} is not set, so ${name} uses its built-in endpoint (${withUrlSecretsMasked(target.defaultUpstream)}), not the gateway`, field };
          break;
        }
      }
    } catch (error) {
      return conclude('unknown', `${name}'s config cannot be read: ${errorText(error)}`, 'fix or restore that file, then ask again');
    }
  }

  if (unwiredFinding) {
    return conclude('unwired', unwiredFinding.detail, reconnectFix(agentId), unwiredFinding.field ? { field: unwiredFinding.field } : {});
  }
  if (replacedFinding) {
    return conclude('replaced',
      `${replacedFinding.filePath}: ${replacedFinding.keyPath} is ${describeValue(replacedFinding.now)}, changed outside claude-mem from ${describeValue(replacedFinding.want)}; it was left as it is`,
      `to route it again: ${reconnectFix(agentId)}; to keep the change: claude-mem wire disconnect ${agentId}`,
      { field: replacedFinding });
  }
  if (pendingDetail) return conclude('unknown', pendingDetail, null);

  // Does the address answer, directly and through the agent's proxy? Both
  // lookups start before either is read, so one round of probes settles them.
  const systemProxy = await inputs.lookupProbe('system proxy', context.readSystemProxy);
  for (const base of wiredBases) {
    const answer = await identityAnswer(context, base);
    if (!answer.known) return conclude('unknown', `checking whether ${base} answers as the wire gateway; ask again in a moment`, null);
    if (answer.value) continue;
    if (isGatewayOriginItself(base, inputs.gatewayOrigin)) {
      return conclude('unreachable', `nothing answers as the wire gateway at ${base}, where ${name} sends its requests: the gateway is not running`, 'claude-mem wire start');
    }
    if (isLoopbackUrl(base) && new URL(base).pathname === '/') {
      return conclude('unreachable', `${name} is pointed at ${base}, but the wire gateway listens on ${inputs.gatewayOrigin} (did CLAUDE_MEM_WIRE_GATEWAY_PORT change?)`, reconnectFix(agentId));
    }
    return conclude('unreachable', `${name} is pointed at the wire gateway through ${base}, where nothing answers as it now`,
      `start whatever forwards ${base} to the gateway again, or ${reconnectFix(agentId)}`);
  }

  if (!systemProxy.known) return conclude('unknown', 'reading the system proxy settings; ask again in a moment', null);
  for (const base of wiredBases) {
    const route: ProxyRoute | null = proxyRouteFor(`${base}/`, inputs.environment.env, systemProxy.value);
    if (!route) continue;
    const answer = await inputs.lookupProbe(`proxy ${route.proxyUrl} ${base}`, () => context.probeThroughProxy(base, route.proxyUrl));
    if (!answer.known) return conclude('unknown', `checking whether the proxy at ${withoutCredentials(route.proxyUrl)} passes requests on to the gateway; ask again in a moment`, null);
    if (answer.value) continue;
    return conclude('proxied',
      `${name} would send its requests for the gateway (${base}) through the proxy at ${withoutCredentials(route.proxyUrl)}, set in ${route.source}, and that proxy does not pass them on: every request fails`,
      `add 127.0.0.1 to NO_PROXY${route.source.includes('PROXY') ? ` where ${route.source} is set (your shell profile)` : ' in your shell profile'}, or have the proxy send 127.0.0.1 direct (Clash: IP-CIDR,127.0.0.0/8,DIRECT,no-resolve); then restart ${name}`,
      { proxy: { url: withoutCredentials(route.proxyUrl), source: route.source } });
  }

  // Was it used without reaching us?
  if (descriptor.lastUsed) {
    const used = readAgentLastUsed(descriptor.lastUsed, inputs.environment);
    if (used.kind === 'unreadable') return conclude('unknown', used.reason, 'fix the file\'s permissions, then ask again');
    if (used.kind === 'used') {
      status.lastUsedAt = new Date(used.at).toISOString();
      const connectedAt = Date.parse(record.at);
      if (inputs.gatewayStartedAt !== null && Number.isFinite(connectedAt)
        && isBypassed(used.at, connectedAt, inputs.gatewayStartedAt, null, context.now)) {
        // The use is a bypass candidate: now the last request decides, and it must be known.
        if (inputs.lastSeen.kind === 'unreadable') return conclude('unknown', inputs.lastSeen.reason, 'remove that file; the gateway writes it again');
        if (isBypassed(used.at, connectedAt, inputs.gatewayStartedAt, lastSeenAt, context.now)) {
          return conclude('bypassed',
            `${name} was used at ${clockTime(used.at)}, but none of its requests reached the gateway since: one started before it was connected still runs on its old config`,
            `quit and reopen ${name}`);
        }
      }
    }
  }

  return conclude('ok', `sends its requests through the gateway${lastSeenAt !== null ? `; last request ${clockTime(lastSeenAt)}` : ''}`, null);
}

/** Agents with routes but no connect record (`wire run`, `wire routes add`): only whether the gateway answers. */
async function evaluateRouteOnlyAgent(context: EvaluationContext, agentId: string, routeIds: string[], captureSource: WireGatewayCaptureSource): Promise<WireAgentStatus> {
  const { inputs } = context;
  const descriptor = inputs.descriptors.find((candidate) => candidate.id === agentId);
  const lastSeenAt = inputs.lastSeen.kind === 'read' ? inputs.lastSeen.lastSeenByAgent[agentId] ?? null : null;
  const status: WireAgentStatus = {
    agentId,
    name: descriptor?.name ?? agentId,
    state: 'ok',
    detail: `routed by \`wire run\` or \`wire routes add\` (no config wiring to check)${lastSeenAt !== null ? `; last request ${clockTime(lastSeenAt)}` : ''}`,
    fix: null,
    captureSource,
    routeIds,
    connectedAt: null,
    lastSeenAt: lastSeenAt === null ? null : new Date(lastSeenAt).toISOString(),
    lastUsedAt: null,
    notes: agentNotes(descriptor, undefined, inputs.environment),
  };
  const answer = await identityAnswer(context, inputs.gatewayOrigin);
  if (!answer.known) return Object.assign(status, { state: 'unknown', detail: `checking whether ${inputs.gatewayOrigin} answers as the wire gateway; ask again in a moment` });
  if (!answer.value) return Object.assign(status, { state: 'unreachable', detail: `nothing answers as the wire gateway at ${inputs.gatewayOrigin}: it is not running`, fix: 'claude-mem wire start' });
  return status;
}

/** Every connected or routed agent's state. Problems are files that could not be read. */
export async function evaluateWireAgentStatuses(inputs: WireAgentStatusInputs): Promise<{ agents: WireAgentStatus[]; problems: string[] }> {
  const problems: string[] = [];
  let routes: Record<string, WireGatewayRoute> | null = null;
  try {
    routes = readWireGatewayRoutesFile(inputs.routesFilePath).routes;
  } catch (error) {
    problems.push(`routes.json cannot be read: ${errorText(error)}`);
  }
  let records: Record<string, AppliedAgentRecord> | null = null;
  try {
    records = readAppliedRecords(inputs.wiringDirectory);
  } catch (error) {
    problems.push(errorText(error));
  }
  if (inputs.lastSeen.kind === 'unreadable') problems.push(inputs.lastSeen.reason);

  const context: EvaluationContext = {
    inputs,
    routes,
    probeIdentity: inputs.probeIdentity ?? probeIdentityDirectly,
    probeThroughProxy: inputs.probeThroughProxy ?? probeIdentityThroughProxy,
    readSystemProxy: inputs.readSystemProxy ?? (() => readMacSystemProxySettings(inputs.environment.platform)),
    now: (inputs.now ?? Date.now)(),
  };

  const agents: WireAgentStatus[] = [];
  const connectedAgentIds = new Set(Object.keys(records ?? {}));
  for (const [agentId, record] of Object.entries(records ?? {})) {
    agents.push(await evaluateConnectedAgent(context, agentId, record));
  }
  const routeOnly = new Map<string, { routeIds: string[]; captureSource: WireGatewayCaptureSource }>();
  for (const [routeId, route] of Object.entries(routes ?? {})) {
    if (connectedAgentIds.has(route.agentId)) continue;
    const entry = routeOnly.get(route.agentId) ?? { routeIds: [], captureSource: route.captureSource };
    entry.routeIds.push(routeId);
    routeOnly.set(route.agentId, entry);
  }
  for (const [agentId, entry] of routeOnly) {
    if (records === null) {
      // Without applied.json there is no telling whether connect wired it.
      const descriptor = inputs.descriptors.find((candidate) => candidate.id === agentId);
      agents.push({
        agentId, name: descriptor?.name ?? agentId, state: 'unknown', detail: 'wiring/applied.json cannot be read, so its config wiring cannot be checked',
        fix: 'fix or remove wiring/applied.json by hand', captureSource: entry.captureSource, routeIds: entry.routeIds,
        connectedAt: null, lastSeenAt: null, lastUsedAt: null, notes: [],
      });
      continue;
    }
    agents.push(await evaluateRouteOnlyAgent(context, agentId, entry.routeIds, entry.captureSource));
  }
  agents.sort((left, right) => left.agentId.localeCompare(right.agentId));
  return { agents, problems };
}

// ---------------------------------------------------------------------------
// CLI table

export function formatWireStatusReport(report: WireStatusReport): string[] {
  const lines: string[] = [];
  const { gateway } = report;
  lines.push(gateway.running
    ? `Wire gateway is running at ${gateway.origin}${gateway.version ? ` (version ${gateway.version}` : ''}${gateway.startedAt ? `, started ${gateway.startedAt}` : ''}${gateway.version ? ')' : ''}`
    : `Wire gateway is not running (it would listen at ${gateway.origin})`);
  if (report.capture) lines.push(`  Captured events with no known folder: ${report.capture.unattributedEventCount}`);
  for (const problem of report.problems) lines.push(`  Problem: ${problem}`);
  if (report.agents.length === 0) {
    lines.push('No agents are wired (claude-mem wire connect <agent>)');
    return lines;
  }
  const idWidth = Math.max(5, ...report.agents.map((agent) => agent.agentId.length));
  const stateWidth = 'unreachable'.length;
  lines.push('');
  lines.push(`${'AGENT'.padEnd(idWidth)}  ${'STATE'.padEnd(stateWidth)}  DETAIL`);
  const indent = ' '.repeat(idWidth + stateWidth + 4);
  for (const agent of report.agents) {
    lines.push(`${agent.agentId.padEnd(idWidth)}  ${agent.state.padEnd(stateWidth)}  ${agent.detail}`);
    if (agent.fix) lines.push(`${indent}fix: ${agent.fix}`);
    for (const note of agent.notes) lines.push(`${indent}note: ${note}`);
  }
  return lines;
}
