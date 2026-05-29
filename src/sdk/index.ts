// cmem-sdk public API. Plan: plans/2026-05-25-cmem-sdk-and-server-rename.md §3-7.
//
// Phase 2 only defines the public surface as types + stubs that throw
// a clear "not implemented yet (Phase 3)" error. This proves the export
// wiring works end-to-end without prejudging Phase 3+ design.
//
// Existing internals in this directory (parser.ts, prompts.ts,
// commit-verification.ts, hardened-options.ts, output-classifier.ts) are
// reused by Phase 5. They are intentionally NOT re-exported from the
// public surface here.

/**
 * Tuning options for the required Chroma semantic-search engine.
 *
 * Chroma is REQUIRED (see plan Executive Decision). There is no
 * `enabled: false` toggle — these options exist only to tune the
 * Chroma engine (collection naming, mcp subprocess path, etc.).
 */
export interface ChromaOptions {
  /**
   * Optional override for the Chroma collection-name prefix. Defaults to
   * the `cm__<projectId>` convention used by the existing ChromaSync.
   */
  collectionPrefix?: string;

  /**
   * Optional override for the chroma-mcp executable path. Defaults to
   * resolving `uvx chroma-mcp` on PATH.
   */
  mcpPath?: string;
}

/**
 * Options accepted by {@link createCmemClient}.
 *
 * See plan §3 for the full graph this builds (pool → schema bootstrap →
 * repositories → ChromaSync). Provide either `databaseUrl` or `pool`;
 * provide explicit `teamId`+`projectId` in production (else the SDK
 * bootstraps + persists defaults to `$CLAUDE_MEM_DATA_DIR/sdk-tenant.json`).
 */
export interface CmemClientOptions {
  /**
   * Postgres connection URL. Falls back to `CLAUDE_MEM_SERVER_DATABASE_URL`
   * when neither this nor `pool` is supplied.
   */
  databaseUrl?: string;

  /**
   * Pre-built `pg.Pool` (or `PostgresQueryable`-compatible) instance.
   * When supplied, the SDK does NOT close it on `client.close()`.
   *
   * Typed as `unknown` here to keep the public type surface free of a
   * runtime dependency on `pg` types at Phase 2 — Phase 3 narrows this.
   */
  pool?: unknown;

  /**
   * Tenant team identifier (UUID). When omitted, the SDK calls
   * `ensureDefaults()` and persists the resolved ID.
   */
  teamId?: string;

  /**
   * Tenant project identifier (UUID). When omitted, the SDK calls
   * `ensureDefaults()` and persists the resolved ID.
   */
  projectId?: string;

  /**
   * Optional human-readable project name used only when the SDK has to
   * create a default project (i.e. neither `projectId` nor a persisted
   * tenant file is present).
   */
  projectName?: string;

  /**
   * Generation provider. Either a constructed `ServerGenerationProvider`
   * (Phase 5 narrows the type) or `undefined` to fall back to the
   * env-driven `buildServerGenerationProviderFromEnv()` resolution.
   *
   * Typed as `unknown` to avoid leaking server internals at Phase 2.
   */
  provider?: unknown;

  /**
   * Chroma tuning. Chroma is REQUIRED; this object does NOT include an
   * `enabled` flag. See {@link ChromaOptions}.
   */
  chroma?: ChromaOptions;
}

/**
 * Generic search-result entry surfaced by {@link CmemClient.search}.
 *
 * Phase 7 will narrow this to the real `PostgresObservation` shape.
 */
export interface CmemSearchResult {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  score?: number;
}

/**
 * Response envelope for search/context calls. `degraded: true` is set
 * when Chroma was unavailable at request time and the call fell back to
 * Postgres FTS (see plan §6).
 */
export interface CmemSearchResponse {
  results: CmemSearchResult[];
  degraded?: boolean;
}

/**
 * Response envelope for {@link CmemClient.context}. Mirrors the
 * `ServerV1PostgresRoutes` `/context` shape — observations + a single
 * `\n\n`-joined string.
 */
export interface CmemContextResponse {
  observations: CmemSearchResult[];
  context: string;
  degraded?: boolean;
}

/**
 * The friendly capture-event shape accepted by
 * {@link CmemClient.capture} / {@link CmemClient.captureBatch}. Phase 4
 * maps this to `CreatePostgresAgentEventInput`.
 */
export interface CmemCaptureEvent {
  sourceAdapter: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt?: Date | string;
  sourceEventId?: string;
  serverSessionId?: string;
}

/**
 * Identifier returned by capture/generate calls. Phase 4 narrows.
 */
export interface CmemCaptureResult {
  agentEventId: string;
  generationJobId: string;
}

/**
 * Public client returned by {@link createCmemClient}. Method bodies are
 * filled in by Phase 3-7.
 */
export interface CmemClient {
  /** Persist a single agent event + outbox generation job. */
  capture(event: CmemCaptureEvent): Promise<CmemCaptureResult>;
  /** Persist many events in a single transactional batch. */
  captureBatch(events: CmemCaptureEvent[]): Promise<CmemCaptureResult[]>;
  /** Run the in-process generation pipeline for a queued job. */
  generate(jobOrEventId: string): Promise<void>;
  /** Sugar for capture-then-generate. */
  captureAndGenerate(event: CmemCaptureEvent): Promise<CmemCaptureResult>;
  /** Semantic search with FTS runtime safety net. See plan §6. */
  search(input: { query: string; limit?: number }): Promise<CmemSearchResponse>;
  /** Search + join contents into a single `\n\n`-delimited context blob. */
  context(input: { query: string; limit?: number }): Promise<CmemContextResponse>;
  /** Begin a server session for grouping subsequent captures. */
  startSession(input?: { name?: string }): Promise<{ serverSessionId: string }>;
  /** End the named server session. */
  endSession(serverSessionId: string): Promise<void>;
  /** Close Chroma + pool (if SDK-owned). Safe to call repeatedly. */
  close(): Promise<void>;
}

/**
 * Construct a {@link CmemClient}.
 *
 * Phase 2 stub: throws synchronously inside the returned promise so the
 * export wiring can be exercised end-to-end (resolve → call → catch).
 * Phase 3 replaces this with the real wiring.
 */
export async function createCmemClient(_options: CmemClientOptions): Promise<CmemClient> {
  throw new Error('cmem-sdk: createCmemClient stub — Phase 3 not implemented yet');
}
