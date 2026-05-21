// SPDX-License-Identifier: Apache-2.0
//
// Server beta HTTP client used by hook subcommands when the
// installer/setting selects the server-beta runtime. This client speaks
// directly to the server-beta runtime's `/v1/*` endpoints. It MUST NOT
// import or transitively depend on the worker runtime: the whole point
// of phase 7 is that hooks can reach server-beta even when no worker is
// running.
//
// On any transport-class failure (timeout, ECONNREFUSED, 5xx, missing
// API key, etc.) callers receive a typed `ServerBetaClientError` so the
// hook handler can decide whether to fall back to the worker path.

import { fetchWithTimeout } from '../../shared/worker-utils.js';
import { HOOK_TIMEOUTS, getTimeout } from '../../shared/hook-constants.js';

const DEFAULT_TIMEOUT_MS = getTimeout(HOOK_TIMEOUTS.API_REQUEST);

export type ServerBetaClientErrorKind =
  | 'missing_api_key'
  | 'transport'
  | 'timeout'
  | 'http_error'
  | 'invalid_response';

export class ServerBetaClientError extends Error {
  readonly kind: ServerBetaClientErrorKind;
  readonly status: number | null;
  readonly cause?: unknown;

  constructor(kind: ServerBetaClientErrorKind, message: string, options: {
    status?: number | null;
    cause?: unknown;
  } = {}) {
    super(message);
    this.name = 'ServerBetaClientError';
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

export interface ServerBetaClientConfig {
  serverBaseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export interface ServerBetaStartSessionRequest {
  projectId: string;
  externalSessionId?: string | null;
  contentSessionId?: string | null;
  agentId?: string | null;
  agentType?: string | null;
  platformSource?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ServerBetaStartSessionResponse {
  session: {
    id: string;
    projectId: string;
    teamId: string;
    externalSessionId: string | null;
    contentSessionId: string | null;
    [key: string]: unknown;
  };
}

export interface ServerBetaRecordEventRequest {
  projectId: string;
  serverSessionId?: string | null;
  contentSessionId?: string | null;
  memorySessionId?: string | null;
  sourceType: 'hook' | 'worker' | 'provider' | 'server' | 'api';
  eventType: string;
  payload?: unknown;
  occurredAtEpoch: number;
  // When false, the event is recorded but no generation job is enqueued.
  // Maps to the REST endpoint's `?generate=false` query flag.
  generate?: boolean;
}

export interface ServerBetaRecordEventResponse {
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

export interface ServerBetaEndSessionRequest {
  sessionId: string;
}

export interface ServerBetaEndSessionResponse {
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

// direct/manual observation insertion through `/v1/memories`.
// This calls the same Postgres repository path as the REST core, so MCP
// and REST never diverge on what counts as a valid observation insert.
export interface ServerBetaAddObservationRequest {
  projectId: string;
  serverSessionId?: string | null;
  kind?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ServerBetaAddObservationResponse {
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

// full-text search over generated observations.
export interface ServerBetaSearchObservationsRequest {
  projectId: string;
  query: string;
  limit?: number;
}

export interface ServerBetaSearchObservationsResponse {
  observations: Array<{
    id: string;
    projectId: string;
    content: string;
    [key: string]: unknown;
  }>;
}

// context pack for prompt injection. Server returns both the
// matched observations AND a pre-joined `context` string.
export interface ServerBetaContextObservationsRequest {
  projectId: string;
  query: string;
  limit?: number;
}

export interface ServerBetaContextObservationsResponse {
  observations: Array<{
    id: string;
    projectId: string;
    content: string;
    [key: string]: unknown;
  }>;
  context: string;
}

// generation job status, scoped by api-key team/project.
export interface ServerBetaJobStatusResponse {
  generationJob: {
    id: string;
    status: string;
    [key: string]: unknown;
  };
}

// Branch 2 (Agent C) — batch read of observations by id list. Server returns
// only rows the caller is allowed to see; missing ids are omitted from the
// response (never 404) to prevent existence probing.
export interface ServerBetaMemoryRecord {
  id: string;
  projectId: string;
  teamId: string;
  serverSessionId: string | null;
  kind: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAtEpoch: number;
  updatedAtEpoch: number;
  [key: string]: unknown;
}

export interface ServerBetaMemoriesBatchResponse {
  memories: ServerBetaMemoryRecord[];
}

// Branch 2 — single observation lookup by id (GET /v1/memories/:id).
export interface ServerBetaMemoryGetResponse {
  memory: ServerBetaMemoryRecord;
}

// Branch 2 — timeline window (POST /v1/timeline). Either `anchor` (an
// observation id) OR `query` (resolved server-side to the top FTS hit) is
// required; the route refuses requests that pass neither.
export interface ServerBetaTimelineRequest {
  projectId: string;
  anchor?: string;
  query?: string;
  depthBefore?: number;
  depthAfter?: number;
}

export interface ServerBetaTimelineResponse {
  anchor: ServerBetaMemoryRecord | null;
  before: ServerBetaMemoryRecord[];
  after: ServerBetaMemoryRecord[];
}

export class ServerBetaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: ServerBetaClientConfig) {
    this.baseUrl = stripTrailingSlash(config.serverBaseUrl);
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async startSession(input: ServerBetaStartSessionRequest): Promise<ServerBetaStartSessionResponse> {
    const body = this.buildStartSessionPayload(input);
    return this.request<ServerBetaStartSessionResponse>('POST', '/v1/sessions/start', body);
  }

  async recordEvent(input: ServerBetaRecordEventRequest): Promise<ServerBetaRecordEventResponse> {
    const body = this.buildEventPayload(input);
    const path = input.generate === false ? '/v1/events?generate=false' : '/v1/events';
    return this.request<ServerBetaRecordEventResponse>('POST', path, body);
  }

  async endSession(input: ServerBetaEndSessionRequest): Promise<ServerBetaEndSessionResponse> {
    if (!input.sessionId) {
      throw new ServerBetaClientError('invalid_response', 'sessionId is required for endSession');
    }
    return this.request<ServerBetaEndSessionResponse>(
      'POST',
      `/v1/sessions/${encodeURIComponent(input.sessionId)}/end`,
      {},
    );
  }

  // direct observation insert (MCP `observation_add`). Calls
  // `/v1/memories`, which is the canonical write path that MUST NOT enqueue
  // a generation job. Anti-pattern guard for plan line 770: never duplicate
  // generation logic in MCP tools.
  async addObservation(
    input: ServerBetaAddObservationRequest,
  ): Promise<ServerBetaAddObservationResponse> {
    return this.request<ServerBetaAddObservationResponse>(
      'POST',
      '/v1/memories',
      this.buildAddObservationPayload(input),
    );
  }

  // MCP `observation_search`. Routes to the FTS-backed REST
  // endpoint so search ranking and tenant scoping are owned by one place.
  async searchObservations(
    input: ServerBetaSearchObservationsRequest,
  ): Promise<ServerBetaSearchObservationsResponse> {
    return this.request<ServerBetaSearchObservationsResponse>(
      'POST',
      '/v1/search',
      this.buildSearchPayload(input),
    );
  }

  // MCP `observation_context`. Same FTS surface as search, but
  // returns a pre-joined context string suitable for direct prompt injection.
  async contextObservations(
    input: ServerBetaContextObservationsRequest,
  ): Promise<ServerBetaContextObservationsResponse> {
    return this.request<ServerBetaContextObservationsResponse>(
      'POST',
      '/v1/context',
      this.buildSearchPayload(input),
    );
  }

  // MCP `observation_generation_status`. Server returns the same
  // payload as `/v1/jobs/:id` so MCP clients and REST clients see identical
  // job status (including transport state).
  async getJobStatus(jobId: string): Promise<ServerBetaJobStatusResponse> {
    if (!jobId) {
      throw new ServerBetaClientError('invalid_response', 'jobId is required for getJobStatus');
    }
    return this.request<ServerBetaJobStatusResponse>(
      'GET',
      `/v1/jobs/${encodeURIComponent(jobId)}`,
    );
  }

  // Branch 2 (Agent C) — batch get observations by id. Server returns only
  // rows the caller is allowed to see (team-scoped, optionally project-scoped).
  // Missing ids are simply omitted (never 404) to avoid existence probing.
  async getMemoriesBatch(input: {
    projectId?: string;
    ids: string[];
  }): Promise<ServerBetaMemoriesBatchResponse> {
    // Empty ids array is almost certainly a caller bug. Reject client-side
    // with the structured 'invalid_response' kind to keep the failure mode
    // consistent with getTimelineWindow's anchor/query guard.
    if (!input.ids?.length) {
      throw new ServerBetaClientError(
        'invalid_response',
        'getMemoriesBatch requires at least one id',
      );
    }
    return this.request<ServerBetaMemoriesBatchResponse>(
      'POST',
      '/v1/memories/batch',
      {
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ids: input.ids,
      },
    );
  }

  // Branch 2 — single observation lookup by id. 404 maps to a typed
  // ServerBetaClientError so the MCP handler can surface the missing-id case
  // distinctly from transport errors.
  async getMemoryById(input: { id: string }): Promise<ServerBetaMemoryGetResponse> {
    if (!input.id) {
      throw new ServerBetaClientError('invalid_response', 'id is required for getMemoryById');
    }
    return this.request<ServerBetaMemoryGetResponse>(
      'GET',
      `/v1/memories/${encodeURIComponent(input.id)}`,
    );
  }

  // Branch 2 — timeline window around an anchor observation (or top FTS hit).
  // Mirrors the worker's /api/timeline contract: caller passes anchor or query
  // plus depthBefore/depthAfter, server resolves the anchor and returns the
  // before/after windows ordered by created_at.
  async getTimelineWindow(
    input: ServerBetaTimelineRequest,
  ): Promise<ServerBetaTimelineResponse> {
    // Server rejects requests without anchor or query as 400. Surface that
    // as the structured 'invalid_response' kind here so callers get an
    // actionable error instead of a generic http_error wrapping a 400.
    if (!input.anchor && !input.query) {
      throw new ServerBetaClientError(
        'invalid_response',
        'getTimelineWindow requires either anchor or query',
      );
    }
    return this.request<ServerBetaTimelineResponse>(
      'POST',
      '/v1/timeline',
      {
        projectId: input.projectId,
        ...(input.anchor ? { anchor: input.anchor } : {}),
        ...(input.query ? { query: input.query } : {}),
        ...(input.depthBefore !== undefined ? { depthBefore: input.depthBefore } : {}),
        ...(input.depthAfter !== undefined ? { depthAfter: input.depthAfter } : {}),
      },
    );
  }

  buildAddObservationPayload(
    input: ServerBetaAddObservationRequest,
  ): Record<string, unknown> {
    return {
      projectId: input.projectId,
      content: input.content,
      ...(input.serverSessionId !== undefined ? { serverSessionId: input.serverSessionId } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
  }

  buildSearchPayload(
    input: { projectId: string; query: string; limit?: number },
  ): Record<string, unknown> {
    return {
      projectId: input.projectId,
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    };
  }

  buildStartSessionPayload(input: ServerBetaStartSessionRequest): Record<string, unknown> {
    return {
      projectId: input.projectId,
      ...(input.externalSessionId !== undefined ? { externalSessionId: input.externalSessionId } : {}),
      ...(input.contentSessionId !== undefined ? { contentSessionId: input.contentSessionId } : {}),
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
      ...(input.platformSource !== undefined ? { platformSource: input.platformSource } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
  }

  buildEventPayload(input: ServerBetaRecordEventRequest): Record<string, unknown> {
    return {
      projectId: input.projectId,
      sourceType: input.sourceType,
      eventType: input.eventType,
      occurredAtEpoch: input.occurredAtEpoch,
      ...(input.serverSessionId !== undefined ? { serverSessionId: input.serverSessionId } : {}),
      ...(input.contentSessionId !== undefined ? { contentSessionId: input.contentSessionId } : {}),
      ...(input.memorySessionId !== undefined ? { memorySessionId: input.memorySessionId } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.apiKey || !this.apiKey.trim()) {
      throw new ServerBetaClientError(
        'missing_api_key',
        'Server beta API key is not configured (CLAUDE_MEM_SERVER_BETA_API_KEY).',
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
      throw new ServerBetaClientError(
        isTimeout ? 'timeout' : 'transport',
        `Server beta ${method} ${path} failed: ${message}`,
        { cause: error },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ServerBetaClientError(
        'http_error',
        `Server beta ${method} ${path} returned ${response.status}: ${truncate(text, 200)}`,
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
      throw new ServerBetaClientError(
        'invalid_response',
        `Server beta ${method} ${path} returned non-JSON response`,
        { cause: error },
      );
    }
  }
}

export function isServerBetaClientError(error: unknown): error is ServerBetaClientError {
  return error instanceof ServerBetaClientError;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
