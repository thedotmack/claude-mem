// SPDX-License-Identifier: Apache-2.0
//
// The byte-faithful relay (plan D3, Phase 2): agent → /r/<routeId>/<suffix> →
// upstreamBaseUrl + suffix. The agent's own credentials go upstream; request
// and response bytes are passed through untouched. Copies magpie's
// credential-preserving relay `codexUpstreamOn`
// (internal/gateway/codex_backend.go:667-967; `copyHeaders` :1151-1157,
// `hopHeader` :1062-1068; MIT, Copyright (c) 2026 yetone), never its
// `forwardOnce`/`Sign` path, which signs with magpie's own credentials.

import { randomUUID } from 'crypto';
import type { Server } from 'bun';
import { logger } from '../../../utils/logger.js';
import type { WireGatewayRoute, WireGatewayRoutesStore } from '../routes.js';
import { BoundedCaptureQueue, CAPTURE_SPOOL_CAP_BYTES } from './capture-queue.js';
import {
  StreamEndMarkerDetector,
  classifyRelaySuffix,
  errorEnvelopeFamilyOf,
  EventStreamSniffer,
  isEventStreamContentType,
  replyKindContentType,
  protocolErrorResponse,
  type WireProtocol,
} from './protocols.js';
import { decodeRequestBodyCopy, readBoundedRequestBody, type DecodedBodyCopy } from './request-body.js';
import { detectSubscriptionSignIn, subscriptionRefusalMessage } from './subscription-guard.js';
import { parseWireRequest } from '../ir/request-parsers.js';
import type { WireRequest } from '../ir/types.js';
import { splitLaunchSegment, type WireLaunch, type WireLaunchRegistry } from '../identity/launch-registry.js';
import { resolveIdentity, sessionIdToEcho, type WireIdentity } from '../identity/resolve-identity.js';
import { CLAUDE_MEM_SESSION_HEADER } from '../identity/session-id.js';
import type { OutboundRedactionPlaceholders } from '../privacy/outbound-redaction.js';
import { PlaceholderRestoringResponse } from '../privacy/placeholder-restoring-response.js';
import type { WireConversationLedger, WireConversationLedgerView } from '../ledger/conversation-ledger.js';
import type { WireRewriteRun, WireRewriteSeam } from '../rewrite/rewrite-stage.js';
import { ResponseStageTransform } from '../rewrite/response-stage-transform.js';
import { toolPairingProblem } from '../rewrite/tool-pairing.js';

// ---------------------------------------------------------------------------
// Header policy (magpie `hopHeader` + `copyHeaders`)

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
]);

/**
 * Every request header goes upstream except hop-by-hop ones, content-length
 * (fetch sets it from the body), host (Bun sends an explicit host verbatim,
 * report 08 §Q3), accept-encoding (deleted so upstream answers in identity)
 * and the gateway's own x-claude-mem-* headers.
 */
export function upstreamRequestHeaders(incoming: Headers): Headers {
  const forwarded = new Headers();
  incoming.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName)) return;
    if (lowerName === 'content-length' || lowerName === 'host' || lowerName === 'accept-encoding') return;
    if (lowerName.startsWith('x-claude-mem-')) return;
    forwarded.append(name, value);
  });
  return forwarded;
}

/** Every response header comes back except hop-by-hop ones and content-length (the body is re-framed). */
export function clientResponseHeaders(upstream: Headers): Headers {
  const copied = new Headers();
  upstream.forEach((value, name) => {
    const lowerName = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerName) || lowerName === 'content-length') return;
    if (lowerName === 'set-cookie') return; // appended one by one below
    copied.append(name, value);
  });
  for (const cookie of upstream.getSetCookie()) {
    copied.append('set-cookie', cookie);
  }
  return copied;
}

// ---------------------------------------------------------------------------
// Observers (the seam later phases record through)

export interface RelayExchange {
  exchangeId: string;
  routeId: string;
  agentId: string;
  protocol: WireProtocol | null;
  /** True when a later phase may record this exchange (classified captured, a `wire` route, and the body decoded). */
  captured: boolean;
  /**
   * A model call of a known protocol on any route: its reply is copied to
   * observers so its usage is metered (plan Phase 10), and recorded only
   * when `captured` too.
   */
  metered: boolean;
  method: string;
  /** Path after /r/<routeId> (and after a launch segment); the query is never kept (it can hold an API key). */
  suffixPath: string;
  startedAt: number;
  /** The decoded request body for parsing; null when not captured. Never the forwarded bytes. */
  decodedRequestBody: Uint8Array | null;
  /** Why capture was skipped for a captured protocol, when it was. */
  captureSkippedReason: Extract<DecodedBodyCopy, { kind: 'skipped' }>['reason'] | 'native_capture_source' | null;
  /**
   * The decoded request body, parsed, for a captured protocol on any route
   * (a native route's body is parsed for identity and later rewrites, never
   * recorded). Null when the protocol is relay-only or the body did not
   * decode or parse.
   */
  request: WireRequest | null;
  /** Who sent the request and where it belongs (Phase 4). */
  identity: WireIdentity;
  /** What the rewrite stages did to the request (plan Phase 10). */
  rewrite: RelayExchangeRewrite;
}

