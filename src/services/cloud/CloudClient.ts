import { logger } from '../../utils/logger.js';
import { getApiBaseUrl, readCloudConfig } from './config.js';

declare const __DEFAULT_PACKAGE_VERSION__: string;
const CLIENT_VERSION =
  typeof __DEFAULT_PACKAGE_VERSION__ !== 'undefined' ? __DEFAULT_PACKAGE_VERSION__ : '0.0.0-dev';

export const PAYLOAD_VERSION = '1';

export type SyncLane = 'live' | 'backfill';

/** Identity + token used on every authed sync request. Read from cloud-config. */
export interface CloudIdentity {
  userId: string;
  deviceId: string;
  setupToken: string;
}

/** Optional telemetry the worker advertises so the server can shape admission. */
export interface CloudTelemetry {
  outboxDepth?: number;
  /** Age of the oldest pending row, in SECONDS (per the contract). */
  oldestPendingAgeSec?: number;
}

export interface CloudPostResult {
  ok: boolean;
  status: number;
  /** Server may return { queued, position } on a 429 backfill admission gate. */
  queued?: boolean;
  position?: number;
  /** Parsed JSON body when available (best-effort). */
  body?: unknown;
  /** Set when the request never completed (network / abort / timeout). */
  error?: string;
}

export interface SyncStatusResult {
  observations: number[];
  summaries: number[];
  prompts: number[];
}

function readIdentity(): CloudIdentity | null {
  const cfg = readCloudConfig();
  if (!cfg.userId || !cfg.deviceId || !cfg.setupToken) return null;
  return { userId: cfg.userId, deviceId: cfg.deviceId, setupToken: cfg.setupToken };
}

/**
 * Build the REQUIRED + optional headers for a sync POST. The Authorization
 * bearer is the setup token — it is placed here and NEVER logged anywhere.
 */
function buildHeaders(
  identity: CloudIdentity,
  lane: SyncLane,
  telemetry?: CloudTelemetry
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${identity.setupToken}`,
    'X-User-Id': identity.userId,
    'X-Device-Id': identity.deviceId,
    'X-Payload-Version': PAYLOAD_VERSION,
    'X-Sync-Lane': lane,
    'X-Client-Version': CLIENT_VERSION,
  };
  if (telemetry?.outboxDepth != null) headers['X-Outbox-Depth'] = String(telemetry.outboxDepth);
  if (telemetry?.oldestPendingAgeSec != null) {
    headers['X-Outbox-Oldest-Age'] = String(Math.round(telemetry.oldestPendingAgeSec));
  }
  return headers;
}

/**
 * Latency policy: every push is aborted after `timeoutMs` (700ms..1s for live)
 * so a stalled connection cannot pin the lane. keepalive reuses the connection
 * pool so the p95 stays low. NO timers on the success path beyond this abort.
 */
async function authedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<CloudPostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      keepalive: true,
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const result: CloudPostResult = { ok: res.ok, status: res.status, body };
    if (res.status === 429 && body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      if (b.queued) {
        result.queued = true;
        if (typeof b.position === 'number') result.position = b.position;
      }
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Thin HTTP client for the cmem.ai sync contract. Stateless: identity + base URL
 * are resolved per call from config so a connect/disconnect is picked up without
 * recreating the client. NEVER logs the token.
 */
export class CloudClient {
  /** POST a coalesced batch to one of the /batch routes. `key` is the body wrapper key. */
  async postBatch(
    route: 'observations' | 'summaries' | 'prompts',
    key: 'observations' | 'summaries' | 'prompts',
    items: unknown[],
    lane: SyncLane,
    timeoutMs: number,
    telemetry?: CloudTelemetry
  ): Promise<CloudPostResult> {
    const identity = readIdentity();
    if (!identity) return { ok: false, status: 0, error: 'no_identity' };
    const url = `${getApiBaseUrl()}/api/pro/sync/${route}/batch`;
    return authedFetch(
      url,
      {
        method: 'POST',
        headers: buildHeaders(identity, lane, telemetry),
        body: JSON.stringify({ [key]: items }),
      },
      timeoutMs
    );
  }

  /** POST a tombstone batch (delete or update) for one table. */
  async postTombstone(
    table: 'observation' | 'summary' | 'prompt',
    kind: 'delete' | 'update',
    items: unknown[],
    lane: SyncLane,
    timeoutMs: number,
    telemetry?: CloudTelemetry
  ): Promise<CloudPostResult> {
    const identity = readIdentity();
    if (!identity) return { ok: false, status: 0, error: 'no_identity' };
    const url = `${getApiBaseUrl()}/api/pro/sync/tombstone`;
    return authedFetch(
      url,
      {
        method: 'POST',
        headers: buildHeaders(identity, lane, telemetry),
        body: JSON.stringify({ table, kind, items }),
      },
      timeoutMs
    );
  }

  /**
   * GET the set of localIds the cloud already has for a project. Used for
   * reconciliation/anti-entropy and (with project '__connectivity__') as a cheap
   * authed connectivity/validate probe.
   */
  async getStatus(project: string, timeoutMs = 5000): Promise<{ result: SyncStatusResult | null; status: number }> {
    const identity = readIdentity();
    if (!identity) return { result: null, status: 0 };
    const url = `${getApiBaseUrl()}/api/pro/sync/status?project=${encodeURIComponent(project)}`;
    const res = await authedFetch(
      url,
      { method: 'GET', headers: buildHeaders(identity, 'live') },
      timeoutMs
    );
    if (!res.ok) return { result: null, status: res.status };
    const body = (res.body as Partial<SyncStatusResult>) ?? {};
    return {
      result: {
        observations: Array.isArray(body.observations) ? body.observations : [],
        summaries: Array.isArray(body.summaries) ? body.summaries : [],
        prompts: Array.isArray(body.prompts) ? body.prompts : [],
      },
      status: res.status,
    };
  }

  /**
   * Validate a token by doing a cheap authed GET /status for a sentinel project.
   * 200 => valid; 401/403 => bad token. Other statuses are treated as transient
   * (valid-enough to proceed) so we don't reject on a flaky network.
   */
  async validateToken(): Promise<{ valid: boolean; status: number; authError: boolean }> {
    const { status } = await this.getStatus('__connectivity__');
    if (status === 200) return { valid: true, status, authError: false };
    if (status === 401 || status === 403) {
      logger.warn('CLOUD', 'Token validation failed (auth rejected)', { status });
      return { valid: false, status, authError: true };
    }
    // Network/other: don't hard-reject — let the sync loop surface real failures.
    return { valid: status !== 0, status, authError: false };
  }
}
