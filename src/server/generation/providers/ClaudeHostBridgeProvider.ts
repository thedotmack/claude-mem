// SPDX-License-Identifier: Apache-2.0
//
// ClaudeHostBridgeProvider.
//
// Proxies observation generation through the user's locally-installed Claude
// CLI by POSTing prompts to a small HTTP bridge running on the host. The
// bridge (~/.claude-mem/claude-host-bridge.cjs, started by launchd on macOS or
// systemd --user on Linux) shells out to `claude` for each request, so:
//
//   - account switches propagate INSTANTLY (next request uses the new account)
//   - OAuth token refresh is handled by Claude CLI transparently
//   - the model selected via Claude CLI (4.5/4.6/whatever the user installed)
//     is what gets used — no need to hardcode CLAUDE_MEM_SERVER_MODEL
//
// The container reaches the bridge via host.docker.internal (Docker Desktop)
// or a host-network alias on Linux. CLAUDE_MEM_CLAUDE_BRIDGE_URL is set by
// the install script when the bridge is active.
//
// Authentication: the bridge requires a Bearer token (random 32-byte hex,
// stored on host at ~/.claude-mem/host-bridge-token, mounted read-only into
// the container at /run/secrets/claude-host-bridge-token). Prevents other
// processes on the host or in the container from accidentally hitting the
// bridge.

import { logger } from '../../../utils/logger.js';
import { ServerClassifiedProviderError } from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

export interface ClaudeHostBridgeProviderOptions {
  bridgeUrl: string;
  bridgeToken: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface BridgeGenerateResponse {
  text?: string;
  error?: string;
  message?: string;
  exitCode?: number;
  stderr?: string;
}

export class ClaudeHostBridgeProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude' as const;
  private readonly bridgeUrl: string;
  private readonly bridgeToken: string;
  private readonly model: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClaudeHostBridgeProviderOptions) {
    if (!options.bridgeUrl) {
      throw new ServerClassifiedProviderError('Host-bridge URL missing', {
        kind: 'auth_invalid',
        cause: new Error('bridgeUrl is required'),
      });
    }
    if (!options.bridgeToken) {
      throw new ServerClassifiedProviderError('Host-bridge token missing', {
        kind: 'auth_invalid',
        cause: new Error('bridgeToken is required'),
      });
    }
    this.bridgeUrl = options.bridgeUrl.replace(/\/$/, '');
    this.bridgeToken = options.bridgeToken;
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll } = buildServerGenerationPrompt(context);
    if (skippedAll) {
      return {
        rawText: '<skip_summary reason="all_events_private" />',
        providerLabel: this.providerLabel,
        modelId: this.model ?? '(host-bridge default)',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // Compose a combined signal so external aborts (worker shutdown) and our
    // internal timeout both terminate the fetch.
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.bridgeUrl}/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.bridgeToken}`,
        },
        body: JSON.stringify({
          prompt,
          model: this.model,
        }),
        signal: controller.signal,
      });
    } catch (networkError) {
      clearTimeout(timer);
      const reason = networkError instanceof Error ? networkError.message : String(networkError);
      logger.warn('SYSTEM', 'host-bridge request failed', { bridgeUrl: this.bridgeUrl, reason });
      throw new ServerClassifiedProviderError(`host-bridge unreachable: ${reason}`, {
        kind: 'transient',
        cause: networkError,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      let parsed: BridgeGenerateResponse | undefined;
      try {
        parsed = JSON.parse(bodyText) as BridgeGenerateResponse;
      } catch {
        /* keep raw */
      }
      const message = parsed?.message ?? parsed?.stderr ?? bodyText.slice(0, 500) ?? `HTTP ${response.status}`;
      // Map common bridge failure modes onto the provider error taxonomy so
      // the worker retry policy reacts correctly.
      if (response.status === 401) {
        throw new ServerClassifiedProviderError('host-bridge rejected token', {
          kind: 'auth_invalid',
          cause: new Error(message),
        });
      }
      if (response.status === 502 && parsed?.error === 'ClaudeCliError') {
        throw new ServerClassifiedProviderError(`claude CLI failed (exit ${parsed.exitCode ?? '?'}): ${message}`, {
          kind: 'transient',
          cause: new Error(message),
        });
      }
      throw new ServerClassifiedProviderError(`host-bridge returned HTTP ${response.status}: ${message}`, {
        kind: response.status >= 500 ? 'transient' : 'auth_invalid',
        cause: new Error(message),
      });
    }

    let json: BridgeGenerateResponse;
    try {
      json = (await response.json()) as BridgeGenerateResponse;
    } catch (parseError) {
      throw new ServerClassifiedProviderError('host-bridge returned non-JSON body', {
        kind: 'transient',
        cause: parseError,
      });
    }

    const text = typeof json.text === 'string' ? json.text : '';
    if (!text) {
      throw new ServerClassifiedProviderError('host-bridge returned empty text', {
        kind: 'transient',
        cause: new Error('json.text was missing or empty'),
      });
    }

    return {
      rawText: text,
      providerLabel: this.providerLabel,
      modelId: this.model ?? '(host-bridge default)',
    };
  }
}