export interface RelayExchangeRewrite {
  /** The stages whose bytes went upstream, in order; empty when none did. */
  appliedStageNames: string[];
  injectedTokensEst: number;
  swappedTokensEst: number;
  /** The forwarded body parsed, when the stages changed it; null when what went is `request`'s body. */
  forwardedRequest: WireRequest | null;
}

export type RelayOutcome =
  /** The response ended whole (its end marker passed, or the body ended for a non-stream reply). */
  | 'complete'
  /** Upstream ended or broke before its end marker. Never "fixed" with a synthetic end. */
  | 'cut'
  /** The client left before the end (recorded as 499). */
  | 'client_aborted'
  /** Upstream could not be reached; the client got a 502. */
  | 'upstream_unreachable';

export interface RelayExchangeResult {
  outcome: RelayOutcome;
  /** The upstream status; 499 for a client abort before the end; 502 when unreachable. */
  recordedStatus: number;
  endMarkerSeen: boolean;
  /** The capture copy outgrew the 8 MiB queue, so the capture is cut (the client was not). */
  captureOverflowed: boolean;
  responseBytes: number;
  durationMs: number;
  /** When the first response byte went to the client; null when none did. Stamped here, not in an observer, so it never trails durationMs. */
  firstResponseChunkAt: number | null;
}

/** What the upstream answered, before its body (the reply collectors need its content type). */
export interface RelayResponseStart {
  status: number;
  contentType: string | null;
}

export interface RelayObserver {
  onExchangeStarted?(exchange: RelayExchange): void;
  /** Upstream answered; called before any of its body's chunks. */
  onResponseStarted?(exchange: RelayExchange, response: RelayResponseStart): void;
  /** A copy of each response chunk of a captured exchange, delivered off the client's path. */
  onResponseChunk?(exchange: RelayExchange, chunk: Uint8Array): void;
  /** Delivered after every chunk of the exchange. */
  onExchangeFinished?(exchange: RelayExchange, result: RelayExchangeResult): void;
}

/** Bodies relayed untouched whose capture was skipped, by reason (plan Phase 2 task 3, "counted"). */
export const relayCaptureSkipCounts: Record<string, number> = {};

/**
 * Process-lifetime counters for the gateway's content-free telemetry
 * (plan Phase 6 task 4): how many exchanges were relayed, and how many had
 * their request rewritten (a rewrite stage's bytes went upstream, or
 * outbound redaction masked something; a request counts once).
 */
export const relayActivityCounts = { exchangesRelayed: 0, requestsRewritten: 0 };

function countCaptureSkip(reason: string): void {
  relayCaptureSkipCounts[reason] = (relayCaptureSkipCounts[reason] ?? 0) + 1;
}

/** One observer that hands every event to each of `observers` in order. */
export function composeRelayObservers(...observers: RelayObserver[]): RelayObserver {
  return {
    onExchangeStarted: exchange => observers.forEach(observer => observer.onExchangeStarted && notifyObserver(() => observer.onExchangeStarted!(exchange))),
    onResponseStarted: (exchange, response) => observers.forEach(observer => observer.onResponseStarted && notifyObserver(() => observer.onResponseStarted!(exchange, response))),
    onResponseChunk: (exchange, chunk) => observers.forEach(observer => observer.onResponseChunk && notifyObserver(() => observer.onResponseChunk!(exchange, chunk))),
    onExchangeFinished: (exchange, result) => observers.forEach(observer => observer.onExchangeFinished && notifyObserver(() => observer.onExchangeFinished!(exchange, result))),
  };
}

function notifyObserver(callback: () => void): void {
  try {
    callback();
  } catch (error) {
    logger.error('WIRE', 'Relay observer failed', {}, error instanceof Error ? error : new Error(String(error)));
  }
}

// ---------------------------------------------------------------------------
// The relay

