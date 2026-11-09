// SPDX-License-Identifier: Apache-2.0
//
// routes.json (plan D3, Phase 2 task 1): routeId → {agentId, upstreamBaseUrl,
// captureSource, features}. An agent's base URL becomes
// http://127.0.0.1:<port>/r/<routeId>; the route carries the agent's identity.

import { existsSync, readFileSync, statSync } from 'fs';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { WIRE_GATEWAY_FILE_MODE, ensureWireGatewayDirs, paths } from '../../shared/paths.js';
import { withExclusiveFileLock } from './edit/file-lock.js';
import { logger } from '../../utils/logger.js';

export const WIRE_GATEWAY_ROUTES_VERSION = 1;

/** magpie internal/agentplug/agentplug.go:120 `idOK` (MIT, Copyright (c) 2026 yetone). */
export const WIRE_GATEWAY_ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type WireGatewayCaptureSource = 'wire' | 'native';

export interface WireGatewayRouteFeatures {
  memoryInjection?: boolean;
  durableHeader?: boolean;
  endlessMode?: boolean;
  memorySearchTool?: boolean;
  outboundRedaction?: boolean;
}

export interface WireGatewayRoute {
  agentId: string;
  upstreamBaseUrl: string;
  captureSource: WireGatewayCaptureSource;
  features: WireGatewayRouteFeatures;
  createdAt: string;
}

export interface WireGatewayRoutesFile {
  version: typeof WIRE_GATEWAY_ROUTES_VERSION;
  routes: Record<string, WireGatewayRoute>;
}

function emptyRoutesFile(): WireGatewayRoutesFile {
  return { version: WIRE_GATEWAY_ROUTES_VERSION, routes: {} };
}

/** Returns why an upstream base URL is unusable, or null. It must be http(s) with no query or fragment. */
export function validateUpstreamBaseUrl(upstreamBaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(upstreamBaseUrl);
  } catch {
    return `upstream "${upstreamBaseUrl}" is not a URL`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `upstream "${upstreamBaseUrl}" must be http:// or https://`;
  }
  if (url.search || url.hash) {
    return `upstream "${upstreamBaseUrl}" must not carry a query or fragment; the agent's own path and query are appended to it`;
  }
  return null;
}

/**
 * Parse and check routes.json. Throws on anything malformed: an unreadable
 * file is never treated as "no routes" (unknown ≠ empty).
 */
export function parseWireGatewayRoutesFile(raw: string, sourceLabel: string): WireGatewayRoutesFile {
  const parsed = JSON.parse(raw) as Partial<WireGatewayRoutesFile>;
  if (parsed.version !== WIRE_GATEWAY_ROUTES_VERSION) {
    throw new Error(`${sourceLabel}: unsupported version ${JSON.stringify(parsed.version)} (expected ${WIRE_GATEWAY_ROUTES_VERSION})`);
  }
  if (!parsed.routes || typeof parsed.routes !== 'object' || Array.isArray(parsed.routes)) {
    throw new Error(`${sourceLabel}: "routes" must be an object`);
  }
  for (const [routeId, route] of Object.entries(parsed.routes)) {
    if (!WIRE_GATEWAY_ROUTE_ID_PATTERN.test(routeId)) {
      throw new Error(`${sourceLabel}: route id "${routeId}" must match ${WIRE_GATEWAY_ROUTE_ID_PATTERN}`);
    }
    if (!route || typeof route.agentId !== 'string' || route.agentId === '') {
      throw new Error(`${sourceLabel}: route "${routeId}" has no agentId`);
    }
    const upstreamError = typeof route.upstreamBaseUrl === 'string' ? validateUpstreamBaseUrl(route.upstreamBaseUrl) : 'no upstreamBaseUrl';
    if (upstreamError) {
      throw new Error(`${sourceLabel}: route "${routeId}": ${upstreamError}`);
    }
    if (route.captureSource !== 'wire' && route.captureSource !== 'native') {
      throw new Error(`${sourceLabel}: route "${routeId}" captureSource must be "wire" or "native"`);
    }
  }
  return parsed as WireGatewayRoutesFile;
}

/** Reads routes.json; a missing file is the empty set. Throws when the file exists but cannot be used. */
export function readWireGatewayRoutesFile(routesFilePath: string = paths.wireGatewayRoutes()): WireGatewayRoutesFile {
  if (!existsSync(routesFilePath)) {
    return emptyRoutesFile();
  }
  return parseWireGatewayRoutesFile(readFileSync(routesFilePath, 'utf-8'), routesFilePath);
}

