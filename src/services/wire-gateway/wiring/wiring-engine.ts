// SPDX-License-Identifier: Apache-2.0
//
// `claude-mem wire connect|disconnect <agent>` (plan Phase 8 tasks 2-3).
//
// connect: detect the agent, read its files, refuse a subscription sign-in
// (D4), pick the capture source (D6), point every base-URL key at
// http://127.0.0.1:<port>/r/<routeId><upstream path> with a route to the key's
// old value (or the agent's built-in endpoint), turn on identity switches,
// and record what changed (wiring/applied.json) and what was there
// (wiring/stash.json). Every file of one connect is written in one
// `atomically` group under the wiring lock. Then the daemon is started, the OS
// service installed (D14), and each route probed through the URL the agent
// now uses; a failure there undoes the connect.
//
// disconnect: a file nobody touched since connect gets its prior bytes back
// exactly. Otherwise each field still equal to what connect wrote is reset
// from the stash, a field the user changed is reported `replaced` and left
// alone, and parents connect created are removed once empty. The routes go;
// with the last route the daemon stops and the OS service is removed.
//
// Rules from magpie internal/agent/applied.go:504-726 and plugged.go:211-409
// (MIT, Copyright (c) 2026 yetone).

import { createHash } from 'crypto';
import { isAbsolute, join, relative } from 'path';
import { writeFileAtomic } from '../../../shared/atomic-json.js';
import { WIRE_GATEWAY_FILE_MODE } from '../../../shared/paths.js';
import { atomically, readConfigFileBytes, removeConfigFile } from '../edit/config-file.js';
import { withExclusiveFileLock } from '../edit/file-lock.js';
import { isPlainObjectValue, splitConfigKeyPath, trimCharacters } from '../edit/text-shape.js';
import {
  addWireGatewayRoute,
  readWireGatewayRoutesFile,
  removeWireGatewayRoute,
  validateUpstreamBaseUrl,
  WIRE_GATEWAY_ROUTE_ID_PATTERN,
  type WireGatewayCaptureSource,
} from '../routes.js';
import { isLoopbackAddress } from '../network-guard.js';
import { isExecutableOnPath, pathExists } from '../agents/agent-paths.js';
import type {
  AgentConfigFormat,
  AgentConfigReadContext,
  AgentDescriptor,
  AgentEnvironment,
  AgentWiringHelpers,
  ResolvedBaseUrlTarget,
  ResolvedIdentitySwitch,
} from '../agents/types.js';
import {
  expandJsonWildcardKeyPath,
  isEmptyConfigDocument,
  joinConfigKeyPath,
  patchConfigBytes,
  readConfigValue,
} from './config-document.js';
import {
  STASHED_ABSENT,
  appliedRecordsPath,
  readAppliedRecords,
  requireStashedAgentEntry,
  stashPath,
  updateAppliedRecords,
  updateStash,
  type AppliedAgentRecord,
  type StashedAgentEntry,
} from './wiring-records.js';

/** What connect and disconnect do outside the agent's files; injected so tests never touch a real daemon or OS service. */
export interface WiringSideEffects {
  ensureGatewayRunning(): Promise<void>;
  stopGateway(): Promise<void>;
  isOsServiceInstalled(): boolean;
  /** Returns a line for the user. */
  installOsService(): string;
  /** Returns a line for the user. */
  uninstallOsService(): string;
  /** Whether `GET <url>` answers as this gateway. */
  probeRouteIdentity(url: string): Promise<boolean>;
}

export interface WiringOptions {
  environment: AgentEnvironment;
  /** `http://127.0.0.1:<port>`: the gateway as agents reach it. */
  gatewayOrigin: string;
  wiringDirectory: string;
  routesFilePath: string;
  sideEffects: WiringSideEffects;
  helpers: AgentWiringHelpers;
  now?: () => Date;
  /** `wire preview`'s sandboxed run: every agent file written or removed must be under this folder. */
  confineAgentFileWritesTo?: string;
}

// ---------------------------------------------------------------------------
// Reading an agent's files

interface ResolvedConfigFile {
  key: string;
  path: string;
  format: AgentConfigFormat;
  bytes: Uint8Array | null;
}