export interface WireGatewayRelayOptions {
  routesStore: WireGatewayRoutesStore;
  maxRequestBytes: number;
  requestBodyIdleTimeoutMs: number;
  observer?: RelayObserver;
  captureSpoolCapBytes?: number;
  /** Launches made through POST /wire/launch; without one, /l/<launchId> segments are still stripped. */
  launchRegistry?: WireLaunchRegistry;
  /**
   * Outbound redaction (plan Phase 6 task 3): the placeholder table, and
   * whether a route without its own `features.outboundRedaction` gets it
   * (CLAUDE_MEM_WIRE_GATEWAY_OUTBOUND_REDACTION). Absent: never.
   */
  outboundRedaction?: { placeholders: OutboundRedactionPlaceholders; enabledByDefault: boolean };
  /**
   * Told the agent of every request that names a known route, before
   * anything else is checked (plan Phase 9 task 1, lastSeen). Must not block.
   */
  noteRequestFromAgent?: (agentId: string) => void;
  /** CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS: forward subscription sign-ins (logged) instead of refusing them (plan D4). */
  forwardSubscriptionSignIns?: boolean;
  /** The rewrite stages (plan Phase 10); absent or empty, every body goes as it came (outbound redaction aside). */
  rewriteSeam?: WireRewriteSeam;
  /** Where each conversation's rewrites are kept; without one, stages see no ledger and so rewrite nothing that needs one. */
  conversationLedger?: WireConversationLedger;
  /** The gateway's settings, handed to stages as `context.settings`. */
  rewriteSettings?: Readonly<Record<string, string>>;
}

const ROUTE_PATH_PATTERN = /^\/r\/([^/]+)(\/.*)?$/;

/**
 * The conversation's ledger, or null (no ledger kept, a request with no
 * conversation ledger, or one that could not be opened: rewrites that need
 * a ledger then do nothing).
 */