function writeWireGatewayRoutesFile(routesFile: WireGatewayRoutesFile, routesFilePath: string): void {
  ensureWireGatewayDirs();
  writeJsonFileAtomic(routesFilePath, routesFile, { mode: WIRE_GATEWAY_FILE_MODE });
}

export interface AddWireGatewayRouteInput {
  routeId: string;
  agentId: string;
  upstreamBaseUrl: string;
  captureSource?: WireGatewayCaptureSource;
  features?: WireGatewayRouteFeatures;
}

/** routes.json paths whose lock this process holds now (see withWireGatewayRoutesFileLock). */
const routesFilePathsLockedByThisProcess = new Set<string>();

/**
 * Hold routes.json's lock across `readModifyWrite`, so a caller can read
 * routes, decide and write (or snapshot, edit and roll back) without another
 * process's `routes add` landing in between and being lost. Inside, use the
 * `…WhileRoutesFileIsLocked` helpers: the lock is not re-entrant, so the
 * locking helpers refuse (rather than wait on themselves) while it is held.
 */
export function withWireGatewayRoutesFileLock<T>(routesFilePath: string, readModifyWrite: () => T): T {
  if (routesFilePathsLockedByThisProcess.has(routesFilePath)) {
    throw new Error(`${routesFilePath} is already locked by this process; use the …WhileRoutesFileIsLocked route helpers inside the lock`);
  }
  return withExclusiveFileLock(routesFilePath, () => {
    routesFilePathsLockedByThisProcess.add(routesFilePath);
    try {
      const result = readModifyWrite();
      if (result instanceof Promise) {
        throw new Error('withWireGatewayRoutesFileLock() takes a synchronous function; an async one would outlive the lock');
      }
      return result;
    } finally {
      routesFilePathsLockedByThisProcess.delete(routesFilePath);
    }
  });
}

function requireRoutesFileLockHeld(routesFilePath: string): void {
  if (!routesFilePathsLockedByThisProcess.has(routesFilePath)) {
    throw new Error(`${routesFilePath} must be locked (withWireGatewayRoutesFileLock) before it is edited`);
  }
}

function buildWireGatewayRoute(input: AddWireGatewayRouteInput): WireGatewayRoute {
  if (!WIRE_GATEWAY_ROUTE_ID_PATTERN.test(input.routeId)) {
    throw new Error(`Route id "${input.routeId}" must match ${WIRE_GATEWAY_ROUTE_ID_PATTERN} (lowercase letters, digits, ".", "_", "-"; at most 64)`);
  }
  if (!input.agentId) {
    throw new Error('A route needs --agent <id>');
  }
  const upstreamError = validateUpstreamBaseUrl(input.upstreamBaseUrl);
  if (upstreamError) {
    throw new Error(upstreamError);
  }
  return {
    agentId: input.agentId,
    // The suffix is appended verbatim; a trailing slash here would double it.
    upstreamBaseUrl: input.upstreamBaseUrl.replace(/\/+$/, ''),
    captureSource: input.captureSource ?? 'wire',
    features: input.features ?? {},
    createdAt: new Date().toISOString(),
  };
}

/** addWireGatewayRoute for a caller already inside withWireGatewayRoutesFileLock. */
export function addWireGatewayRouteWhileRoutesFileIsLocked(input: AddWireGatewayRouteInput, routesFilePath: string): WireGatewayRoute {
  requireRoutesFileLockHeld(routesFilePath);
  const route = buildWireGatewayRoute(input);
  const routesFile = readWireGatewayRoutesFile(routesFilePath);
  routesFile.routes[input.routeId] = route;
  writeWireGatewayRoutesFile(routesFile, routesFilePath);
  return route;
}

/** removeWireGatewayRoute for a caller already inside withWireGatewayRoutesFileLock. */
export function removeWireGatewayRouteWhileRoutesFileIsLocked(routeId: string, routesFilePath: string): boolean {
  requireRoutesFileLockHeld(routesFilePath);
  const routesFile = readWireGatewayRoutesFile(routesFilePath);
  // Own properties only: "constructor" is a valid route id and an inherited name.
  if (!Object.hasOwn(routesFile.routes, routeId)) {
    return false;
  }
  delete routesFile.routes[routeId];
  writeWireGatewayRoutesFile(routesFile, routesFilePath);
  return true;
}

