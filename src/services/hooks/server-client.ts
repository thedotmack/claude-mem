// SPDX-License-Identifier: Apache-2.0
//
// Phase 7 — Server HTTP client used by hook subcommands when the
// installer/setting selects the server runtime. This client speaks
// directly to the server runtime's `/v1/*` endpoints. It MUST NOT
// import or transitively depend on the worker runtime: the whole point
// of phase 7 is that hooks can reach the server even when no worker is
// running.
//
// On any transport-class failure (timeout, ECONNREFUSED, 5xx, missing
// API key, etc.) callers receive a typed `ServerClientError` so the
// hook handler can decide whether to fall back to the worker path.

import { fetchWithTimeout } from '../../shared/worker-utils.js';
import { HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';

const DEFAULT_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.API_REQUEST);

export type ServerClientErrorKind =
  | 'missing_api_key'
  | 'transport'
  | 'timeout'
  | 'http_error'
  | 'invalid_response';

export class ServerClientError extends Error {
  readonly kind: ServerClientErrorKind;
  readonly status: number | null;
  readonly cause?: unknown;

  constructor(kind: ServerClientErrorKind, message: string, options: {
    status?: number | null;
    cause?: unknown;
  } = {}) {
    super(message);
    this.name = 'ServerClientError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.cause = options.cause;
  }

  isFallbackEligible(): boolean {
    if (this.kind === 'transport' || this.kind === 'timeout' || this.kind === 'missing_api_key') {
      return true;
    }
    if (this.kind === 'http_error') {
      // 5xx and 429 are transient; fall back. 4xx other than 429 is a real
      // client bug — surface it via the worker path so it can be observed.
      if (this.status !== null && this.status >= 500) return true;
      if (this.status === 429) return true;
    }
    return false;
  }
}

