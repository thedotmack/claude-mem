// SPDX-License-Identifier: Apache-2.0
//
// Who may reach a shared team gateway's team listener, and as whom (plan D15,
// Phase 16 tasks 1–2). The order follows magpie's `lanGuard`
// (internal/gateway/lan.go, MIT, Copyright (c) 2026 yetone, e297a8ab2): the
// allow list first (a key that leaked is of no use from an address left out
// of it), then the key (magpie `identifyCaller`).
//
// The team listener (CLAUDE_MEM_WIRE_GATEWAY_SHARED_HOST/_PORT) never serves
// anyone without a key, whatever address the connection comes from: loopback
// included. A TLS proxy on the gateway host that adds no forwarding header
// (nginx's default proxy_pass, stunnel, an HAProxy or nginx stream proxy,
// ssh -R, socat) hands the gateway every internet request from 127.0.0.1, so
// a peer address can never mean "this computer". Keyless use by the host's
// own agents, and every host-only endpoint, are on the loopback listener
// (CLAUDE_MEM_WIRE_GATEWAY_HOST/_PORT), which a proxy must never be pointed at.
//
// Endpoint exposure on the team listener (the table in docs/public/wire-gateway.mdx):
// only `/k/<key>/r/<route>/…` (the relay, launches included) and `/k/<key>/`
// (the identity probe). Every `/wire/*` endpoint, `/mcp`,
// `/v1/claude-mem/events` and `/v1/traces` answer on the loopback listener
// only: they show paths and settings, other members' traffic, or read and
// write this host's own memory.

import { logger } from '../../../utils/logger.js';
import { isAllowedByList, type WireAllowList } from './allow-list.js';
import type { FailedKeyThrottle } from './auth-throttle.js';
import type { WireClientKeyIdentity, WireClientKeyStore } from './client-keys.js';

/** `/k/<key>` and what follows it. The key segment is never logged or echoed. */
const CLIENT_KEY_PATH_PATTERN = /^\/k\/([^/]*)(\/.*)?$/;
/** Every `/k/<segment>` in a text: what admission logs and error messages put in its place. */
const CLIENT_KEY_PATH_SEGMENT_PATTERN = /\/k\/[^/\s"'?#]*/g;
export const REDACTED_CLIENT_KEY_PATH = '/k/[REDACTED]';

/** `/k/<…>/` replaced with `/k/[REDACTED]/` (plan Phase 16 task 2). */
export function redactClientKeyPaths(text: string): string {
  return text.replace(CLIENT_KEY_PATH_SEGMENT_PATTERN, REDACTED_CLIENT_KEY_PATH);
}

export interface WireSharedMode {
  allowList: WireAllowList;
  clientKeys: WireClientKeyStore;
  throttle: FailedKeyThrottle;
  refusalLog: RefusalLogLimiter;
}

export type WireAdmission =
  /** Let in. `pathname` is the path to route (the key segment removed). */
  | { kind: 'admitted'; pathname: string; clientKey: WireClientKeyIdentity }
  | { kind: 'refused'; status: 401 | 403 | 429 | 503; type: string; message: string; headers?: Record<string, string> };

/** Content-free counters for `wire status` (plan Phase 6 task 4 rule: counts only). */
export const sharedAdmissionActivity = { admitted: 0, refusedNotAllowed: 0, refusedNoKey: 0, refusedWrongKey: 0, refusedThrottled: 0, refusedHostOnly: 0, refusedKeysUnreadable: 0 };

/**
 * One log line per refusal reason per this long, then a count of the rest
 * (abuse protection: a flood of refused requests, which the throttle answers
 * 429 at any rate, would otherwise write a line each and fill the host's
 * disk; this bounds it to two lines a minute per reason, ~3,000 a day).
 */
export const REFUSAL_LOG_WINDOW_MS = 60_000;

/** Logs the first refusal of each reason in a window and counts the rest; the count is logged when the window ends. */
export class RefusalLogLimiter {
  private readonly windows = new Map<string, { startedAt: number; suppressed: number }>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly now: () => number = Date.now, private readonly windowMs: number = REFUSAL_LOG_WINDOW_MS) {}

  refused(reason: string, context: Record<string, unknown>): void {
    const now = this.now();
    const window = this.windows.get(reason);
    if (window && now - window.startedAt < this.windowMs) {
      window.suppressed++;
      this.ensureFlushTimer();
      return;
    }
    if (window) this.flushOne(reason, window);
    this.windows.set(reason, { startedAt: now, suppressed: 0 });
    logger.warn('WIRE', `Refused a request on the team listener: ${reason}`, context);
  }

  /** Logs every pending count (on a timer, and when the gateway stops). */
  flush(): void {
    for (const [reason, window] of this.windows) this.flushOne(reason, window);
    this.windows.clear();
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
  }

  private flushOne(reason: string, window: { startedAt: number; suppressed: number }): void {
    if (window.suppressed === 0) return;
    logger.warn('WIRE', `Refused ${window.suppressed} more request(s) on the team listener: ${reason}`, { windowMs: this.windowMs });
    window.suppressed = 0;
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      const now = this.now();
      for (const [reason, window] of this.windows) {
        if (now - window.startedAt >= this.windowMs) {
          this.flushOne(reason, window);
          this.windows.delete(reason);
        }
      }
      if (this.windows.size === 0 && this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }
    }, this.windowMs);
    this.flushTimer.unref?.();
  }
}

