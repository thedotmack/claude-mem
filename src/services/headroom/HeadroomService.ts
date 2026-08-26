
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
      baseUrl: settings.CLAUDE_MEM_HEADROOM_URL,
    };
  }

  private createClient(baseUrl: string): HeadroomClient {
    return new HeadroomClient({
      baseUrl,
      fallback: true,
      timeout: HEADROOM_REQUEST_TIMEOUT_MS,
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
   */
  async retrieve(hash: string, query?: string): Promise<RetrieveResult | RetrieveSearchResult> {
    const headroomSettings = this.loadHeadroomSettings();
    return this.createClient(headroomSettings.baseUrl).retrieve(hash, { query });
  }

  /**
   * Raw proxy health probe. The shipped client's health() has NO fallback
   * path (dist/index.d.ts: `health(): Promise<HealthStatus>`; the underlying
   * fetch throws HeadroomConnectionError when the proxy is unreachable), so
   * this returns the raw promise: it resolves to a HealthStatus when the
   * proxy answers and rejects otherwise — callers decide how to degrade.
   */
  healthCheck(): Promise<HealthStatus> {
    const headroomSettings = this.loadHeadroomSettings();
    return this.createClient(headroomSettings.baseUrl).health();
  }
}