function resolveConfigFiles(descriptor: AgentDescriptor, environment: AgentEnvironment): Map<string, ResolvedConfigFile> {
  const files = new Map<string, ResolvedConfigFile>();
  for (const file of descriptor.files) {
    const candidates = file.candidatePaths(environment);
    if (candidates.length === 0) continue;
    const path = candidates.find(pathExists) ?? candidates[0];
    files.set(file.key, { key: file.key, path, format: file.format, bytes: readConfigFileBytes(path) });
  }
  return files;
}

function createReadContext(descriptor: AgentDescriptor, environment: AgentEnvironment, files: Map<string, ResolvedConfigFile>): AgentConfigReadContext {
  const requireFile = (fileKey: string): ResolvedConfigFile => {
    const file = files.get(fileKey);
    if (!file) throw new Error(`${descriptor.name}: its "${fileKey}" file has no path here`);
    return file;
  };
  return {
    agentId: descriptor.id,
    environment,
    readValue: (fileKey, keyPath) => {
      const file = requireFile(fileKey);
      return readConfigValue(file.format, file.path, file.bytes, keyPath);
    },
    filePath: (fileKey) => requireFile(fileKey).path,
    fileBytes: (fileKey) => requireFile(fileKey).bytes,
  };
}

function isAgentDetected(descriptor: AgentDescriptor, environment: AgentEnvironment, files: Map<string, ResolvedConfigFile>): boolean {
  if ([...files.values()].some((file) => file.bytes !== null)) return true;
  if ((descriptor.detect.directories?.(environment) ?? []).some(pathExists)) return true;
  return (descriptor.detect.bins ?? []).some((bin) => isExecutableOnPath(environment, bin));
}