/** What a caller with a valid key may reach: the relay and the identity probe. */
function memberReachable(pathname: string): boolean {
  return pathname === '' || pathname === '/' || pathname === '/r' || pathname.startsWith('/r/');
}

const NO_KEY_MESSAGE = 'this is a shared claude-mem wire gateway\'s team listener: put your client key in the base URL, as https://<gateway>/k/<key>/r/<route> (claude-mem wire keys add <name> on the gateway host makes one)';
const WRONG_KEY_MESSAGE = 'the client key in the base URL is not one of this claude-mem wire gateway\'s keys: it was removed or mistyped';

/**
 * Decide one request on the team listener. `peerAddress` is the socket's own
 * address (server.requestIP), never a header; it is used for the allow list
 * only, never to skip the key.
 */
export async function admitTeamListenerRequest(
  request: Request,
  context: { peerAddress: string | null; pathname: string; shared: WireSharedMode },
): Promise<WireAdmission> {
  const { peerAddress, shared } = context;
  const logContext = { method: request.method, path: redactClientKeyPaths(context.pathname), peer: peerAddress ?? 'unknown' };

  if (!isAllowedByList(shared.allowList, peerAddress)) {
    sharedAdmissionActivity.refusedNotAllowed++;
    shared.refusalLog.refused('not on the allow list', logContext);
    return {
      kind: 'refused',
      status: 403,
      type: 'permission_error',
      message: `this claude-mem wire gateway answers only the addresses on its allow list (CLAUDE_MEM_WIRE_GATEWAY_ALLOW_IPS), and this request came from ${peerAddress ?? 'an unknown address'}`,
    };
  }

  const keyMatch = CLIENT_KEY_PATH_PATTERN.exec(context.pathname);
  const verdict = keyMatch ? shared.clientKeys.verify(decodeKeySegment(keyMatch[1])) : null;
  if (verdict?.kind === 'unreadable') {
    sharedAdmissionActivity.refusedKeysUnreadable++;
    shared.refusalLog.refused('keys.json cannot be read', { ...logContext, reason: verdict.reason });
    return {
      kind: 'refused',
      status: 503,
      type: 'api_error',
      message: 'this claude-mem wire gateway cannot read its client keys (keys.json); the gateway host must repair it',
    };
  }
  if (!verdict || verdict.kind === 'invalid') {
    // Charged only after the key was looked up (magpie `tooManyAuthFails`). The lookup is a
    // digest for every key, so the throttle shapes only the answer (401 → 429), never CPU.
    const throttle = shared.throttle.chargeFailure();
    if (throttle.throttled) {
      sharedAdmissionActivity.refusedThrottled++;
      shared.refusalLog.refused('too many failed client keys (429)', logContext);
      return {
        kind: 'refused',
        status: 429,
        type: 'rate_limit_error',
        message: 'too many failed client keys; slow down and send a valid claude-mem wire gateway key',
        headers: { 'retry-after': String(throttle.retryAfterSeconds) },
      };
    }
    if (verdict) sharedAdmissionActivity.refusedWrongKey++;
    else sharedAdmissionActivity.refusedNoKey++;
    shared.refusalLog.refused(verdict ? 'wrong client key' : 'no client key', logContext);
    return { kind: 'refused', status: 401, type: 'authentication_error', message: verdict ? WRONG_KEY_MESSAGE : NO_KEY_MESSAGE };
  }

  const pathname = keyMatch![2] ?? '/';
  if (!memberReachable(pathname)) {
    sharedAdmissionActivity.refusedHostOnly++;
    shared.refusalLog.refused('an endpoint that answers on the loopback listener only', { ...logContext, client: verdict.identity.name });
    return {
      kind: 'refused',
      status: 403,
      type: 'permission_error',
      message: 'a shared claude-mem wire gateway\'s team listener relays /k/<key>/r/<route>/… only; its other endpoints answer the gateway host only, on its loopback listener',
    };
  }
  sharedAdmissionActivity.admitted++;
  return { kind: 'admitted', pathname, clientKey: verdict.identity };
}

/** A percent-encoded key segment decoded; one that does not decode stays as sent (and then matches no key). */
function decodeKeySegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    logger.debug('WIRE', 'A client key segment does not percent-decode; it is compared as sent', { error: error instanceof Error ? error.message : String(error) });
    return segment;
  }
}
