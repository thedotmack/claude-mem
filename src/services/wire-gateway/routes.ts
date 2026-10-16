// SPDX-License-Identifier: Apache-2.0
//
// routes.json (plan D3, Phase 2 task 1): routeId → {agentId, upstreamBaseUrl,
// captureSource, features}. An agent's base URL becomes
// http://127.0.0.1:<port>/r/<routeId>; the route carries the agent's identity.

import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE, ensureWireGatewayDirs, paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

export const WIRE_GATEWAY_ROUTES_VERSION = 1;

/** magpie internal/agentplug/agentplug.go:120 `idOK` (MIT, Copyright (c) 2026 yetone). */
export const WIRE_GATEWAY_ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type WireGatewayCaptureSource = 'wire' | 'native';

export interface WireGatewayRouteFeatures {
  memoryInjection?: boolean;
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

/** A holder that has not released within this window is presumed dead. */
const ROUTES_LOCK_STALE_MS = 10_000;
const ROUTES_LOCK_MAX_WAIT_MS = 15_000;
const ROUTES_LOCK_RETRY_MS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Hold `<routes.json>.lock` across a read-modify-write, so two `routes add`
 * or `routes remove` processes cannot each write back a copy missing the
 * other's change. The `wx` (O_CREAT|O_EXCL) lock with mtime staleness is the
 * pattern of observer-health.ts withLedgerLock and worker-spawn-gate.ts, but
 * it fails loud: a route edit that cannot be serialized is refused, never
 * written unlocked.
 */
function withRoutesFileLock<T>(routesFilePath: string, mutate: () => T): T {
  const lockPath = `${routesFilePath}.lock`;
  const deadline = Date.now() + ROUTES_LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
      writeFileSync(lockPath, String(process.pid), { flag: 'wx', mode: WIRE_GATEWAY_FILE_MODE });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let lockMtimeMs: number;
    try {
      lockMtimeMs = statSync(lockPath).mtimeMs;
    } catch {
      continue; // The holder released between our create and the stat.
    }
    if (Date.now() - lockMtimeMs > ROUTES_LOCK_STALE_MS) {
      try {
        if (statSync(lockPath).mtimeMs === lockMtimeMs) unlinkSync(lockPath);
      } catch {
        // A competing waiter broke it first; the loop re-evaluates.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`routes.json is locked by another claude-mem process (${lockPath}); try again`);
    }
    sleepSync(ROUTES_LOCK_RETRY_MS);
  }
  try {
    return mutate();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already broken as stale by a waiter: nothing to release.
    }
  }
}

export interface AddWireGatewayRouteInput {
  routeId: string;
  agentId: string;
  upstreamBaseUrl: string;
  captureSource?: WireGatewayCaptureSource;
  features?: WireGatewayRouteFeatures;
}

/** Add (or replace) a route. Throws on an invalid id or upstream. */
export function addWireGatewayRoute(input: AddWireGatewayRouteInput, routesFilePath: string = paths.wireGatewayRoutes()): WireGatewayRoute {
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
  const route: WireGatewayRoute = {
    agentId: input.agentId,
    // The suffix is appended verbatim; a trailing slash here would double it.
    upstreamBaseUrl: input.upstreamBaseUrl.replace(/\/+$/, ''),
    captureSource: input.captureSource ?? 'wire',
    features: input.features ?? {},
    createdAt: new Date().toISOString(),
  };
  withRoutesFileLock(routesFilePath, () => {
    const routesFile = readWireGatewayRoutesFile(routesFilePath);
    routesFile.routes[input.routeId] = route;
    writeWireGatewayRoutesFile(routesFile, routesFilePath);
  });
  return route;
}

/** Remove a route. Returns false when there was none by that id. */
export function removeWireGatewayRoute(routeId: string, routesFilePath: string = paths.wireGatewayRoutes()): boolean {
  return withRoutesFileLock(routesFilePath, () => {
    const routesFile = readWireGatewayRoutesFile(routesFilePath);
    // Own properties only: "constructor" is a valid route id and an inherited name.
    if (!Object.hasOwn(routesFile.routes, routeId)) {
      return false;
    }
    delete routesFile.routes[routeId];
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
