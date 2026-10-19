// SPDX-License-Identifier: Apache-2.0
//
// Launcher sessions (plan Phase 4 task 10, D8 `/r/<route>/l/<launchId>/…`).
// `POST /wire/launch {agentId, cwd}` (loopback only) hands out a launch id;
// an agent started with the base URL `/r/<route>/l/<launchId>` then has its
// session (`sessionSource:'launch'`) and folder fixed by the launch, whatever
// its requests say. Launches live in memory and expire after 24 h idle.

import { randomBytes } from 'crypto';
import { isAbsolute } from 'path';
import type { Server } from 'bun';
import { WIRE_GATEWAY_ROUTE_ID_PATTERN } from '../routes.js';
import { isLoopbackAddress } from '../network-guard.js';
import { readBoundedRequestBody } from '../relay/request-body.js';

export const LAUNCH_IDLE_EXPIRY_MS = 24 * 60 * 60 * 1000;
/** Launches held at once; past it the least recently used is forgotten (it still relays, by its requests' own session). */
export const MAX_LIVE_LAUNCHES = 10_000;

const LAUNCH_ID_BYTES = 16;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** 16 random bytes in lower-case RFC 4648 base32 without padding: 26 characters. */
export const LAUNCH_ID_PATTERN = /^[a-z2-7]{26}$/;

/** `/l/<launchId>` at the start of a route suffix, and what follows it. */
const LAUNCH_SEGMENT_PATTERN = /^\/l\/([a-z2-7]{26})(\/.*)?$/;

function base32Lowercase(bytes: Uint8Array): string {
  let bits = 0;
  let bitCount = 0;
  let encoded = '';
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      encoded += BASE32_ALPHABET[(bits >>> (bitCount - 5)) & 31];
      bitCount -= 5;
    }
  }
  if (bitCount > 0) encoded += BASE32_ALPHABET[(bits << (5 - bitCount)) & 31];
  return encoded;
}

export function newLaunchId(): string {
  return base32Lowercase(randomBytes(LAUNCH_ID_BYTES));
}

/**
 * Split a route suffix into its launch id (when it starts with
 * `/l/<launchId>`) and the suffix that goes upstream.
 */
export function splitLaunchSegment(suffixPath: string): { launchId: string | null; upstreamSuffixPath: string } {
  const match = LAUNCH_SEGMENT_PATTERN.exec(suffixPath);
  return match ? { launchId: match[1], upstreamSuffixPath: match[2] ?? '' } : { launchId: null, upstreamSuffixPath: suffixPath };
}

export interface WireLaunch {
  launchId: string;
  agentId: string;
  cwd: string;
  createdAt: number;
  lastUsedAt: number;
  /** Requests relayed through the launch; `wire run` warns when its agent sent none. */
  requestCount: number;
}

export class WireLaunchRegistry {
  private readonly launches = new Map<string, WireLaunch>();
  private readonly idleExpiryMs: number;
  private readonly now: () => number;

  private readonly maxLiveLaunches: number;

  constructor(options: { idleExpiryMs?: number; maxLiveLaunches?: number; now?: () => number } = {}) {
    this.idleExpiryMs = options.idleExpiryMs ?? LAUNCH_IDLE_EXPIRY_MS;
    this.maxLiveLaunches = options.maxLiveLaunches ?? MAX_LIVE_LAUNCHES;
    this.now = options.now ?? Date.now;
  }

  create(input: { agentId: string; cwd: string }): WireLaunch {
    this.forgetExpired();
    // The Map keeps use order (use() re-inserts), so its first key is the least recently used.
    while (this.launches.size >= this.maxLiveLaunches) {
      this.launches.delete(this.launches.keys().next().value!);
    }
    const now = this.now();
    const launch: WireLaunch = { launchId: newLaunchId(), agentId: input.agentId, cwd: input.cwd, createdAt: now, lastUsedAt: now, requestCount: 0 };
    this.launches.set(launch.launchId, launch);
    return launch;
  }

  /** The launch, without touching it; undefined when unknown or expired. */
  peek(launchId: string): WireLaunch | undefined {
    this.forgetExpired();
    return this.launches.get(launchId);
  }

  /** The launch a request came through, touched so it stays alive and counted; undefined when unknown or expired. */
  use(launchId: string): WireLaunch | undefined {
    this.forgetExpired();
    const launch = this.launches.get(launchId);
    if (!launch) return undefined;
    launch.lastUsedAt = this.now();
    launch.requestCount++;
    this.launches.delete(launchId);
    this.launches.set(launchId, launch);
    return launch;
  }

  get size(): number {
    return this.launches.size;
  }

  /** Oldest use first, so the sweep stops at the first launch still alive. */
  private forgetExpired(): void {
    const now = this.now();
    for (const [launchId, launch] of this.launches) {
      if (now - launch.lastUsedAt <= this.idleExpiryMs) break;
      this.launches.delete(launchId);
    }
  }
}

const LAUNCH_REQUEST_MAX_BYTES = 64 * 1024;
const LAUNCH_REQUEST_IDLE_TIMEOUT_MS = 10_000;
const MAX_LAUNCH_CWD_LENGTH = 4096;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

function launchErrorResponse(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

/**
 * `POST /wire/launch {agentId, cwd}` → `{launchId}`; `GET /wire/launch?launchId=`
 * → `{requestCount}`. Loopback callers only, in every listen mode.
 */
export async function handleWireLaunchRequest(request: Request, server: Server<undefined>, registry: WireLaunchRegistry): Promise<Response> {
  if (request.method !== 'POST' && request.method !== 'GET') {
    return launchErrorResponse(405, 'invalid_request_error', 'POST /wire/launch {"agentId","cwd"}, or GET /wire/launch?launchId=');
  }
  const peerAddress = server.requestIP(request)?.address ?? null;
  if (!peerAddress || !isLoopbackAddress(peerAddress)) {
    return launchErrorResponse(403, 'permission_error', 'claude-mem wire launches are made from this computer only');
  }
  if (request.method === 'GET') {
    const launch = registry.peek(new URL(request.url).searchParams.get('launchId') ?? '');
    return launch
      ? Response.json({ requestCount: launch.requestCount })
      : launchErrorResponse(404, 'not_found_error', 'no such launch (unknown or expired)');
  }
  const bodyRead = await readBoundedRequestBody(request, { maxRequestBytes: LAUNCH_REQUEST_MAX_BYTES, idleTimeoutMs: LAUNCH_REQUEST_IDLE_TIMEOUT_MS });
  if (bodyRead.kind !== 'read') {
    return launchErrorResponse(bodyRead.kind === 'too_large' ? 413 : 408, 'invalid_request_error', 'the launch request body was too large or stalled');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bodyRead.body));
  } catch {
    return launchErrorResponse(400, 'invalid_request_error', 'the launch request body must be JSON {"agentId","cwd"}');
  }
  const { agentId, cwd } = (parsed ?? {}) as { agentId?: unknown; cwd?: unknown };
  if (typeof agentId !== 'string' || !WIRE_GATEWAY_ROUTE_ID_PATTERN.test(agentId)) {
    return launchErrorResponse(400, 'invalid_request_error', `agentId must match ${WIRE_GATEWAY_ROUTE_ID_PATTERN}`);
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.length > MAX_LAUNCH_CWD_LENGTH || CONTROL_CHARACTER_PATTERN.test(cwd)) {
    return launchErrorResponse(400, 'invalid_request_error', 'cwd must be an absolute path');
  }
  const launch = registry.create({ agentId, cwd });
  return Response.json({ launchId: launch.launchId });
}