function openConversationLedger(
  conversationLedger: WireConversationLedger | undefined,
  identity: WireIdentity,
  parsedRequest: WireRequest,
  routeId: string,
): WireConversationLedgerView | null {
  if (!conversationLedger) return null;
  try {
    return conversationLedger.open(identity, parsedRequest);
  } catch (error) {
    logger.warn('WIRE', 'Could not open a conversation ledger; the request is not rewritten', {
      routeId, agentId: identity.agentId, error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// How a cut reaches the client. Bun.serve ends a response cleanly (`0\r\n\r\n`)
// even when its body stream errors (probed on 1.3.9: controller.error, a
// throwing pull, a throwing async generator, a direct stream), which a client
// would read as a whole reply. What Bun.serve does tear down mid-response is
// its idle timer (report 08 §Q2, https://bun.sh/docs/api/http#idletimeout), so
// a cut leaves the body pending and re-arms the per-request timer at 1 s: the
// connection then closes without a terminating chunk and the client's read
// fails. uSockets' timer granularity makes that about 4 s on 1.3.9.
const CUT_SIGNAL_IDLE_TIMEOUT_SECONDS = 1;
const UNREAD_BODY_CLOSE_IDLE_TIMEOUT_SECONDS = 1;

export function createWireGatewayRelay(options: WireGatewayRelayOptions) {
  const captureSpoolCapBytes = options.captureSpoolCapBytes ?? CAPTURE_SPOOL_CAP_BYTES;

  return async function relayWireGatewayRequest(request: Request, server: Server<undefined>): Promise<Response> {
    const requestUrl = new URL(request.url);
    const routeMatch = ROUTE_PATH_PATTERN.exec(requestUrl.pathname);
    // A launched agent's base URL is /r/<routeId>/l/<launchId>; the launch
    // segment names its session and never goes upstream.
    const { launchId, upstreamSuffixPath: suffixPath } = splitLaunchSegment(routeMatch?.[2] ?? '');
    const classification = classifyRelaySuffix(suffixPath);
    const errorFamily = errorEnvelopeFamilyOf(classification.protocol);

    if (!routeMatch) {
      return protocolErrorResponse(errorFamily, {
        status: 404,
        message: 'the claude-mem wire gateway relays at /r/<routeId>/…; see `claude-mem wire routes list`',
      });
    }
    const routeId = routeMatch[1];
    const lookup = options.routesStore.lookup(routeId);
    if (lookup.kind === 'unreadable') {
      return protocolErrorResponse(errorFamily, {
        status: 503,
        message: `the claude-mem wire gateway cannot read its routes (${lookup.reason}); fix or remove routes.json`,
      });
    }
    if (lookup.kind === 'not_found') {
      return protocolErrorResponse(errorFamily, {
        status: 404,
        message: `the claude-mem wire gateway has no route "${routeId}"; see \`claude-mem wire routes list\``,
      });
    }
    const route: WireGatewayRoute = lookup.route;
    if (options.noteRequestFromAgent) notifyObserver(() => options.noteRequestFromAgent!(route.agentId));
    let launch: WireLaunch | undefined;
    if (launchId) {
      launch = options.launchRegistry?.use(launchId);
      // An expired or unknown launch still relays: the agent keeps working
      // and its session falls back to what the request says.
      if (!launch) logger.warn('WIRE', 'Relaying for an unknown or expired launch', { routeId, agentId: route.agentId });
    }
    // The suffix and query go upstream verbatim (plan D3). A hand-edited
    // routes.json may keep a trailing slash that `routes add` would have trimmed.
    const upstreamBaseUrl = route.upstreamBaseUrl.replace(/\/+$/, '');
    const upstreamUrl = new URL(`${upstreamBaseUrl}${suffixPath}${requestUrl.search}`);

    // Refuse subscription sign-ins before anything is read or forwarded (plan D4),
    // unless the operator lifted D4 on this machine.
    const subscription = detectSubscriptionSignIn(request.headers, upstreamUrl);
    if (subscription && options.forwardSubscriptionSignIns) {
      logger.info('WIRE', 'Forwarding a subscription sign-in (CLAUDE_MEM_WIRE_GATEWAY_FORWARD_SUBSCRIPTION_SIGNINS=true)', { routeId, agentId: route.agentId, marker: subscription.marker });
    } else if (subscription) {
      logger.warn('WIRE', 'Refused a subscription sign-in', { routeId, agentId: route.agentId, marker: subscription.marker });
      return protocolErrorResponse(classification.protocol ? errorFamily : subscription.vendorFamily, {
        status: 403,
        message: subscriptionRefusalMessage(subscription, route.agentId),
        openAiCode: 'claude_mem_subscription_signin_refused',
        headers: { connection: 'close' },
      });
    }

    // The relay is HTTP only. Codex on a ChatGPT sign-in tries a WebSocket to
    // /responses first; relayed, the vendor answers 405 and Codex retries for
    // ~12 s with backoff. 426 Upgrade Required makes it fall back to HTTP
    // streaming after one try (both seen live, codex-cli 0.162.1).
    if ((request.headers.get('upgrade') ?? '').toLowerCase().includes('websocket')) {
      logger.debug('WIRE', 'Refused a WebSocket upgrade; the agent falls back to HTTP', { routeId, agentId: route.agentId, suffixPath });
      return protocolErrorResponse(errorFamily, {
        status: 426,
        message: 'the claude-mem wire gateway relays HTTP only; use HTTP streaming',
        headers: { connection: 'close' },
      });
    }

    // Model replies have long silent gaps (thinking, queueing): Bun's idle
    // timer must never cut a relayed request. server.timeout(req, 0)
    // disables it per request (Bun ≥1.1.27, report 08 §Q2,
    // https://bun.sh/docs/api/http#server-timeout-request-seconds). The body
    // read below keeps its own idle bound.
    server.timeout(request, 0);

    const bodyRead = await readBoundedRequestBody(request, {
      maxRequestBytes: options.maxRequestBytes,
      idleTimeoutMs: options.requestBodyIdleTimeoutMs,
    });
    if (bodyRead.kind !== 'read') {
      // The rest of the body was never read. Bun.serve ignores a response's
      // `connection: close` and keeps parsing that body, so a client that
      // reuses the connection gets a 400 (probed on 1.3.9). Re-arming the
      // idle timer closes the connection once the client goes quiet.
      server.timeout(request, UNREAD_BODY_CLOSE_IDLE_TIMEOUT_SECONDS);
    }
    if (bodyRead.kind === 'too_large') {
      return protocolErrorResponse(errorFamily, {
        status: 413,
        message: `request body is over the claude-mem wire gateway limit of ${bodyRead.limitBytes} bytes (CLAUDE_MEM_WIRE_GATEWAY_MAX_REQUEST_BYTES); the provider was not asked`,
        headers: { connection: 'close' },
      });
    }
    if (bodyRead.kind === 'idle_timeout') {
      return protocolErrorResponse(errorFamily, {
        status: 408,
        message: `the request body stalled for ${Math.round(bodyRead.idleTimeoutMs / 1000)} s; the claude-mem wire gateway stopped reading it and the provider was not asked`,
        headers: { connection: 'close' },
      });
    }
    const originalBody = bodyRead.body;

    let decodedRequestBody: Uint8Array | null = null;
    let parsedRequest: WireRequest | null = null;
    let captureSkippedReason: RelayExchange['captureSkippedReason'] = null;
    let decodedCopy: DecodedBodyCopy | null = null;
    if (classification.captured && classification.protocol) {
      // Decoded on every route: a native route is never recorded, but its
      // identity (and Phase 10's rewrites) still read the body.
      const decoded = decodeRequestBodyCopy(originalBody, request.headers.get('content-encoding'), options.maxRequestBytes);
      decodedCopy = decoded;
      if (route.captureSource !== 'wire') {
        captureSkippedReason = 'native_capture_source';
      } else if (decoded.kind === 'decoded') {
        decodedRequestBody = decoded.bytes;
      } else {
        captureSkippedReason = decoded.reason;
        countCaptureSkip(decoded.reason);
        logger.debug('WIRE', 'Relaying a body untouched without capture', { routeId, reason: decoded.reason, contentEncoding: decoded.contentEncoding });
      }
      if (decoded.kind === 'decoded') {
        try {
          parsedRequest = parseWireRequest(classification.protocol, decoded.bytes, { suffixPath });
        } catch (error) {
          logger.debug('WIRE', 'Request body did not parse; identity comes from headers', {
            routeId, protocol: classification.protocol, error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const identity = resolveIdentity(route, request.headers, parsedRequest, { suffixPath, launch });
    const methodHasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const forwardedHeaders = upstreamRequestHeaders(request.headers);
    let forwardedBody = originalBody;
    let requestRewritten = false;

    // The rewrite stages (plan Phase 10, D7): they edit the decoded body by
    // byte splices and FAIL OPEN: on any error, overrun or broken tool pair
    // the original bytes go upstream.
    const rewriteOutcome: RelayExchangeRewrite = { appliedStageNames: [], injectedTokensEst: 0, swappedTokensEst: 0, forwardedRequest: null };
    let rewriteRun: WireRewriteRun | null = null;
    let stagedBody: Uint8Array | null = null;
    // With no stage registered nothing is opened or written: a conversation
    // first seen after stages exist is judged by that request (unknown ≠ empty).
    if (options.rewriteSeam && options.rewriteSeam.stages.length > 0 && classification.protocol && parsedRequest && methodHasBody && decodedCopy?.kind === 'decoded') {
      const protocol = classification.protocol;
      const decodedBody = decodedCopy.bytes;
      const parsedByBody = new Map<Uint8Array, WireRequest>([[decodedBody, parsedRequest]]);
      const requestOf = (body: Uint8Array): WireRequest => {
        let parsed = parsedByBody.get(body);
        if (!parsed) {
          parsed = parseWireRequest(protocol, body, { suffixPath });
          parsedByBody.set(body, parsed);
        }
        return parsed;
      };
      try {
        const ledger = openConversationLedger(options.conversationLedger, identity, parsedRequest, routeId);
        rewriteRun = options.rewriteSeam.begin({
          routeId, route, identity, ledger, protocol, settings: options.rewriteSettings ?? {}, requestOf,
        });
        if (rewriteRun) {
          const staged = await rewriteRun.runRequestStages(decodedBody);
          if (staged.rejection) {
            return protocolErrorResponse(errorFamily, {
              status: staged.rejection.status,
              message: staged.rejection.message,
              openAiCode: 'claude_mem_rewrite_rejected',
            });
          }
          if (staged.body !== decodedBody) {
            let pairingProblem: string | null;
            try {
              pairingProblem = toolPairingProblem(parsedRequest, requestOf(staged.body));
            } catch (error) {
              pairingProblem = `the rewritten body does not parse: ${error instanceof Error ? error.message : String(error)}`;
            }
            if (pairingProblem) {
              options.rewriteSeam.health.noteFailure('pairing-check', 'afterRequestStages', new Error(`${pairingProblem}; the original body was sent`));
              rewriteRun.discardEstimates();
            } else {
              stagedBody = staged.body;
              rewriteOutcome.appliedStageNames = staged.appliedStageNames;
              rewriteOutcome.forwardedRequest = requestOf(staged.body);
            }
          }
          // The ledger keeps only rewrites whose bytes go (or stage records
          // that changed nothing): a kept one is re-applied on every later request.
          if (stagedBody || staged.body === decodedBody) rewriteRun.commitLedgerEntries();
          else rewriteRun.discardLedgerEntries();
          rewriteOutcome.injectedTokensEst = rewriteRun.estimates.injectedTokens;
          rewriteOutcome.swappedTokensEst = rewriteRun.estimates.swappedTokens;
        }
      } catch (error) {
        // A bug in the seam itself: the original bytes go (D7.7).
        logger.error('WIRE', 'The rewrite seam failed; the request went as it came', { routeId, agentId: route.agentId },
          error instanceof Error ? error : new Error(String(error)));
        rewriteRun?.discardLedgerEntries();
        stagedBody = null;
        rewriteOutcome.appliedStageNames = [];
        rewriteOutcome.forwardedRequest = null;
        rewriteOutcome.injectedTokensEst = 0;
        rewriteOutcome.swappedTokensEst = 0;
      }
      if (stagedBody) {
        // Forwarded decoded once rewritten (content-encoding dropped; fetch sets the length).
        forwardedBody = stagedBody;
        forwardedHeaders.delete('content-encoding');
        requestRewritten = true;
      }
    }
    const outboundRedaction = options.outboundRedaction;
    const outboundRedactionOn = outboundRedaction !== undefined
      && (route.features?.outboundRedaction ?? outboundRedaction.enabledByDefault);
    if (outboundRedaction && outboundRedactionOn && methodHasBody && originalBody.length > 0) {
      // The one opt-in edit of a forwarded body: secrets become placeholders,
      // by byte splices of string values. A compressed body is forwarded
      // decoded once masked (content-encoding dropped; fetch sets the length).
      // FAIL CLOSED: the user turned this on so secrets never reach the
      // provider, so a body that cannot be decoded or masked is refused, not
      // sent as it came. (D7.7's fail-open covers Endless Mode, injection and
      // the hidden tool, where the original bytes are the safe choice; here
      // they are the leak.)
      const decodedForMasking: DecodedBodyCopy = stagedBody
        ? { kind: 'decoded', bytes: stagedBody, contentEncoding: 'identity' }
        : decodedCopy ?? decodeRequestBodyCopy(originalBody, request.headers.get('content-encoding'), options.maxRequestBytes);
      let refusalReason: string | null = null;
      if (decodedForMasking.kind === 'decoded') {
        try {
          const masked = outboundRedaction.placeholders.maskRequestBody(decodedForMasking.bytes);
          if (masked.changed) {
            forwardedBody = masked.bytes;
            forwardedHeaders.delete('content-encoding');
            requestRewritten = true;
          }
        } catch (error) {
          logger.error('WIRE', 'Outbound redaction failed; the request was refused, not sent unmasked', { routeId, agentId: route.agentId },
            error instanceof Error ? error : new Error(String(error)));
          refusalReason = 'masking failed';
        }
      } else {
        logger.error('WIRE', 'Outbound redaction could not decode the request body; the request was refused, not sent unmasked', {
          routeId, agentId: route.agentId, reason: decodedForMasking.reason, contentEncoding: decodedForMasking.contentEncoding,
        });
        refusalReason = `the body could not be decoded (${decodedForMasking.reason}, content-encoding "${decodedForMasking.contentEncoding}")`;
      }
      if (refusalReason !== null) {
        return protocolErrorResponse(errorFamily, {
          status: 502,
          message: `claude-mem outbound redaction is on for route "${routeId}" and ${refusalReason}, so the request was not sent to the provider; `
            + 'send it uncompressed, or turn outbound redaction off for this route',
          openAiCode: 'claude_mem_outbound_redaction_failed',
        });
      }
    }

    if (requestRewritten) relayActivityCounts.requestsRewritten++;

    const exchange: RelayExchange = {
      exchangeId: randomUUID(),
      routeId,
      agentId: route.agentId,
      protocol: classification.protocol,
      captured: decodedRequestBody !== null,
      metered: classification.captured && classification.protocol !== null,
      method: request.method,
      suffixPath,
      startedAt: Date.now(),
      decodedRequestBody,
      captureSkippedReason,
      request: parsedRequest,
      identity,
      rewrite: rewriteOutcome,
    };
    const observer = options.observer;
    if (observer?.onExchangeStarted) notifyObserver(() => observer.onExchangeStarted!(exchange));

    const captureQueue = new BoundedCaptureQueue(
      captureSpoolCapBytes,
      exchange.metered && observer?.onResponseChunk ? chunk => observer.onResponseChunk!(exchange, chunk) : () => undefined,
    );
    let responseBytes = 0;
    let firstResponseChunkAt: number | null = null;
    let endDetector: StreamEndMarkerDetector | null = null;
    let finished = false;
    const finishExchange = (outcome: RelayOutcome, recordedStatus: number): void => {
      if (finished) return;
      finished = true;
      const result: RelayExchangeResult = {
        outcome,
        recordedStatus,
        endMarkerSeen: endDetector?.hasSeenEnd ?? false,
        captureOverflowed: captureQueue.hasOverflowed,
        responseBytes,
        durationMs: Date.now() - exchange.startedAt,
        firstResponseChunkAt,
      };
      logger.debug('WIRE', 'Relay exchange finished', {
        routeId, agentId: route.agentId, protocol: exchange.protocol ?? 'none', suffixPath, outcome, recordedStatus, responseBytes,
      });
      if (observer?.onExchangeFinished) {
        captureQueue.afterDelivered(() => observer.onExchangeFinished!(exchange, result));
      }
    };

    relayActivityCounts.exchangesRelayed++;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: request.method,
        headers: forwardedHeaders,
        // The ORIGINAL bytes with the original Content-Encoding header, unless
        // outbound redaction masked them (then decoded, without that header).
        body: methodHasBody ? forwardedBody : undefined,
        // A 3xx is relayed as it is (report 08 §Q3).
        redirect: 'manual',
        // Without it the client gets decoded bytes still labelled content-encoding (report 08 §Q2).
        decompress: false,
        // The only way a client disconnect cancels the upstream on Bun 1.3.9 (report 08 §Q2).
        signal: request.signal,
        // Probed on Bun 1.3.9: a cut on a reused keep-alive connection makes
        // fetch send the request (POST too) again and splice both replies
        // into one body. A fresh connection per request shows a cut as a cut
        // and never bills a model call twice.
        keepalive: false,
        // Disables Bun fetch's 5-minute socket idle timer; absent from bun-types, so cast (report 08 §Q3).
        timeout: false,
      } as RequestInit);
    } catch (error) {
      if (request.signal.aborted) {
        finishExchange('client_aborted', 499);
        return new Response(null, { status: 499 });
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('WIRE', 'Upstream unreachable', { routeId, agentId: route.agentId, upstreamHost: upstreamUrl.host, error: message });
      finishExchange('upstream_unreachable', 502);
      return protocolErrorResponse(errorFamily, {
        status: 502,
        message: `the claude-mem wire gateway could not reach ${upstreamUrl.host} for route "${routeId}": ${message}`,
      });
    }

    // With no content-type (or only application/octet-stream) the first bytes
    // decide (EventStreamSniffer), so the end detector may arrive with them.
    const replyContentType = replyKindContentType(upstreamResponse.headers.get('content-type'));
    if (observer?.onResponseStarted) {
      const responseStart: RelayResponseStart = { status: upstreamResponse.status, contentType: replyContentType };
      notifyObserver(() => observer.onResponseStarted!(exchange, responseStart));
    }

    const responseHeaders = clientResponseHeaders(upstreamResponse.headers);
    // Echo the session only when the client named it (sources 1–4); a
    // fingerprint is the gateway's guess and is never handed out as a name.
    const echoedSessionId = sessionIdToEcho(identity);
    if (echoedSessionId) responseHeaders.set(CLAUDE_MEM_SESSION_HEADER, echoedSessionId);
    const responseInit: ResponseInit = {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    };
    if (!upstreamResponse.body || request.method === 'HEAD' || NULL_BODY_STATUSES.has(upstreamResponse.status)) {
      finishExchange('complete', upstreamResponse.status);
      return new Response(null, responseInit);
    }

    const endDetectorFor = (isEventStream: boolean): StreamEndMarkerDetector | null =>
      classification.protocol && isEventStream ? new StreamEndMarkerDetector(classification.protocol) : null;
    endDetector = replyContentType ? endDetectorFor(isEventStreamContentType(replyContentType)) : null;
    let replyKindSniffer = replyContentType ? null : new EventStreamSniffer();
    // A non-stream reply is whole when its body ends; a stream when its end marker passed.
    const hasReachedEnd = (upstreamBodyDone: boolean) => (endDetector ? endDetector.hasSeenEnd : upstreamBodyDone);

    // Placeholders in the reply become the values again before the agent
    // sees them (and so before the capture copy). Absent when the route has
    // no outbound redaction or the reply is compressed.
    const candidateRestorer = outboundRedaction && outboundRedactionOn
      ? new PlaceholderRestoringResponse({
        placeholders: outboundRedaction.placeholders,
        contentType: replyContentType,
        contentEncoding: upstreamResponse.headers.get('content-encoding'),
      })
      : null;
    const restorer = candidateRestorer && !candidateRestorer.passesThrough ? candidateRestorer : null;
    if (candidateRestorer?.passesThrough) {
      // Safe (the agent sees placeholders, the provider never saw the values)
      // but not what the user asked for, so it is said: the gateway asks for
      // no encoding, and a provider that compresses anyway is relayed as is.
      logger.warn('WIRE', 'Outbound redaction: the reply is compressed, so its placeholders are relayed without their values', {
        routeId, agentId: route.agentId, contentEncoding: upstreamResponse.headers.get('content-encoding'),
      });
    }
    // The response stages (plan Phase 10) see the reply after its
    // placeholders are put back and before the client and the tee do.
    const candidateTransform = rewriteRun && (rewriteRun.hasEventStages || rewriteRun.hasResponseStages)
      ? new ResponseStageTransform({
        run: rewriteRun,
        status: upstreamResponse.status,
        contentType: replyContentType,
        contentEncoding: upstreamResponse.headers.get('content-encoding'),
      })
      : null;
    const responseTransform = candidateTransform && !candidateTransform.passesThrough ? candidateTransform : null;
    const throughResponseStages = async (chunks: Uint8Array[]): Promise<Uint8Array[]> => {
      if (!responseTransform) return chunks;
      const transformed: Uint8Array[] = [];
      for (const chunk of chunks) transformed.push(...await responseTransform.push(chunk));
      return transformed;
    };
    const sendToClient = (controller: ReadableStreamDefaultController<Uint8Array>, chunks: Uint8Array[]): void => {
      // The client may have left while a response stage ran.
      if (request.signal.aborted) return;
      for (const chunk of chunks) {
        if (chunk.byteLength === 0) continue;
        controller.enqueue(chunk);
        firstResponseChunkAt ??= Date.now();
        responseBytes += chunk.byteLength;
        captureQueue.offer(chunk);
      }
    };
    /**
     * What the restorer and the response stages still hold; written before
     * any end, since those bytes did come from upstream. `replyComplete` is
     * false for a cut: a partial whole reply goes out as it came.
     */
    const flushResponseRewriters = async (controller: ReadableStreamDefaultController<Uint8Array>, replyComplete: boolean): Promise<void> => {
      const restored = await throughResponseStages(restorer ? restorer.finish() : []);
      const held = responseTransform ? await responseTransform.finish(replyComplete) : [];
      sendToClient(controller, [...restored, ...held]);
    };

    const upstreamReader = upstreamResponse.body.getReader();
    let releaseCutHold: () => void = () => undefined;
    const cutHold = new Promise<void>(resolve => {
      releaseCutHold = resolve;
    });
    let cutSignalled = false;

    const clientStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cutSignalled) {
          await cutHold;
          return;
        }
        let next: Bun.ReadableStreamDefaultReadResult<Uint8Array>;
        try {
          next = await upstreamReader.read();
        } catch {
          if (request.signal.aborted) {
            // The client left; cancel() normally records it first.
            finishExchange(hasReachedEnd(false) ? 'complete' : 'client_aborted', hasReachedEnd(false) ? upstreamResponse.status : 499);
            controller.close();
            return;
          }
          if (hasReachedEnd(false)) {
            // The reply was whole before the socket went; end it cleanly.
            await flushResponseRewriters(controller, true);
            finishExchange('complete', upstreamResponse.status);
            controller.close();
            return;
          }
          // Upstream broke mid-reply: forward nothing more, fabricate no end,
          // and break the client's connection so it reads a cut, not a whole reply.
          await flushResponseRewriters(controller, false);
          finishExchange('cut', upstreamResponse.status);
          cutSignalled = true;
          server.timeout(request, CUT_SIGNAL_IDLE_TIMEOUT_SECONDS);
          await cutHold;
          return;
        }
        if (next.done) {
          if (request.signal.aborted && !hasReachedEnd(false)) {
            // Probed on Bun 1.3.9: aborting fetch's signal can end its body
            // as `done` before cancel() runs. The client left; nobody failed.
            finishExchange('client_aborted', 499);
            controller.close();
            return;
          }
          // Upstream ended the body itself: relay that end as it is. Without
          // its end marker the turn is flagged cut, never "fixed".
          await flushResponseRewriters(controller, hasReachedEnd(true));
          finishExchange(hasReachedEnd(true) ? 'complete' : 'cut', upstreamResponse.status);
          controller.close();
          return;
        }
        if (request.signal.aborted) {
          // cancel() already ran (the client left while this read was pending).
          return;
        }
        // To the client first, immediately; observers get a copy after.
        if (replyKindSniffer) {
          const sniffed = replyKindSniffer.push(next.value);
          if (sniffed) {
            replyKindSniffer = null;
            endDetector = endDetectorFor(sniffed.isEventStream);
            for (const heldChunk of sniffed.heldChunks) endDetector?.observe(heldChunk);
          }
        } else {
          endDetector?.observe(next.value);
        }
        sendToClient(controller, await throughResponseStages(restorer ? restorer.push(next.value) : [next.value]));
      },
      cancel() {
        // The client went away, or Bun closed a cut connection.
        releaseCutHold();
        upstreamReader.cancel().catch(() => undefined);
        finishExchange(hasReachedEnd(false) ? 'complete' : 'client_aborted', hasReachedEnd(false) ? upstreamResponse.status : 499);
      },
    });

    return new Response(clientStream, responseInit);
  };
}
