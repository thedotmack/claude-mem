
import { compress, HeadroomClient } from 'headroom-ai';
import type { CompressResult, HealthStatus, RetrieveResult, RetrieveSearchResult } from 'headroom-ai';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';

/**
 * Short, hard timeout on every proxy call: Headroom is a sidecar, never a
 * gate — a dead or missing proxy must not stall context delivery.
 */
const HEADROOM_REQUEST_TIMEOUT_MS = 1500;
const HEADROOM_COMPRESS_RETRIES = 1;

/** Integration slug sent as X-Headroom-Stack on every request. */
const HEADROOM_STACK_SLUG = 'claude-mem';

/** Proxy default (`headroom proxy` binds 127.0.0.1:8787). Used when
 * CLAUDE_MEM_HEADROOM_URL is empty/whitespace — a client must never be
 * constructed with `baseUrl: ''`. */
export const DEFAULT_HEADROOM_BASE_URL = 'http://127.0.0.1:8787';

/** Preserve explicitly configured default-scheme ports (`:80` / `:443`). */
export function getExplicitHeadroomPort(configuredUrl: string): number | null {
  try {
    const trimmed = configuredUrl.trim();
    new URL(trimmed); // Reject malformed authorities before parsing.
    const schemeEnd = trimmed.indexOf('://');
    if (schemeEnd < 0) return null;
    const authority = trimmed.slice(schemeEnd + 3).split(/[/?#]/, 1)[0];
    const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
    const portText = hostPort.startsWith('[')
      ? hostPort.slice(hostPort.indexOf(']') + 1).replace(/^:/, '')
      : hostPort.includes(':')
        ? hostPort.slice(hostPort.lastIndexOf(':') + 1)
        : '';
    if (!/^\d+$/.test(portText)) return null;
    const port = Number(portText);
    return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the effective SDK URL. The managed-proxy contract treats a local
 * HTTP URL with no explicit port as Headroom's 8787 default; without this
 * normalization URL/fetch would silently use port 80 while the manager starts
 * the child on 8787.
 */
export function normalizeHeadroomBaseUrl(configuredUrl: unknown): string {
  const trimmed = typeof configuredUrl === 'string' ? configuredUrl.trim() : '';
  if (trimmed === '') return DEFAULT_HEADROOM_BASE_URL;

  try {
    const url = new URL(trimmed);
    if (
      url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && url.port === ''
      && getExplicitHeadroomPort(trimmed) === null
    ) {
      url.port = '8787';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    // Preserve the configured value so the SDK's normal connection error is
    // handled by the existing fallback path. SettingsRoutes rejects new bad
    // values, but hand-edited legacy files must still degrade safely.
  }
  return trimmed;
}

/** Whether claude-mem can replace an absent URL with its bundled local child. */
export function isManageableLocalHeadroomUrl(baseUrl: string): boolean {
  if (baseUrl.trim() === '') return true;
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && url.username === ''
      && url.password === ''
      && url.port !== '0'
      && (url.pathname === '' || url.pathname === '/')
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

interface HeadroomSettings {
  enabled: boolean;
  baseUrl: string;
}

/**
 * HeadroomService — lazy singleton wrapper around the headroom-ai TS client.
 *
 * The npm SDK is an HTTP client only: every call POSTs to a running Python
 * proxy (`headroom proxy`, default http://127.0.0.1:8787). With
 * `fallback: true`, an unreachable proxy makes compress() resolve to the
 * original messages with `compressed: false` instead of rejecting.
 */
export class HeadroomService {
  private static instance: HeadroomService | null = null;

  private constructor() {}

  static getInstance(): HeadroomService {
    if (!HeadroomService.instance) {
      HeadroomService.instance = new HeadroomService();
    }
    return HeadroomService.instance;
  }

  /**
   * Whether CLAUDE_MEM_HEADROOM_ENABLED is 'true'. Re-read per call (cheap;
   * cached settings) so the user can flip the setting without restarting.
   */
  isEnabled(): boolean {
    return this.loadHeadroomSettings().enabled;
  }

  private loadHeadroomSettings(): HeadroomSettings {
    const settings = SettingsDefaultsManager.loadFromFile(paths.settings());
    return {
      enabled: settings.CLAUDE_MEM_HEADROOM_ENABLED === 'true',
      baseUrl: normalizeHeadroomBaseUrl(settings.CLAUDE_MEM_HEADROOM_URL),
    };
  }

  private createClient(baseUrl: string): HeadroomClient {
    return new HeadroomClient({
      baseUrl,
      fallback: true,
      timeout: HEADROOM_REQUEST_TIMEOUT_MS,
      stack: HEADROOM_STACK_SLUG,
    });
  }

  /**
   * Compress a message payload via the Headroom proxy.
   *
   * Returns `null` immediately (no network call) when
   * CLAUDE_MEM_HEADROOM_ENABLED is not 'true'. Otherwise resolves to a
   * CompressResult; with the proxy unreachable, `fallback: true` yields the
   * original messages with `compressed: false`.
   */
  async compressPayload(messages: any[], tokenBudget?: number): Promise<CompressResult | null> {
    const headroomSettings = this.loadHeadroomSettings();
    if (!headroomSettings.enabled) {
      return null;
    }

    return compress(messages, {
      baseUrl: headroomSettings.baseUrl,
      fallback: true,
      retries: HEADROOM_COMPRESS_RETRIES,
      timeout: HEADROOM_REQUEST_TIMEOUT_MS,
      tokenBudget,
      stack: HEADROOM_STACK_SLUG,
    });
  }

  /**
   * Retrieve original content from the CCR compression store by hash
   * (reverses a `[N items compressed to M. Retrieve more: hash=...]` marker).
   *
   * Gated on the enabled flag as defense in depth: headroom_retrieve is not
   * even registered while Headroom is disabled, but any other caller must get
   * a clear 'Headroom is disabled' rejection instead of a confusing network
   * error against a proxy that was never meant to be running.
   */
  async retrieve(hash: string, query?: string): Promise<RetrieveResult | RetrieveSearchResult> {
    const headroomSettings = this.loadHeadroomSettings();
    if (!headroomSettings.enabled) {
      throw new Error('Headroom is disabled (CLAUDE_MEM_HEADROOM_ENABLED is not "true") — nothing to retrieve');
    }
    return this.createClient(headroomSettings.baseUrl).retrieve(hash, { query });
  }

  /**
   * Raw proxy health probe. The shipped client's health() has NO fallback
   * path (dist/index.d.ts: `health(): Promise<HealthStatus>`; the underlying
   * fetch throws HeadroomConnectionError when the proxy is unreachable), so
   * this returns the raw promise: it resolves to a HealthStatus when the
   * proxy answers and rejects otherwise — callers decide how to degrade.
   *
   * Deliberately NOT gated on the enabled flag: doctor uses it to report the
   * proxy's actual state regardless of whether Headroom is switched on.
   */
  healthCheck(): Promise<HealthStatus> {
    const headroomSettings = this.loadHeadroomSettings();
    return this.createClient(headroomSettings.baseUrl).health();
  }

  /**
   * Raw proxy stats passthrough (`client.proxyStats()` — documented API).
   * Same contract as healthCheck(): no fallback path, so the returned promise
   * REJECTS when the proxy is unreachable — callers own the degradation.
   */
  proxyStats(): ReturnType<HeadroomClient['proxyStats']> {
    const headroomSettings = this.loadHeadroomSettings();
    return this.createClient(headroomSettings.baseUrl).proxyStats();
  }
}