function resolveTargets(descriptor: AgentDescriptor, context: AgentConfigReadContext, files: Map<string, ResolvedConfigFile>): ResolvedBaseUrlTarget[] {
  const targets: ResolvedBaseUrlTarget[] = [...(descriptor.resolveTargets?.(context) ?? [])];
  for (const target of descriptor.targets) {
    const segments = splitConfigKeyPath(target.keyPath);
    const wildcardIndex = segments.findIndex((segment) => segment.matchesAnyKey);
    if (wildcardIndex === -1) {
      targets.push({ file: target.file, keyPath: target.keyPath, protocol: target.protocol, defaultUpstream: target.defaultUpstream });
      continue;
    }
    const file = files.get(target.file);
    for (const match of expandJsonWildcardKeyPath(file?.bytes ?? null, target.keyPath)) {
      targets.push({ file: target.file, keyPath: match.keyPath, protocol: target.protocol, defaultUpstream: target.defaultUpstream, providerLabel: match.keys[wildcardIndex] });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// URLs and route ids

/** Whether a value is already one of this gateway's route URLs. */
export function isGatewayRouteUrl(value: string, gatewayOrigin: string): boolean {
  let url: URL;
  let gateway: URL;
  try {
    url = new URL(value);
    gateway = new URL(gatewayOrigin);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const pointsAtLoopback = host === 'localhost' || isLoopbackAddress(host);
  return pointsAtLoopback && url.port === gateway.port && (url.pathname === '/r' || url.pathname.startsWith('/r/'));
}

/**
 * The route's upstream is the old value's origin; its path moves into the URL
 * the agent gets, so the agent's requests keep their full path (`/v1/…`) and
 * the relay classifies them as the provider sees them.
 */
export function splitUpstreamForRoute(upstreamValue: string, gatewayOrigin: string, routeId: string): { upstreamBaseUrl: string; agentBaseUrl: string } {
  const problem = validateUpstreamBaseUrl(upstreamValue);
  if (problem) throw new Error(problem);
  const url = new URL(upstreamValue);
  const upstreamPath = trimCharacters(url.pathname, '/', 'end');
  return { upstreamBaseUrl: url.origin, agentBaseUrl: `${gatewayOrigin}/r/${routeId}${upstreamPath}` };
}

function routeIdFor(agentId: string, providerLabel: string | undefined, taken: Set<string>): string {
  const base = providerLabel === undefined
    ? agentId
    : `${agentId}-${trimCharacters(providerLabel.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'), '-') || 'provider'}`;
  let routeId = base.slice(0, 64);
  for (let counter = 2; taken.has(routeId); counter++) {
    const suffix = `-${counter}`;
    routeId = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  if (!WIRE_GATEWAY_ROUTE_ID_PATTERN.test(routeId)) throw new Error(`cannot make a route id from "${base}"`);
  taken.add(routeId);
  return routeId;
}

// ---------------------------------------------------------------------------
// Planning a connect (reads only)

export interface PlannedFileEdit {
  key: string;
  path: string;
  format: AgentConfigFormat;
  bytesBefore: Uint8Array | null;
  bytesAfter: Uint8Array;
  /** key path → value written */
  writtenFields: Record<string, unknown>;
  /** key path → JSON text of the prior value, or STASHED_ABSENT */
  priorFields: Record<string, string>;
  createdParents: string[];
}

export interface PlannedRoute {
  routeId: string;
  fileKey: string;
  filePath: string;
  keyPath: string;
  upstreamBaseUrl: string;
  agentBaseUrl: string;
  /** Where the upstream came from: the key's value, or the agent's built-in endpoint. */
  upstreamSource: 'config' | 'default';
}

export interface ConnectionPlan {
  descriptor: AgentDescriptor;
  captureSource: WireGatewayCaptureSource;
  routes: PlannedRoute[];
  identitySwitches: Array<ResolvedIdentitySwitch & { filePath: string }>;
  fileEdits: PlannedFileEdit[];
  notes: string[];
}

function nativePathPhrase(descriptor: AgentDescriptor): string {
  return descriptor.nativeIntegration
    ? `it keeps claude-mem's native integration for ${descriptor.name} (npx claude-mem install --ide ${descriptor.id})`
    : 'it stays as it is; give it an API key to route it through the gateway';
}

/** The shortest ancestor of a key path that does not exist yet, or null. */
function firstMissingParent(file: ResolvedConfigFile, keyPath: string): string | null {
  if (file.format === 'env') return null;
  const keys = splitConfigKeyPath(keyPath).map((segment) => segment.key);
  for (let length = 1; length < keys.length; length++) {
    const parentKeyPath = joinConfigKeyPath(keys.slice(0, length));
    if (readConfigValue(file.format, file.path, file.bytes, parentKeyPath) === undefined) return parentKeyPath;
  }
  return null;
}

export function planAgentConnection(
  descriptor: AgentDescriptor,
  options: Pick<WiringOptions, 'environment' | 'gatewayOrigin' | 'routesFilePath' | 'helpers'>,
  request: { captureSource?: WireGatewayCaptureSource } = {},
): ConnectionPlan {
  const { environment } = options;
  if (descriptor.files.length === 0) {
    throw new Error(`${descriptor.name} is set by environment only: start it with \`claude-mem wire run ${descriptor.id} -- <its arguments>\``);
  }
  const files = resolveConfigFiles(descriptor, environment);
  if (!isAgentDetected(descriptor, environment, files)) {
    const where = [...files.values()].map((file) => file.path).join(', ');
    throw new Error(`${descriptor.name} was not found here (no ${where || 'config file'}${descriptor.detect.bins ? `, no ${descriptor.detect.bins.join('/')} on PATH` : ''})`);
  }
  const context = createReadContext(descriptor, environment, files);
  const targets = resolveTargets(descriptor, context, files);
  const notes: string[] = [];

  const refusal = descriptor.detectSubscription?.(context, targets) ?? null;
  if (refusal) {
    throw new Error(`${refusal}. The wire gateway never forwards subscription sign-ins, so nothing was changed: ${nativePathPhrase(descriptor)}.`);
  }

  const native = descriptor.nativeIntegration;
  const nativeInstalled = native ? native.isInstalled(environment) : false;
  if (request.captureSource === 'wire' && (nativeInstalled || native?.alwaysNative)) {
    throw new Error(
      native?.alwaysNative
        ? `${descriptor.name} is always captured by its claude-mem hooks; it cannot use --capture wire.`
        : `${descriptor.name} has claude-mem's native integration installed, and each agent has one capture source. `
          + `Remove it first (${native!.uninstallCommand}) or connect without --capture wire.`,
    );
  }
  const captureSource: WireGatewayCaptureSource = nativeInstalled || native?.alwaysNative ? 'native' : (request.captureSource ?? 'wire');

  const existingRoutes = readWireGatewayRoutesFile(options.routesFilePath).routes;
  const takenRouteIds = new Set<string>();
  const routes: PlannedRoute[] = [];
  const setsByFile = new Map<string, Array<{ keyPath: string; value: unknown }>>();
  const addSet = (fileKey: string, keyPath: string, value: unknown) => {
    const sets = setsByFile.get(fileKey) ?? [];
    sets.push({ keyPath, value });
    setsByFile.set(fileKey, sets);
  };

  for (const target of targets) {
    const file = files.get(target.file);
    if (!file) throw new Error(`${descriptor.name}: no "${target.file}" file for ${target.keyPath}`);
    const currentValue = readConfigValue(file.format, file.path, file.bytes, target.keyPath);
    const currentText = typeof currentValue === 'string' && currentValue !== '' ? currentValue : undefined;
    if (currentText !== undefined && isGatewayRouteUrl(currentText, options.gatewayOrigin)) {
      throw new Error(`${file.path}: ${target.keyPath} already points at the wire gateway (${currentText}) but claude-mem has no record of connecting it; set it back to the provider's URL by hand, then connect again`);
    }
    const upstreamValue = currentText ?? (target.defaultUpstream || undefined);
    if (!upstreamValue) {
      notes.push(`${target.keyPath} in ${file.path} is not set and ${descriptor.name} has no known default endpoint for it; not routed`);
      continue;
    }
    const routeId = routeIdFor(descriptor.id, target.providerLabel, takenRouteIds);
    const existing = Object.hasOwn(existingRoutes, routeId) ? existingRoutes[routeId] : undefined;
    if (existing && existing.agentId !== descriptor.id) {
      throw new Error(`Route "${routeId}" already belongs to agent ${existing.agentId}; remove it (claude-mem wire routes remove ${routeId}) or rename it first`);
    }
    const { upstreamBaseUrl, agentBaseUrl } = splitUpstreamForRoute(upstreamValue, options.gatewayOrigin, routeId);
    routes.push({ routeId, fileKey: file.key, filePath: file.path, keyPath: target.keyPath, upstreamBaseUrl, agentBaseUrl, upstreamSource: currentText ? 'config' : 'default' });
    addSet(file.key, target.keyPath, agentBaseUrl);
  }
  if (routes.length === 0) {
    throw new Error(`${descriptor.name} has no base URL claude-mem can route${notes.length ? `: ${notes.join('; ')}` : ''}. Set its provider's base URL first, or add a route by hand (claude-mem wire routes add).`);
  }

  const routedTargets = targets.filter((target) => routes.some((route) => route.keyPath === target.keyPath && route.fileKey === target.file));
  const computedSwitches = descriptor.resolveIdentitySwitches?.(context, routedTargets, options.helpers) ?? { switches: [], notes: [] };
  notes.push(...computedSwitches.notes);
  const identitySwitches: ConnectionPlan['identitySwitches'] = [];
  for (const identitySwitch of [...(descriptor.identitySwitches ?? []), ...computedSwitches.switches]) {
    const file = files.get(identitySwitch.file);
    if (!file) throw new Error(`${descriptor.name}: no "${identitySwitch.file}" file for ${identitySwitch.keyPath}`);
    if (Bun.deepEquals(readConfigValue(file.format, file.path, file.bytes, identitySwitch.keyPath), identitySwitch.value, true)) continue;
    identitySwitches.push({ ...identitySwitch, filePath: file.path });
    addSet(file.key, identitySwitch.keyPath, identitySwitch.value);
  }

  const fileEdits: PlannedFileEdit[] = [];
  for (const [fileKey, sets] of setsByFile) {
    const file = files.get(fileKey)!;
    const writtenFields: Record<string, unknown> = {};
    const priorFields: Record<string, string> = {};
    const createdParents = new Set<string>();
    for (const { keyPath, value } of sets) {
      writtenFields[keyPath] = value;
      const prior = readConfigValue(file.format, file.path, file.bytes, keyPath);
      priorFields[keyPath] = prior === undefined ? STASHED_ABSENT : JSON.stringify(prior);
      const missingParent = firstMissingParent(file, keyPath);
      if (missingParent) createdParents.add(missingParent);
    }
    // A parent nested in another created parent goes with it.
    const outermostParents = [...createdParents].filter((parent) => ![...createdParents].some((other) => other !== parent && parent.startsWith(`${other}.`)));
    fileEdits.push({
      key: fileKey,
      path: file.path,
      format: file.format,
      bytesBefore: file.bytes,
      bytesAfter: patchConfigBytes(file.format, file.path, file.bytes, { set: sets, delete: [] }),
      writtenFields,
      priorFields,
      createdParents: outermostParents,
    });
  }

  return { descriptor, captureSource, routes, identitySwitches, fileEdits, notes };
}

// ---------------------------------------------------------------------------
// Writing

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

/** Refuse an agent file outside the preview sandbox, so a path the sandbox did not re-root is never written for real. */
function requireConfinedAgentFile(filePath: string, confineAgentFileWritesTo: string | undefined): void {
  if (confineAgentFileWritesTo === undefined) return;
  const relation = relative(confineAgentFileWritesTo, filePath);
  if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
    throw new Error(`${filePath} is outside the preview sandbox (${confineAgentFileWritesTo}); nothing was written`);
  }
}

function wiringLockPath(wiringDirectory: string): string {
  return join(wiringDirectory, 'wiring');
}

function recordsFileGroup(options: Pick<WiringOptions, 'wiringDirectory' | 'routesFilePath'>): string[] {
  return [options.routesFilePath, appliedRecordsPath(options.wiringDirectory), stashPath(options.wiringDirectory)];
}

/** Whether every field the record says connect wrote still holds that value. */
function recordStillHolds(record: AppliedAgentRecord): boolean {
  return Object.entries(record.fields).every(([fileKey, fields]) => {
    const file = record.files[fileKey];
    if (!file) return false;
    const bytes = readConfigFileBytes(file.path);
    return Object.entries(fields).every(([keyPath, written]) => Bun.deepEquals(readConfigValue(file.format, file.path, bytes, keyPath), written, true));
  });
}

/** Write a planned connect: config files, routes, stash, applied record — all or nothing. */
export function applyConnectionPlan(plan: ConnectionPlan, options: Pick<WiringOptions, 'wiringDirectory' | 'routesFilePath' | 'now' | 'confineAgentFileWritesTo'>): void {
  const agentId = plan.descriptor.id;
  for (const edit of plan.fileEdits) requireConfinedAgentFile(edit.path, options.confineAgentFileWritesTo);
  withExclusiveFileLock(wiringLockPath(options.wiringDirectory), () => {
    atomically([...plan.fileEdits.map((edit) => edit.path), ...recordsFileGroup(options)], () => {
      for (const edit of plan.fileEdits) {
        // A file that changed since the plan was read is refused, not overwritten.
        if (!bytesEqual(readConfigFileBytes(edit.path), edit.bytesBefore)) {
          throw new Error(`${edit.path} changed while connecting; run the command again`);
        }
        if (!bytesEqual(edit.bytesBefore, edit.bytesAfter)) {
          writeFileAtomic(edit.path, edit.bytesAfter, edit.bytesBefore === null ? { mode: WIRE_GATEWAY_FILE_MODE } : {});
        }
      }
      for (const route of plan.routes) {
        addWireGatewayRoute({ routeId: route.routeId, agentId, upstreamBaseUrl: route.upstreamBaseUrl, captureSource: plan.captureSource }, options.routesFilePath);
      }
      const stashEntry: StashedAgentEntry = { files: {}, fields: {} };
      const record: AppliedAgentRecord = {
        at: (options.now?.() ?? new Date()).toISOString(),
        captureSource: plan.captureSource,
        routeIds: plan.routes.map((route) => route.routeId),
        files: {},
        fields: {},
        createdParents: {},
      };
      for (const edit of plan.fileEdits) {
        stashEntry.files[edit.key] = edit.bytesBefore === null ? STASHED_ABSENT : Buffer.from(edit.bytesBefore).toString('base64');
        stashEntry.fields[edit.key] = edit.priorFields;
        record.files[edit.key] = { path: edit.path, format: edit.format, createdByConnect: edit.bytesBefore === null, writtenSha256: sha256Hex(edit.bytesAfter) };
        record.fields[edit.key] = edit.writtenFields;
        record.createdParents[edit.key] = edit.createdParents;
      }
      updateStash(options.wiringDirectory, (agents) => {
        agents[agentId] = stashEntry;
      });
      updateAppliedRecords(options.wiringDirectory, (agents) => {
        agents[agentId] = record;
      });
    });
  });
}

export interface ConnectResult {
  plan: ConnectionPlan;
  alreadyConnected: boolean;
  /** Lines for the user beyond the plan (service install, warnings). */
  messages: string[];
}

export async function connectAgent(
  descriptor: AgentDescriptor,
  options: WiringOptions,
  request: { captureSource?: WireGatewayCaptureSource } = {},
): Promise<ConnectResult> {
  const existing = readAppliedRecords(options.wiringDirectory);
  const existingRecord = Object.hasOwn(existing, descriptor.id) ? existing[descriptor.id] : undefined;
  if (existingRecord) {
    if (!recordStillHolds(existingRecord)) {
      throw new Error(`${descriptor.name} was connected before and its config changed since; run \`claude-mem wire disconnect ${descriptor.id}\` first`);
    }
    const routes = readWireGatewayRoutesFile(options.routesFilePath).routes;
    const missingRouteIds = existingRecord.routeIds.filter((routeId) => !Object.hasOwn(routes, routeId));
    if (missingRouteIds.length > 0) {
      throw new Error(`${descriptor.name} points at route(s) ${missingRouteIds.join(', ')}, which were removed; run \`claude-mem wire disconnect ${descriptor.id}\`, then connect again`);
    }
    await options.sideEffects.ensureGatewayRunning();
    return { plan: alreadyConnectedPlan(descriptor, existingRecord, options), alreadyConnected: true, messages: [] };
  }

  const plan = planAgentConnection(descriptor, options, request);
  applyConnectionPlan(plan, options);

  const messages: string[] = [];
  try {
    await options.sideEffects.ensureGatewayRunning();
    for (const route of plan.routes) {
      const probeUrl = `${options.gatewayOrigin}/r/${route.routeId}/`;
      if (!(await options.sideEffects.probeRouteIdentity(probeUrl))) {
        throw new Error(`the gateway did not answer at ${probeUrl}`);
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await disconnectAgent(descriptor.id, options);
    } catch (undoError) {
      throw new Error(`${descriptor.name} was wired but ${reason}, and undoing it failed: ${undoError instanceof Error ? undoError.message : String(undoError)}`);
    }
    throw new Error(`${descriptor.name} was not connected: ${reason}. Its config is back as it was.`);
  }
  if (!options.sideEffects.isOsServiceInstalled()) {
    try {
      messages.push(options.sideEffects.installOsService());
    } catch (error) {
      // The worker still starts the gateway at boot while routes exist (D14).
      messages.push(`Could not install the login service (${error instanceof Error ? error.message : String(error)}); the gateway starts with the claude-mem worker instead, or run: claude-mem wire service install`);
    }
  }
  return { plan, alreadyConnected: false, messages };
}

function alreadyConnectedPlan(descriptor: AgentDescriptor, record: AppliedAgentRecord, options: Pick<WiringOptions, 'routesFilePath'>): ConnectionPlan {
  const routesFile = readWireGatewayRoutesFile(options.routesFilePath);
  return {
    descriptor,
    captureSource: record.captureSource,
    routes: record.routeIds.map((routeId) => ({
      routeId,
      fileKey: '',
      filePath: '',
      keyPath: '',
      upstreamBaseUrl: routesFile.routes[routeId].upstreamBaseUrl,
      agentBaseUrl: '',
      upstreamSource: 'config',
    })),
    identitySwitches: [],
    fileEdits: [],
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// Disconnect

export type FieldOutcome = 'restored' | 'replaced';

export interface DisconnectFieldReport {
  filePath: string;
  keyPath: string;
  outcome: FieldOutcome;
  /** For `replaced`: what the field holds now. */
  currentValue?: unknown;
}

export interface DisconnectResult {
  wasConnected: boolean;
  fields: DisconnectFieldReport[];
  removedRouteIds: string[];
  /** True when that was the last route: the daemon stopped and the service was removed. */
  lastRouteRemoved: boolean;
  messages: string[];
}

/** The bytes a file gets back: exact prior bytes when untouched since connect, else field by field. */
function disconnectedFileBytes(
  fileKey: string,
  record: AppliedAgentRecord,
  stashEntry: StashedAgentEntry,
  reports: DisconnectFieldReport[],
): { bytes: Uint8Array | null } {
  const file = record.files[fileKey];
  const fields = record.fields[fileKey] ?? {};
  const stashedFile = stashEntry.files[fileKey];
  const stashedFields = stashEntry.fields[fileKey] ?? {};
  if (stashedFile === undefined) throw new Error(`the stash holds no prior copy of ${file.path}`);
  const currentBytes = readConfigFileBytes(file.path);

  if (currentBytes !== null && sha256Hex(currentBytes) === file.writtenSha256) {
    for (const keyPath of Object.keys(fields)) reports.push({ filePath: file.path, keyPath, outcome: 'restored' });
    return { bytes: stashedFile === STASHED_ABSENT ? null : new Uint8Array(Buffer.from(stashedFile, 'base64')) };
  }

  const set: Array<{ keyPath: string; value: unknown }> = [];
  const remove: string[] = [];
  for (const [keyPath, written] of Object.entries(fields)) {
    const currentValue = readConfigValue(file.format, file.path, currentBytes, keyPath);
    if (!Bun.deepEquals(currentValue, written, true)) {
      reports.push({ filePath: file.path, keyPath, outcome: 'replaced', currentValue });
      continue;
    }
    const prior = stashedFields[keyPath];
    if (prior === undefined) throw new Error(`the stash holds no prior value for ${keyPath} in ${file.path}`);
    if (prior === STASHED_ABSENT) remove.push(keyPath);
    else set.push({ keyPath, value: JSON.parse(prior) as unknown });
    reports.push({ filePath: file.path, keyPath, outcome: 'restored' });
  }
  if (currentBytes === null) return { bytes: null };
  let bytes = set.length + remove.length > 0 ? patchConfigBytes(file.format, file.path, currentBytes, { set, delete: remove }) : currentBytes;
  // Tables/objects connect made go once nothing else lives in them; deepest first.
  const createdParents = [...(record.createdParents[fileKey] ?? [])].sort((left, right) => right.length - left.length);
  for (const parentKeyPath of createdParents) {
    const parentValue = readConfigValue(file.format, file.path, bytes, parentKeyPath);
    if (isPlainObjectValue(parentValue) && Object.keys(parentValue).length === 0) {
      bytes = patchConfigBytes(file.format, file.path, bytes, { set: [], delete: [parentKeyPath] });
    }
  }
  if (file.createdByConnect && isEmptyConfigDocument(bytes)) return { bytes: null };
  return { bytes };
}

export async function disconnectAgent(agentId: string, options: WiringOptions): Promise<DisconnectResult> {
  const reports: DisconnectFieldReport[] = [];
  const removedRouteIds: string[] = [];
  const messages: string[] = [];
  let wasConnected = false;

  withExclusiveFileLock(wiringLockPath(options.wiringDirectory), () => {
    const records = readAppliedRecords(options.wiringDirectory);
    const record = Object.hasOwn(records, agentId) ? records[agentId] : undefined;
    const agentRouteIds = Object.entries(readWireGatewayRoutesFile(options.routesFilePath).routes)
      .filter(([, route]) => route.agentId === agentId)
      .map(([routeId]) => routeId);
    if (!record) {
      // Routes made by `wire run` or by hand for this agent, with no config edits to undo.
      for (const routeId of agentRouteIds) {
        if (removeWireGatewayRoute(routeId, options.routesFilePath)) removedRouteIds.push(routeId);
      }
      return;
    }
    wasConnected = true;
    const stashEntry = requireStashedAgentEntry(options.wiringDirectory, agentId);
    const filePaths = Object.values(record.files).map((file) => file.path);
    for (const filePath of filePaths) requireConfinedAgentFile(filePath, options.confineAgentFileWritesTo);
    atomically([...filePaths, ...recordsFileGroup(options)], () => {
      for (const fileKey of Object.keys(record.files)) {
        const file = record.files[fileKey];
        const { bytes } = disconnectedFileBytes(fileKey, record, stashEntry, reports);
        const currentBytes = readConfigFileBytes(file.path);
        if (bytes === null) {
          if (currentBytes !== null) removeConfigFile(file.path);
        } else if (!bytesEqual(currentBytes, bytes)) {
          writeFileAtomic(file.path, bytes);
        }
      }
      for (const routeId of new Set([...record.routeIds, ...agentRouteIds])) {
        if (removeWireGatewayRoute(routeId, options.routesFilePath)) removedRouteIds.push(routeId);
      }
      updateStash(options.wiringDirectory, (agents) => {
        delete agents[agentId];
      });
      updateAppliedRecords(options.wiringDirectory, (agents) => {
        delete agents[agentId];
      });
    });
  });

  const remainingRoutes = Object.keys(readWireGatewayRoutesFile(options.routesFilePath).routes).length;
  const lastRouteRemoved = removedRouteIds.length > 0 && remainingRoutes === 0;
  if (lastRouteRemoved) {
    await options.sideEffects.stopGateway();
    if (options.sideEffects.isOsServiceInstalled()) messages.push(options.sideEffects.uninstallOsService());
  }
  return { wasConnected, fields: reports, removedRouteIds, lastRouteRemoved, messages };
}