/** Add (or replace) a route. Throws on an invalid id or upstream. */
export function addWireGatewayRoute(input: AddWireGatewayRouteInput, routesFilePath: string = paths.wireGatewayRoutes()): WireGatewayRoute {
  // Validate before taking the lock, so a bad id or URL never waits on another process.
  buildWireGatewayRoute(input);
  return withWireGatewayRoutesFileLock(routesFilePath, () => addWireGatewayRouteWhileRoutesFileIsLocked(input, routesFilePath));
}

/** Remove a route. Returns false when there was none by that id. */
export function removeWireGatewayRoute(routeId: string, routesFilePath: string = paths.wireGatewayRoutes()): boolean {
  return withWireGatewayRoutesFileLock(routesFilePath, () => removeWireGatewayRouteWhileRoutesFileIsLocked(routeId, routesFilePath));
}

/**
 * Set (true/false) or clear (undefined: the global setting decides) one of a
 * route's features: the per-route switch, e.g. Endless Mode's kill switch.
 * A running gateway sees it within a second (WireGatewayRoutesStore).
 * Returns false when there is no route by that id.
 */
export function setWireGatewayRouteFeature(
  routeId: string,
  feature: keyof WireGatewayRouteFeatures,
  enabled: boolean | undefined,
  routesFilePath: string = paths.wireGatewayRoutes(),
): boolean {
  return withWireGatewayRoutesFileLock(routesFilePath, () => {
    const routesFile = readWireGatewayRoutesFile(routesFilePath);
    if (!Object.hasOwn(routesFile.routes, routeId)) return false;
    const route = routesFile.routes[routeId];
    const features: WireGatewayRouteFeatures = { ...(route.features ?? {}) };
    if (enabled === undefined) delete features[feature];
    else features[feature] = enabled;
    routesFile.routes[routeId] = { ...route, features };
    writeWireGatewayRoutesFile(routesFile, routesFilePath);
    return true;
  });
}

export type WireGatewayRouteLookup =
  | { kind: 'found'; route: WireGatewayRoute }
  | { kind: 'not_found' }
  | { kind: 'unreadable'; reason: string };

const ROUTES_RELOAD_CHECK_INTERVAL_MS = 1_000;

/**
 * The relay's view of routes.json. It looks at the file's mtime and size at
 * most once per second and reloads when either changed (magpie
 * internal/middleware/middleware.go:76-135 `current`/`stamp`). A file that
 * turns unreadable keeps the last good routes in force; one that was never
 * readable answers `unreadable` rather than "no such route".
 */
export class WireGatewayRoutesStore {
  private readonly routesFilePath: string;
  private readonly reloadCheckIntervalMs: number;
  private routes: Record<string, WireGatewayRoute> | null = null;
  private loadedStamp: string | null = null;
  private nextStampCheckAt = 0;
  private lastLoadError: string | null = null;

  constructor(options: { routesFilePath?: string; reloadCheckIntervalMs?: number } = {}) {
    this.routesFilePath = options.routesFilePath ?? paths.wireGatewayRoutes();
    this.reloadCheckIntervalMs = options.reloadCheckIntervalMs ?? ROUTES_RELOAD_CHECK_INTERVAL_MS;
  }

  lookup(routeId: string): WireGatewayRouteLookup {
    this.reloadIfChanged();
    if (!this.routes) {
      return { kind: 'unreadable', reason: this.lastLoadError ?? 'routes.json could not be read' };
    }
    // Own properties only: /r/constructor/... must not find Object.prototype.constructor.
    return Object.hasOwn(this.routes, routeId) ? { kind: 'found', route: this.routes[routeId] } : { kind: 'not_found' };
  }

  private fileStamp(): string {
    try {
      const stats = statSync(this.routesFilePath);
      return `${stats.mtimeMs}:${stats.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      throw error;
    }
  }

  private reloadIfChanged(): void {
    const now = Date.now();
    if (now < this.nextStampCheckAt) {
      return;
    }
    this.nextStampCheckAt = now + this.reloadCheckIntervalMs;
    let stamp: string | null = null;
    try {
      stamp = this.fileStamp();
      if (stamp === this.loadedStamp) {
        return;
      }
      this.routes = readWireGatewayRoutesFile(this.routesFilePath).routes;
      this.lastLoadError = null;
    } catch (error) {
      // Keep the last good routes; lookups report the error only when there are none.
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastLoadError = err.message;
      logger.warn('WIRE', 'routes.json could not be read; keeping the last good routes', { path: this.routesFilePath }, err);
    } finally {
      // A broken file is not re-read until it changes again.
      if (stamp !== null) this.loadedStamp = stamp;
    }
  }
}
