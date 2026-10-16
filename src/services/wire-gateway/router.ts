// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import type { Server } from 'bun';
import { logger } from '../../utils/logger.js';
import { checkLoopbackRequest } from './network-guard.js';
import { handleWireLaunchRequest, type WireLaunchRegistry } from './identity/launch-registry.js';

declare const __DEFAULT_PACKAGE_VERSION__: string;
export const WIRE_GATEWAY_VERSION = typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined'
  ? __DEFAULT_PACKAGE_VERSION__
  : 'development';

export const WIRE_GATEWAY_IDENTITY_NAME = 'claude-mem-wire-gateway';

/** Random per process: tells a restarted gateway apart from the one a client saw before. */
const WIRE_GATEWAY_INSTANCE = randomUUID();

export interface WireGatewayIdentity {
  name: typeof WIRE_GATEWAY_IDENTITY_NAME;
  version: string;
  instance: string;
}

export function wireGatewayIdentity(): WireGatewayIdentity {
  return { name: WIRE_GATEWAY_IDENTITY_NAME, version: WIRE_GATEWAY_VERSION, instance: WIRE_GATEWAY_INSTANCE };
}

/**
 * Path families the gateway owns (plan D8). Each answers 404 until the phase
 * that builds it lands.
 */
const RESERVED_PATH_FAMILIES: Array<{ matches: (pathname: string) => boolean; label: string }> = [
  { matches: pathname => pathname === '/v1/traces', label: 'the OTLP/HTTP receiver (/v1/traces)' },
  { matches: pathname => pathname === '/v1/claude-mem/events', label: 'the push endpoint (/v1/claude-mem/events)' },
  { matches: pathname => pathname === '/mcp' || pathname.startsWith('/mcp/'), label: 'MCP over HTTP (/mcp)' },
  { matches: pathname => pathname.startsWith('/wire/'), label: 'the wire API (/wire/*)' },
];

const ROUTE_ROOT_PATTERN = /^\/r\/[^/]+\/?$/;

export function jsonErrorResponse(status: number, type: string, message: string): Response {
  return Response.json({ error: { type, message } }, { status });
}

/**
 * The gateway's one fetch handler. The network guard runs before routing, and
 * no response carries CORS headers.
 */
export function createWireGatewayFetchHandler(options: {
  listenHost: string;
  /** The relay for /r/<routeId>/… (Phase 2); without one, /r/ answers 404. */
  relay?: (request: Request, server: Server<undefined>) => Promise<Response>;
  /** Launcher sessions for POST /wire/launch (Phase 4); without one, it answers 404. */
  launchRegistry?: WireLaunchRegistry;
  /**
   * GET /wire/status (Phase 9): each agent's drift state. It reads cached
   * probe answers only, so it never waits on a probe.
   */
  statusReport?: () => Promise<unknown>;
}) {
  return function handleWireGatewayRequest(request: Request, server: Server<undefined>): Response | Promise<Response> {
    const refusal = checkLoopbackRequest(request, {
      peerAddress: server.requestIP(request)?.address ?? null,
      listenHost: options.listenHost,
    });
    if (refusal) {
      logger.warn('WIRE', 'Refused request', { method: request.method, path: new URL(request.url).pathname, reason: refusal.message });
      return jsonErrorResponse(refusal.status, 'permission_error', refusal.message);
    }

    const { pathname } = new URL(request.url);

    if (request.method === 'GET' && (pathname === '/' || pathname === '/wire/identity')) {
      return Response.json(wireGatewayIdentity());
    }

    // `GET /r/<route>/`: connect's probe through the URL the agent was given
    // (plan Phase 8 task 2.9). No provider answers a GET on its API root, so
    // this never shadows a relayed request.
    if (request.method === 'GET' && ROUTE_ROOT_PATTERN.test(pathname)) {
      return Response.json(wireGatewayIdentity());
    }

    if (pathname === '/wire/status' && options.statusReport) {
      if (request.method !== 'GET') return jsonErrorResponse(405, 'invalid_request_error', 'GET /wire/status only');
      return options.statusReport().then(report => Response.json(report));
    }

    if (pathname === '/wire/launch' && options.launchRegistry) {
      return handleWireLaunchRequest(request, server, options.launchRegistry);
    }

    if (pathname === '/r' || pathname.startsWith('/r/')) {
      return options.relay
        ? options.relay(request, server)
        : jsonErrorResponse(404, 'not_found_error', 'the relay (/r/<route>/…) is not available in this claude-mem wire gateway');
    }

    const family = RESERVED_PATH_FAMILIES.find(candidate => candidate.matches(pathname));
    if (family) {
      return jsonErrorResponse(404, 'not_found_error', `${family.label} is not available in this claude-mem wire gateway yet`);
    }
    return jsonErrorResponse(404, 'not_found_error', `the claude-mem wire gateway has no endpoint at ${pathname}`);
  };
}
