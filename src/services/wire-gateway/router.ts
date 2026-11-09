// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import type { Server } from 'bun';
import { logger } from '../../utils/logger.js';
import { checkLoopbackRequest } from './network-guard.js';
import { handleWireLaunchRequest, type WireLaunchRegistry } from './identity/launch-registry.js';
import type { WireRelayRouting } from './relay/relay.js';
import { admitTeamListenerRequest, redactClientKeyPaths, type WireSharedMode } from './shared/shared-admission.js';

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

export function jsonErrorResponse(status: number, type: string, message: string, headers?: Record<string, string>): Response {
  return Response.json({ error: { type, message } }, { status, headers });
}

/**
 * The gateway's one fetch handler. The network guard runs before routing, and
 * no response carries CORS headers.
 */
export function createWireGatewayFetchHandler(options: {
  listenHost: string;
  /** The relay for /r/<routeId>/… (Phase 2). */
  relay: (request: Request, server: Server<undefined>, routing: WireRelayRouting) => Promise<Response>;
  /** Test seam: the socket's peer address; defaults to server.requestIP. Never a header. */
  peerAddressOf?: (request: Request, server: Server<undefined>) => string | null;
  /** Launcher sessions for POST /wire/launch (Phase 4). */
  launchRegistry: WireLaunchRegistry;
  /**
   * GET /wire/status (Phase 9): each agent's drift state. It reads cached
   * probe answers only, so it never waits on a probe.
   */
  statusReport: () => Promise<unknown>;
  /**
   * GET /wire/routes (Phase 15): each route with its agent, upstream and
   * feature switches, for the viewer's Wire page. Throws when routes.json
   * cannot be read (unknown is not empty): answered 500 with why.
   */
  routesReport?: () => unknown;
  /** MCP over Streamable HTTP at /mcp (Phase 12); without one, /mcp answers 404. */
  mcp?: (request: Request) => Promise<Response>;
  /** The push endpoint POST /v1/claude-mem/events (Phase 13); without one, it answers 404. */
  pushEvents?: (request: Request) => Promise<Response>;
  /** The OTLP/HTTP JSON receiver POST /v1/traces (Phase 13); without one (CLAUDE_MEM_WIRE_GATEWAY_OTLP=false), it answers 404. */
  otlpTraces?: (request: Request) => Promise<Response>;
  /** The live call feed GET /wire/trace and GET /wire/call (Phase 13); without one, they answer 404. */
  liveTrace?: { trace: (request: Request) => Promise<Response>; call: (request: Request) => Response };
}) {
  const peerAddressOf = options.peerAddressOf ?? ((request: Request, server: Server<undefined>) => server.requestIP(request)?.address ?? null);
  return function handleWireGatewayRequest(request: Request, server: Server<undefined>): Response | Promise<Response> {
    const peerAddress = peerAddressOf(request, server);
    const { pathname } = new URL(request.url);
    const routing: WireRelayRouting = { pathname, clientKey: null };
    // The loopback listener (and a single-user gateway's only one): this
    // computer only, whatever CLAUDE_MEM_WIRE_GATEWAY_SHARED says. A shared
    // gateway's other computers use its team listener (createWireTeamListenerFetchHandler).
    const refusal = checkLoopbackRequest(request, { peerAddress, listenHost: options.listenHost });
    if (refusal) {
      // A path key never reaches a log (plan Phase 16 task 2), even here.
      logger.warn('WIRE', 'Refused request', { method: request.method, path: redactClientKeyPaths(pathname), reason: refusal });
      return jsonErrorResponse(403, 'permission_error', refusal);
    }

    if (request.method === 'GET' && (pathname === '/' || pathname === '/wire/identity')) {
      return Response.json(wireGatewayIdentity());
    }

    // `GET /r/<route>/`: connect's probe through the URL the agent was given
    // (plan Phase 8 task 2.9). No provider answers a GET on its API root, so
    // this never shadows a relayed request.
    if (request.method === 'GET' && ROUTE_ROOT_PATTERN.test(pathname)) {
      return Response.json(wireGatewayIdentity());
    }

    if (pathname === '/wire/status') {
      if (request.method !== 'GET') return jsonErrorResponse(405, 'invalid_request_error', 'GET /wire/status only');
      return options.statusReport().then(report => Response.json(report));
    }

    if (pathname === '/wire/routes' && options.routesReport) {
      if (request.method !== 'GET') return jsonErrorResponse(405, 'invalid_request_error', 'GET /wire/routes only');
      try {
        return Response.json(options.routesReport());
      } catch (error) {
        logger.warn('WIRE', 'GET /wire/routes could not read routes.json', { error: error instanceof Error ? error.message : String(error) });
        return jsonErrorResponse(500, 'api_error', `routes.json cannot be read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (pathname === '/wire/launch') {
      return handleWireLaunchRequest(request, server, options.launchRegistry);
    }

    // Every path below is this computer's only: the loopback guard refused
    // anything else (a shared gateway's members reach only the team listener).
    if (pathname === '/v1/claude-mem/events' && options.pushEvents) {
      return options.pushEvents(request);
    }

    if (pathname === '/v1/traces' && options.otlpTraces) {
      return options.otlpTraces(request);
    }

    if (pathname === '/wire/trace' && options.liveTrace) {
      // A long-poll is silent for up to 25 s by design: Bun's idle timer must not cut it.
      server.timeout(request, 0);
      return options.liveTrace.trace(request);
    }

    if (pathname === '/wire/call' && options.liveTrace) {
      return options.liveTrace.call(request);
    }

    if (pathname === '/mcp' && options.mcp) {
      // A tool call may be long and silent (a corpus build): Bun's idle timer must not cut it.
      server.timeout(request, 0);
      return options.mcp(request);
    }

    if (pathname === '/r' || pathname.startsWith('/r/')) {
      return options.relay(request, server, routing);
    }

    const family = RESERVED_PATH_FAMILIES.find(candidate => candidate.matches(pathname));
    if (family) {
      return jsonErrorResponse(404, 'not_found_error', `${family.label} is not available in this claude-mem wire gateway yet`);
    }
    return jsonErrorResponse(404, 'not_found_error', `the claude-mem wire gateway has no endpoint at ${redactClientKeyPaths(pathname)}`);
  };
}

/**
 * A shared team gateway's team listener (plan Phase 16,
 * CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST/_PORT): every request needs a client
 * key, loopback peers included, and reaches only the relay and the identity
 * probe (shared-admission.ts). Nothing here serves a keyless request, so a
 * proxy on the host that adds no forwarding header cannot make one "local".
 */
export function createWireTeamListenerFetchHandler(options: {
  shared: WireSharedMode;
  relay: (request: Request, server: Server<undefined>, routing: WireRelayRouting) => Promise<Response>;
  /** Test seam: the socket's peer address; defaults to server.requestIP. Never a header. */
  peerAddressOf?: (request: Request, server: Server<undefined>) => string | null;
}) {
  const peerAddressOf = options.peerAddressOf ?? ((request: Request, server: Server<undefined>) => server.requestIP(request)?.address ?? null);
  return async function handleWireTeamListenerRequest(request: Request, server: Server<undefined>): Promise<Response> {
    const admission = await admitTeamListenerRequest(request, {
      peerAddress: peerAddressOf(request, server),
      pathname: new URL(request.url).pathname,
      shared: options.shared,
    });
    if (admission.kind === 'refused') return jsonErrorResponse(admission.status, admission.type, admission.message, admission.headers);
    const { pathname } = admission;
    if (request.method === 'GET' && (pathname === '/' || ROUTE_ROOT_PATTERN.test(pathname))) {
      return Response.json(wireGatewayIdentity());
    }
    if (pathname === '/r' || pathname.startsWith('/r/')) {
      return options.relay(request, server, { pathname, clientKey: admission.clientKey });
    }
    return jsonErrorResponse(404, 'not_found_error', 'the team listener answers /k/<key>/r/<route>/… and the identity probe /k/<key>/ only');
  };
}