export interface ServerClientConfig {
  serverBaseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface ServerStartSessionRequest {
  projectId: string;
  externalSessionId?: string | null;
  contentSessionId?: string | null;
  agentId?: string | null;
  agentType?: string | null;
  platformSource?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ServerStartSessionResponse {
  session: {
    id: string;
    projectId: string;
    teamId: string;
    externalSessionId: string | null;
    contentSessionId: string | null;
    [key: string]: unknown;
  };
}

export interface ServerRecordEventRequest {
  projectId: string;
  serverSessionId?: string | null;
  contentSessionId?: string | null;
  memorySessionId?: string | null;
  platformSource?: string | null;
  sourceType: 'hook' | 'worker' | 'provider' | 'server' | 'api';
  eventType: string;
  payload?: unknown;
  occurredAtEpoch: number;
  // When false, the event is recorded but no generation job is enqueued.
  // Maps to the REST endpoint's `?generate=false` query flag.
  generate?: boolean;
}

export interface ServerRecordEventResponse {
  event: {
    id: string;
    projectId: string;
    serverSessionId: string | null;
    [key: string]: unknown;
  };
  generationJob?: {
    id: string;
    status: string;
    [key: string]: unknown;
  };
}

export interface ServerEndSessionRequest {
  sessionId: string;
}

export interface ServerEndSessionResponse {
  session: {
    id: string;
    [key: string]: unknown;
  };
  generationJob?: {
    id: string;
    status: string;
    [key: string]: unknown;
  };
}

// Phase 8 — direct/manual observation insertion through `/v1/memories`.
// This calls the same Postgres repository path as the REST core, so MCP
// and REST never diverge on what counts as a valid observation insert.
export interface ServerAddObservationRequest {
  projectId: string;
  serverSessionId?: string | null;
  kind?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ServerAddObservationResponse {
  memory: {
    id: string;
    projectId: string;
    teamId: string;
    serverSessionId: string | null;
    kind: string;
    content: string;
    metadata: Record<string, unknown>;
    [key: string]: unknown;
  };
}

// Phase 8 — full-text search over generated observations.
export interface ServerSearchObservationsRequest {
  projectId: string;
  query: string;
  limit?: number;
  platformSource?: string | null;
}

export interface ServerSearchObservationsResponse {
  observations: Array<{
    id: string;
    projectId: string;
    content: string;
    [key: string]: unknown;
  }>;
}

// Phase 8 — context pack for prompt injection. Server returns both the
// matched observations AND a pre-joined `context` string.
export interface ServerContextObservationsRequest {
  projectId: string;
  query: string;
  limit?: number;
  platformSource?: string | null;
}

export interface ServerContextObservationsResponse {
  observations: Array<{
    id: string;
    projectId: string;
    content: string;
    [key: string]: unknown;
  }>;
  context: string;
}

// Phase 8 — generation job status, scoped by api-key team/project.
export interface ServerJobStatusResponse {
  generationJob: {
    id: string;
    status: string;
    [key: string]: unknown;
  };
}

export class ServerClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: ServerClientConfig) {
    this.baseUrl = stripTrailingSlash(config.serverBaseUrl);
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async startSession(input: ServerStartSessionRequest): Promise<ServerStartSessionResponse> {
    const body = this.buildStartSessionPayload(input);
    return this.request<ServerStartSessionResponse>('POST', '/v1/sessions/start', body);
  }

  async recordEvent(input: ServerRecordEventRequest): Promise<ServerRecordEventResponse> {
    const body = this.buildEventPayload(input);
    const path = input.generate === false ? '/v1/events?generate=false' : '/v1/events';
    return this.request<ServerRecordEventResponse>('POST', path, body);
  }

  async endSession(input: ServerEndSessionRequest): Promise<ServerEndSessionResponse> {
    if (!input.sessionId) {
      throw new ServerClientError('invalid_response', 'sessionId is required for endSession');
    }
    return this.request<ServerEndSessionResponse>(
      'POST',
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/end`,
      {},
    );
  }

  // Phase 8 — direct observation insert (MCP `observation_add`). Calls
  // `/v1/memories`, which is the canonical write path that MUST NOT enqueue
  // a generation job. Anti-pattern guard for plan line 770: never duplicate
  // generation logic in MCP tools.
  async addObservation(
    input: ServerAddObservationRequest,
  ): Promise<ServerAddObservationResponse> {
    return this.request<ServerAddObservationResponse>(
      'POST',
      '/v1/memories',
      this.buildAddObservationPayload(input),
    );
  }

  // Phase 8 — MCP `observation_search`. Routes to the FTS-backed REST
  // endpoint so search ranking and tenant scoping are owned by one place.
  async searchObservations(
    input: ServerSearchObservationsRequest,
  ): Promise<ServerSearchObservationsResponse> {
    return this.request<ServerSearchObservationsResponse>(
      'POST',
      '/v1/search',
      this.buildSearchPayload(input),
    );
  }

  // Phase 8 — MCP `observation_context`. Same FTS surface as search, but
  // returns a pre-joined context string suitable for direct prompt injection.
  async contextObservations(
    input: ServerContextObservationsRequest,
  ): Promise<ServerContextObservationsResponse> {
    return this.request<ServerContextObservationsResponse>(
      'POST',
      '/v1/context',
      this.buildSearchPayload(input),
    );
  }

  // Phase 8 — MCP `observation_generation_status`. Server returns the same
  // payload as `/v1/jobs/:id` so MCP clients and REST clients see identical
  // job status (including transport state).
  async getJobStatus(jobId: string): Promise<ServerJobStatusResponse> {
    if (!jobId) {
      throw new ServerClientError('invalid_response', 'jobId is required for getJobStatus');
    }
    return this.request<ServerJobStatusResponse>(
      'GET',
      `/v1/jobs/${encodeURIComponent(jobId)}`,
    );
  }

  buildAddObservationPayload(
    input: ServerAddObservationRequest,
  ): Record<string, unknown> {
    // Write-path contract (#2684): /v1/memories persists a `memory_items` row
    // whose searchable text lives in `narrative` (the FTS trigger copies it
    // into memory_items_fts). The MCP `observation_add` surface speaks in terms
    // of `content`; map it onto `narrative` so the row is never empty and the
    // FTS index always has something to match. `type` is REQUIRED by
    // CreateMemoryItemSchema; default it from `kind` so a manual insert that
    // only supplied content still persists instead of 400-ing.
    const content = input.content;
    const kind = input.kind ?? 'manual';
    const metadataTitle = typeof input.metadata?.title === 'string' ? input.metadata.title : undefined;
    return {
      projectId: input.projectId,
      kind,
      type: kind,
      narrative: content,
      ...(metadataTitle ? { title: metadataTitle } : {}),
      ...(input.serverSessionId !== undefined ? { serverSessionId: input.serverSessionId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
  }

  buildSearchPayload(
    input: { projectId: string; query: string; limit?: number; platformSource?: string | null },
  ): Record<string, unknown> {
    return {
      projectId: input.projectId,
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.platformSource !== undefined ? { platformSource: normalizePlatformSourceField(input.platformSource) } : {}),
    };
  }

  buildStartSessionPayload(input: ServerStartSessionRequest): Record<string, unknown> {
    return {
      projectId: input.projectId,
      ...(input.externalSessionId !== undefined ? { externalSessionId: input.externalSessionId } : {}),
      ...(input.contentSessionId !== undefined ? { contentSessionId: input.contentSessionId } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
      ...(input.platformSource !== undefined ? { platformSource: normalizePlatformSourceField(input.platformSource) } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
  }

  buildEventPayload(input: ServerRecordEventRequest): Record<string, unknown> {
    return {
      projectId: input.projectId,
      sourceType: input.sourceType,
      eventType: input.eventType,
      occurredAtEpoch: input.occurredAtEpoch,
      ...(input.serverSessionId !== undefined ? { serverSessionId: input.serverSessionId } : {}),
      ...(input.contentSessionId !== undefined ? { contentSessionId: input.contentSessionId } : {}),
      ...(input.memorySessionId !== undefined ? { memorySessionId: input.memorySessionId } : {}),
      ...(input.platformSource !== undefined ? { platformSource: normalizePlatformSourceField(input.platformSource) } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.apiKey || !this.apiKey.trim()) {
      throw new ServerClientError(
        'missing_api_key',
        'Server API key is not configured (CLAUDE_MEM_SERVER_API_KEY).',
      );
    }

    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(url, init, this.timeoutMs);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = /timed out|timeout/i.test(message);
      throw new ServerClientError(
        isTimeout ? 'timeout' : 'transport',
        `Server ${method} ${path} failed: ${message}`,
        { cause: error },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ServerClientError(
        'http_error',
        `Server ${method} ${path} returned ${response.status}: ${truncate(text, 200)}`,
        { status: response.status },
      );
    }

    const text = await response.text();
    if (!text || text.length === 0) {
      // Endpoints we call always return JSON; a body-less success is unusual
      // but not fatal — return undefined-shaped object.
      return {} as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error: unknown) {
      throw new ServerClientError(
        'invalid_response',
        `Server ${method} ${path} returned non-JSON response`,
        { cause: error },
      );
    }
  }
}

export function isServerClientError(error: unknown): error is ServerClientError {
  return error instanceof ServerClientError;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function normalizePlatformSourceField(value: string | null): string | null {
  return typeof value === 'string' ? normalizePlatformSource(value) : null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
