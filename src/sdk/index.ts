// cmem-sdk public API. Plan: plans/2026-05-25-cmem-sdk-and-server-rename.md §3-7.
//
// `createCmemClient(options)` builds the full in-process graph — pool →
// schema bootstrap → repositories → tenancy resolution → Chroma (REQUIRED)
// — and returns a CmemClient with every I/O method implemented: capture,
// captureBatch, generate, captureAndGenerate, search, context,
// startSession, endSession, and close.
//
// Existing internals in this directory (parser.ts, prompts.ts,
// commit-verification.ts, hardened-options.ts, output-classifier.ts) are
// reused internally (parser.ts + prompts.ts back generation). They are
// intentionally NOT re-exported from the public surface here.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  createPostgresPool,
  closePostgresPool,
  withPostgresTransaction,
  type PostgresPool,
} from '../storage/postgres/pool.js';
import { parsePostgresConfig } from '../storage/postgres/config.js';
import { bootstrapServerPostgresSchema } from '../storage/postgres/schema.js';
import {
  createPostgresStorageRepositories,
  type PostgresStorageRepositories,
} from '../storage/postgres/index.js';
import type { CreatePostgresAgentEventInput } from '../storage/postgres/agent-events.js';
import { ChromaSync, type ChromaDocument } from '../services/sync/ChromaSync.js';
import { ChromaMcpManager } from '../services/sync/ChromaMcpManager.js';
import { logger } from '../utils/logger.js';
import { IngestEventsService } from '../server/services/IngestEventsService.js';
import { ModeManager } from '../services/domain/ModeManager.js';
import {
  ClaudeObservationProvider,
  type ClaudeObservationProviderOptions,
} from '../server/generation/providers/ClaudeObservationProvider.js';
import { GeminiObservationProvider } from '../server/generation/providers/GeminiObservationProvider.js';
import { OpenRouterObservationProvider } from '../server/generation/providers/OpenRouterObservationProvider.js';
import type {
  ServerGenerationProvider,
  ServerGenerationResult,
} from '../server/generation/providers/shared/types.js';
import { processGeneratedResponse } from '../server/generation/processGeneratedResponse.js';
import type { PostgresObservation } from '../storage/postgres/observations.js';

// ---------------------------------------------------------------------------
// Public type re-exports. Plan: plans/2026-05-25-cmem-sdk-and-server-rename.md §7
// line 263 — "re-export `PostgresObservation`, the capture input type, search
// result/context types, and the relevant `src/core/schemas` Zod types. Keep
// the surface small and stable."
//
// Rules:
//   - Type-only (`export type`) for storage/core shapes — consumers should
//     read these as data, not instantiate Zod validators against them. This
//     also keeps the SDK bundle from gaining new runtime imports of
//     `src/core/schemas/*` (those modules pull `zod` at runtime).
//   - Only the entity types a Phase 8 SDK consumer would actually name
//     when they `import { ... } from 'claude-mem/sdk'` — implementation
//     helpers (`PostgresStorageRepositories` is already re-exported via the
//     `repos` field's structural type, internal `IngestEventsService`,
//     `*Row` interfaces, deterministic-key builders) stay private.
// ---------------------------------------------------------------------------

// Postgres storage entity types. `PostgresObservation` is the headline
// re-export — every public result-bearing SDK method returns these. The
// other three are the rest of the rows surfaced through `client.repos.*` so
// consumers can name them without reaching into `claude-mem` internals.
export type {
  PostgresObservation,
  PostgresObservationSource,
  ObservationSourceType,
} from '../storage/postgres/observations.js';
export type {
  PostgresAgentEvent,
  CreatePostgresAgentEventInput,
} from '../storage/postgres/agent-events.js';
export type { PostgresServerSession } from '../storage/postgres/server-sessions.js';
export type { PostgresProject } from '../storage/postgres/projects.js';
export type { PostgresTeam, PostgresTeamMember, PostgresTeamRole } from '../storage/postgres/teams.js';
export type {
  PostgresObservationGenerationJob,
  PostgresObservationGenerationJobEvent,
  ObservationGenerationJobSourceType,
  ObservationGenerationJobStatus,
  ObservationGenerationJobEventType,
} from '../storage/postgres/generation-jobs.js';
// `PostgresStorageRepositories` is referenced on the `CmemClient.repos`
// field, so consumers using e.g. `client.repos.agentEvents.getByIdForScope(...)`
// can name the shape themselves. The implementation factory
// (`createPostgresStorageRepositories`) stays private — consumers go through
// `createCmemClient`, not through the repo factory directly.
export type { PostgresStorageRepositories } from '../storage/postgres/index.js';

// Core schema types. These are the storage-agnostic shapes from
// `src/core/schemas/`; they're a stable surface for downstream consumers
// that want to model claude-mem data without importing the Postgres-specific
// row types. Type-only — the matching `*Schema` Zod values stay internal
// to keep the runtime surface frozen.
export type {
  MemoryItem,
  CreateMemoryItem,
  MemoryItemKind,
  MemorySource,
  CreateMemorySource,
  MemorySourceType,
} from '../core/schemas/memory-item.js';
export type {
  AgentEvent,
  CreateAgentEvent,
  AgentEventSourceType,
} from '../core/schemas/agent-event.js';
export type { ServerSession, CreateServerSession, ServerSessionStatus } from '../core/schemas/session.js';
export type { Project, CreateProject } from '../core/schemas/project.js';
export type { Team, CreateTeam, TeamMember, CreateTeamMember, TeamRole } from '../core/schemas/team.js';

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
 * Pre-constructed generation provider accepted by
 * {@link CmemClientOptions.provider}. Identical shape to the server's
 * `ServerGenerationProvider`. Re-exported under a friendly name so
 * SDK consumers don't have to reach into `claude-mem/server`.
 */
export type CmemProvider = ServerGenerationProvider;

/**
 * Configuration object accepted by {@link CmemClientOptions.provider}.
 * The SDK uses this to construct the matching concrete provider
 * ({@link ClaudeObservationProvider}, `GeminiObservationProvider`, or
 * `OpenRouterObservationProvider`). Defaults to `provider: 'claude'`.
 *
 * Mirrors the env-driven shape used by
 * `buildServerGenerationProviderFromEnv()` in
 * `src/server/runtime/create-server-service.ts:247`.
 */
export interface CmemProviderConfig {
  /** Provider API key. Required. */
  apiKey: string;
  /** Optional model id override (e.g. `claude-sonnet-4-6`). */
  model?: string;
  /** Provider kind. Defaults to `'claude'`. */
  provider?: 'claude' | 'gemini' | 'openrouter';
  /** OpenRouter-only: optional OpenAI-compatible base URL. */
  baseUrl?: string;
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
   * runtime dependency on `pg` types in consumer projects — Phase 3
   * narrows internally when consumed.
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
   * Optional human-readable team name used only when the SDK has to
   * create a default team.
   */
  teamName?: string;

  /**
   * Optional human-readable project name used only when the SDK has to
   * create a default project (i.e. neither `projectId` nor a persisted
   * tenant file is present).
   */
  projectName?: string;

  /**
   * Generation provider. Three accepted shapes:
   *   1. A pre-constructed {@link CmemProvider} (anything with the right
   *      `.generate(context, signal?)` shape — typically a server-internal
   *      provider class like {@link ClaudeObservationProvider}).
   *   2. A {@link CmemProviderConfig} `{ apiKey, model?, provider? }` —
   *      the SDK instantiates the matching concrete provider for you.
   *   3. `undefined` — the SDK falls back to the env-driven resolution
   *      mirroring `buildServerGenerationProviderFromEnv()` in
   *      `create-server-service.ts:247`. Reading `CLAUDE_MEM_SERVER_PROVIDER`
   *      + `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENROUTER_API_KEY`
   *      and `CLAUDE_MEM_SERVER_MODEL`. Defaults to Claude when
   *      `ANTHROPIC_API_KEY` is set.
   *
   * When `client.generate(...)` is called without any of these resolving
   * to a usable provider, the call rejects with a clear error.
   */
  provider?: CmemProvider | CmemProviderConfig;

  /**
   * Chroma tuning. Chroma is REQUIRED; this object does NOT include an
   * `enabled` flag. See {@link ChromaOptions}.
   */
  chroma?: ChromaOptions;
}

/**
 * Response envelope for {@link CmemClient.search}.
 *
 * `observations` are hydrated {@link PostgresObservation} rows — the same
 * shape callers see when reading directly from `repos.observations.*`.
 *
 * `chroma: true` means the result came from the Chroma semantic engine
 * (the default and intended path). `chroma: false` + `degraded: true`
 * means Chroma failed at request time and the SDK fell through to the
 * Postgres FTS safety net. This is a RUNTIME state, not a config toggle;
 * a `logger.error('CHROMA', …)` is emitted whenever it happens so an
 * operator can investigate the chroma-mcp subprocess.
 *
 * `error` is only present on the degraded branch. See plan §6.
 */
export interface CmemSearchResponse {
  observations: PostgresObservation[];
  chroma: boolean;
  degraded: boolean;
  error?: { message: string };
}

/**
 * Response envelope for {@link CmemClient.context}. Mirrors the
 * `ServerV1PostgresRoutes` `/context` shape — observations + a single
 * `\n\n`-joined string. `degraded` propagates from the underlying
 * {@link CmemSearchResponse}.
 */
export interface CmemContextResponse {
  observations: PostgresObservation[];
  context: string;
  degraded: boolean;
}

/**
 * The friendly capture-event shape accepted by
 * {@link CmemClient.capture} / {@link CmemClient.captureBatch}. Phase 4
 * maps this to `CreatePostgresAgentEventInput`. `projectId` + `teamId`
 * are added by the SDK from the resolved tenancy, not by the caller.
 */
export interface CmemCaptureEvent {
  /** Source system label (e.g. 'custom-cli', 'my-bot'). Required. */
  sourceAdapter: string;
  /** Event type tag (e.g. 'message', 'tool-use'). Required. */
  eventType: string;
  /** Free-form payload. Will be JSON-serialized. */
  payload: Record<string, unknown>;
  /** When this event happened. Defaults to `new Date()`. */
  occurredAt?: Date | string | number;
  /** Caller's idempotency key for dedup. Optional but recommended. */
  sourceEventId?: string;
  /** Optional server-session id this event belongs to. */
  serverSessionId?: string;
  /** Optional platform-source label (e.g. 'claude-code', 'opencode'). */
  platformSource?: string;
  /** Free-form metadata. Defaults to `{}`. */
  metadata?: Record<string, unknown>;
}

/**
 * Result of a {@link CmemClient.capture} / `captureBatch` call. Mirrors
 * the underlying `IngestEventsService.ingestOne` return shape, projected
 * down to the IDs consumers actually want.
 *
 * `generationJobId` is the queued `observation_generation_jobs` row that
 * Phase 5's `generate(jobId)` will consume. The SDK never enqueues to
 * Redis/BullMQ, so the job stays in status `queued` until you run it.
 */
export interface CmemCaptureResult {
  agentEventId: string;
  generationJobId: string;
}

/**
 * Optional input accepted by {@link CmemClient.startSession}. Maps to
 * `PostgresServerSessionsRepository.create`'s tenant-scoped input.
 */
export interface CmemStartSessionInput {
  /** Caller-supplied external session id (used for idempotent dedup). */
  externalSessionId?: string;
  /** Caller-supplied content session id (used for idempotent dedup). */
  contentSessionId?: string;
  /** Agent identifier (e.g. user or assistant id). */
  agentId?: string;
  /** Agent type label. */
  agentType?: string;
  /** Platform-source label (e.g. 'claude-code', 'opencode'). */
  platformSource?: string;
  /** Free-form metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Identifier returned by {@link CmemClient.startSession}.
 */
export interface CmemSessionInfo {
  serverSessionId: string;
}

/**
 * Result of a {@link CmemClient.generate} call. Mirrors
 * `processGeneratedResponse`'s `'completed'` outcome — the persisted
 * observations and the provider/model that produced them.
 *
 * `observations: []` is a normal-successful outcome when the provider
 * decided there was nothing worth recording (privacy-skipped batch,
 * `<skip_summary />` response, etc.). The job is marked completed
 * either way.
 */
export interface CmemGenerateResult {
  jobId: string;
  observations: PostgresObservation[];
  providerLabel: string;
  modelId?: string;
  /** `true` when the response was a privacy/skip signal with no observations. */
  privateContentDetected: boolean;
}

/**
 * Result of {@link CmemClient.captureAndGenerate}. The IDs from the
 * underlying {@link CmemCaptureResult} plus the persisted
 * {@link CmemGenerateResult}.
 */
export interface CmemCaptureAndGenerateResult {
  agentEventId: string;
  generationJobId: string;
  result: CmemGenerateResult;
}

/**
 * Public client returned by {@link createCmemClient}. All methods are
 * implemented: construction/tenancy/`close()` plus the capture, generate,
 * search, context, and session I/O paths.
 */
export interface CmemClient {
  /** Resolved tenant team ID (UUID). */
  readonly teamId: string;
  /** Resolved tenant project ID (UUID). */
  readonly projectId: string;
  /** Repository facade over the Postgres storage layer. */
  readonly repos: PostgresStorageRepositories;
  /** The underlying `pg.Pool` instance the SDK is using. */
  readonly pool: PostgresPool;
  /** The constructed `ChromaSync` for semantic search (Phase 6 consumes). */
  readonly chromaSync: ChromaSync;
  /** Persist a single agent event + outbox generation job. */
  capture(event: CmemCaptureEvent): Promise<CmemCaptureResult>;
  /** Persist many events in a single transactional batch. */
  captureBatch(events: CmemCaptureEvent[]): Promise<CmemCaptureResult[]>;
  /**
   * Run the in-process generation pipeline for a queued job. Transitions
   * the job `queued → processing`, calls the configured provider, then
   * delegates to `processGeneratedResponse` which writes the observations
   * and marks the job `completed` in a single Postgres transaction.
   */
  generate(jobId: string): Promise<CmemGenerateResult>;
  /** Sugar for capture-then-generate. */
  captureAndGenerate(event: CmemCaptureEvent): Promise<CmemCaptureAndGenerateResult>;
  /** Semantic search with FTS runtime safety net. See plan §6. */
  search(input: { query: string; limit?: number }): Promise<CmemSearchResponse>;
  /** Search + join contents into a single `\n\n`-delimited context blob. */
  context(input: { query: string; limit?: number }): Promise<CmemContextResponse>;
  /** Begin a server session for grouping subsequent captures. */
  startSession(input?: CmemStartSessionInput): Promise<CmemSessionInfo>;
  /** End the named server session. Idempotent. */
  endSession(serverSessionId: string): Promise<void>;
  /** Close Chroma + pool (if SDK-owned). Safe to call repeatedly. */
  close(): Promise<void>;
}

/**
 * Resolve the claude-mem data directory without pulling in
 * `src/shared/paths.ts` (which would transitively reference the
 * worker's settings/logger layer). Mirrors the priority that
 * `paths.ts::resolveDataDir` follows for the SDK's narrow needs:
 *   1. `CLAUDE_MEM_DATA_DIR` env var
 *   2. `$HOME/.claude-mem`
 *
 * Kept inline so the SDK bundle stays free of the worker's runtime
 * surface. See plan §3, anti-pattern guards.
 */
function resolveSdkDataDir(): string {
  const fromEnv = process.env.CLAUDE_MEM_DATA_DIR;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return path.join(os.homedir(), '.claude-mem');
}

interface ResolvedTenancy {
  teamId: string;
  projectId: string;
}

/**
 * Type guard that recognizes an already-constructed
 * {@link ServerGenerationProvider}. We don't `instanceof`-check the concrete
 * provider classes because consumers may pass a custom implementation —
 * the structural check (`.generate` + `.providerLabel`) is sufficient.
 */
function isCmemProvider(value: unknown): value is ServerGenerationProvider {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.providerLabel === 'string'
    && typeof candidate.generate === 'function'
  );
}

/**
 * Instantiate the concrete {@link ServerGenerationProvider} for a resolved
 * `{ apiKey, model?, provider?, baseUrl? }`. Shared by the config-object and
 * env-driven resolution paths. Mirrors the dispatch in
 * `src/server/runtime/create-server-service.ts:261-279`.
 */
function instantiateProvider(opts: {
  apiKey: string;
  model?: string;
  provider?: string;
  baseUrl?: string;
}): ServerGenerationProvider {
  const kind = (opts.provider ?? 'claude').toLowerCase();
  if (kind === 'claude' || kind === 'anthropic') {
    const o: ClaudeObservationProviderOptions = { apiKey: opts.apiKey };
    if (opts.model) o.model = opts.model;
    return new ClaudeObservationProvider(o);
  }
  if (kind === 'gemini') {
    const o: { apiKey: string; model?: string } = { apiKey: opts.apiKey };
    if (opts.model) o.model = opts.model;
    return new GeminiObservationProvider(o);
  }
  if (kind === 'openrouter') {
    const o: { apiKey: string; model?: string; baseUrl?: string } = { apiKey: opts.apiKey };
    if (opts.model) o.model = opts.model;
    if (opts.baseUrl) o.baseUrl = opts.baseUrl;
    return new OpenRouterObservationProvider(o);
  }
  throw new Error(
    `cmem-sdk: unsupported provider kind "${opts.provider ?? 'claude'}". ` +
      `Expected one of: "claude", "gemini", "openrouter".`
  );
}

/**
 * Env-driven provider resolution. Mirrors
 * `buildServerGenerationProviderFromEnv()` in
 * `src/server/runtime/create-server-service.ts:261-279`. Returns `null`
 * when no provider can be resolved from the environment — callers surface
 * a clear error at `generate()` time instead of failing at construction.
 */
function buildProviderFromEnv(): ServerGenerationProvider | null {
  const explicit = (process.env.CLAUDE_MEM_SERVER_PROVIDER ?? '').trim().toLowerCase();
  const model = process.env.CLAUDE_MEM_SERVER_MODEL;
  try {
    if (explicit === 'claude' || explicit === 'anthropic' || explicit === '') {
      const apiKey =
        process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_MEM_ANTHROPIC_API_KEY ?? '';
      if (apiKey) return instantiateProvider({ apiKey, model, provider: 'claude' });
      // No claude key. If claude was explicitly demanded, give up; if the
      // provider was unset (''), fall through to the gemini/openrouter scan so
      // an installer that only set GEMINI_API_KEY still works.
      if (explicit !== '') return null;
    }
    if (explicit === 'gemini' || (explicit === '' && process.env.GEMINI_API_KEY)) {
      const apiKey = process.env.GEMINI_API_KEY ?? process.env.CLAUDE_MEM_GEMINI_API_KEY ?? '';
      if (!apiKey) return null;
      return instantiateProvider({ apiKey, model, provider: 'gemini' });
    }
    if (explicit === 'openrouter' || (explicit === '' && process.env.OPENROUTER_API_KEY)) {
      const apiKey =
        process.env.OPENROUTER_API_KEY ?? process.env.CLAUDE_MEM_OPENROUTER_API_KEY ?? '';
      if (!apiKey) return null;
      const baseUrl =
        process.env.CLAUDE_MEM_OPENROUTER_BASE_URL ?? process.env.OPENROUTER_BASE_URL;
      return instantiateProvider({ apiKey, model, provider: 'openrouter', baseUrl });
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve a {@link ServerGenerationProvider} from {@link CmemClientOptions.provider}.
 * Three branches, in order:
 *   1. Already-constructed provider → return as-is.
 *   2. {@link CmemProviderConfig} → instantiate via {@link instantiateProvider}.
 *   3. `undefined` → fall back to {@link buildProviderFromEnv}.
 * Returns `null` only when env resolution found nothing — `generate()` then
 * surfaces a clear "no provider configured" error.
 */
function resolveProvider(
  optionsProvider: CmemClientOptions['provider']
): ServerGenerationProvider | null {
  if (optionsProvider === undefined) {
    return buildProviderFromEnv();
  }
  if (isCmemProvider(optionsProvider)) {
    return optionsProvider;
  }
  // Must be CmemProviderConfig.
  return instantiateProvider(optionsProvider);
}

/**
 * Eager mode initialization. `parseAgentXml` (`src/sdk/parser.ts:105`)
 * calls `ModeManager.getInstance().getActiveMode()` with no fallback —
 * if no mode is loaded, it throws. We mirror `loadServerMode()` in
 * `src/server/runtime/create-server-service.ts:167-177` and load `'code'`
 * once at SDK construction so the failure (a missing/broken
 * `plugin/modes/code.json`) surfaces during `createCmemClient(...)`
 * instead of at every `generate()` call.
 *
 * Throws a clear cmem-sdk-tagged error if the mode cannot be loaded.
 */
function initializeMode(): void {
  try {
    const mgr = ModeManager.getInstance();
    mgr.loadMode('code');
    mgr.getActiveMode();
  } catch (err) {
    const underlying = err instanceof Error ? err.message : String(err);
    throw new Error(
      'cmem-sdk: failed to load default observation mode "code". ' +
        'Generation requires a mode (parser at src/sdk/parser.ts:105 has no fallback). ' +
        'Verify the bundled plugin/modes/code.json is present. ' +
        'Underlying: ' +
        underlying
    );
  }
}

/**
 * Read-or-create the default `{teamId, projectId}` pair. Per plan §3
 * line 191, this is the headless equivalent of the server runtime's
 * implicit tenancy — it persists IDs to a state file under
 * `$CLAUDE_MEM_DATA_DIR/sdk-tenant.json` so subsequent SDK runs reuse
 * them without re-creating rows.
 *
 * Production consumers are expected to pass explicit `teamId`+`projectId`
 * via {@link CmemClientOptions} and bypass this path entirely.
 */
async function resolveTenancy(
  options: CmemClientOptions,
  pool: PostgresPool
): Promise<ResolvedTenancy> {
  if (options.teamId && options.projectId) {
    return { teamId: options.teamId, projectId: options.projectId };
  }

  const stateFile = path.join(resolveSdkDataDir(), 'sdk-tenant.json');

  // 1. Try to reuse a previously persisted pair.
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw) as { teamId?: unknown; projectId?: unknown };
    if (typeof parsed.teamId === 'string' && typeof parsed.projectId === 'string') {
      return { teamId: parsed.teamId, projectId: parsed.projectId };
    }
  } catch {
    // Missing or corrupt — fall through to create.
  }

  // 2. Create default team + project in one transaction so a half-write
  //    can't leave an orphan team.
  const created = await withPostgresTransaction(pool, async (tx) => {
    const txRepos = createPostgresStorageRepositories(tx);
    const team = await txRepos.teams.create({ name: options.teamName ?? 'default' });
    const project = await txRepos.projects.create({
      teamId: team.id,
      name: options.projectName ?? 'default',
    });
    return { teamId: team.id, projectId: project.id };
  });

  // 3. Best-effort persist; failure to write the state file is not fatal —
  //    it just means the next run will re-create the pair. Most callers
  //    will pass explicit IDs in production anyway.
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(created, null, 2));
  } catch {
    // ignore
  }

  return created;
}

/**
 * Copy each `keys` entry from `source` to `target` only when it is defined.
 * Keeps the optional-field plumbing on `mapCaptureEvent` / `startSession`
 * one line each under `exactOptionalPropertyTypes`.
 */
function assignDefined(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key];
  }
}

/**
 * Build {@link ChromaDocument}s for the freshly-persisted observations and
 * index them into the per-tenant Chroma collection via the now-public
 * `ChromaSync.addDocuments` (which batches + delete-then-add reconciles on
 * the `already exist` race). The document `id` is the Postgres observation
 * UUID — one Chroma doc per observation, NOT the SQLite-shaped
 * `obs_<sqlite_id>_<field>` split that `syncObservation` produces.
 *
 * Indexing failure is degraded, not catastrophic: the observations are
 * already in Postgres. The next `client.search()` either hits Chroma on
 * the retry-batched delete+add path, or falls through to FTS via the
 * search-side safety net. We log a warning and continue. See plan §6
 * line 244-247.
 */
async function indexObservationsToChroma(
  chromaSync: ChromaSync,
  observations: PostgresObservation[],
  scope: { projectId: string; teamId: string },
): Promise<void> {
  if (observations.length === 0) return;
  const docs: ChromaDocument[] = observations.map(observation => {
    const metadata: Record<string, string | number> = {
      projectId: scope.projectId,
      teamId: scope.teamId,
      kind: observation.kind,
      observationId: observation.id,
      observationType: observation.kind,
      // ChromaSync's clean step filters out empty strings (ChromaSync.ts:291-295),
      // so passing '' for missing server_session_id collapses cleanly to
      // metadata-absent rather than indexing a meaningless empty value.
      serverSessionId: observation.serverSessionId ?? '',
      createdAt: new Date(observation.createdAtEpoch).toISOString(),
    };
    return {
      id: observation.id,
      document: observation.content,
      metadata,
    };
  });
  try {
    await chromaSync.addDocuments(docs);
  } catch (err) {
    // addDocuments swallows per-batch errors internally and returns a
    // count; an outer throw means something more fundamental (ensure
    // collection / connect) failed. Log + continue: the observations are
    // still persisted in Postgres, search will degrade to FTS until the
    // operator restarts chroma-mcp.
    logger.error(
      'CHROMA',
      'observation indexing failed after generate(); observations are persisted but unsearchable in Chroma until reindex',
      { projectId: scope.projectId, teamId: scope.teamId, observationCount: observations.length },
      err as Error,
    );
  }
}

/**
 * Construct a {@link CmemClient}.
 *
 * Phase 3 wires:
 *   1. Pool (either supplied or built from `databaseUrl` /
 *      `CLAUDE_MEM_SERVER_DATABASE_URL`).
 *   2. Idempotent schema bootstrap.
 *   3. Repository facade.
 *   4. Tenancy resolution (`teamId`+`projectId`).
 *   5. Chroma (REQUIRED) — `ChromaSync(projectId).ensureCollectionExists()`.
 *      If `uvx chroma-mcp` cannot start, `createCmemClient` REJECTS and
 *      cleans up the SDK-owned pool before throwing.
 *
 * The returned client's I/O methods (capture, generate, search, context,
 * sessions) are all implemented below.
 */
export async function createCmemClient(options: CmemClientOptions): Promise<CmemClient> {
  // 0. Mode initialization. `parseAgentXml` requires an active mode
  //    (src/sdk/parser.ts:105 has no fallback). Loading at construction
  //    surfaces missing-mode-file errors here instead of at every
  //    generate() call. Consistent with the Chroma-required philosophy:
  //    fail fast at construction, not silently at runtime.
  initializeMode();

  // 1. Pool — either consumer-supplied or SDK-owned.
  let pool: PostgresPool;
  let ownsPool = false;
  if (options.pool) {
    pool = options.pool as PostgresPool;
  } else {
    // Allow `databaseUrl` to short-circuit env lookup by temporarily
    // overlaying it onto process.env for `parsePostgresConfig`.
    const envOverlay: NodeJS.ProcessEnv = options.databaseUrl
      ? { ...process.env, CLAUDE_MEM_SERVER_DATABASE_URL: options.databaseUrl }
      : process.env;
    const cfg = parsePostgresConfig({ env: envOverlay });
    if (!cfg) {
      throw new Error(
        'cmem-sdk: CLAUDE_MEM_SERVER_DATABASE_URL or options.databaseUrl is required'
      );
    }
    pool = createPostgresPool(cfg);
    ownsPool = true;
  }

  // 2. Idempotent schema bootstrap.
  try {
    await bootstrapServerPostgresSchema(pool);
  } catch (err) {
    if (ownsPool) {
      await closePostgresPool(pool).catch(() => {});
    }
    throw err;
  }

  // 3. Repository facade.
  const repos = createPostgresStorageRepositories(pool);

  // 4. Tenancy resolution.
  let teamId: string;
  let projectId: string;
  try {
    const tenancy = await resolveTenancy(options, pool);
    teamId = tenancy.teamId;
    projectId = tenancy.projectId;
  } catch (err) {
    if (ownsPool) {
      await closePostgresPool(pool).catch(() => {});
    }
    throw err;
  }

  // 5. Chroma — REQUIRED. ensureCollectionExists boots the chroma-mcp
  //    subprocess (via ChromaMcpManager) and creates the per-project
  //    collection. It rethrows any error other than "already exists", so a
  //    subprocess that can't start surfaces here and rejects construction.
  const chromaSync = new ChromaSync(projectId);
  try {
    await chromaSync.ensureCollectionExists();
  } catch (err) {
    // Clean up everything the SDK owns before rejecting.
    await chromaSync.close().catch(() => {});
    if (ownsPool) {
      await closePostgresPool(pool).catch(() => {});
    }
    const underlying = err instanceof Error ? err.message : String(err);
    throw new Error(
      'cmem-sdk: Chroma is required but uvx chroma-mcp could not start. ' +
        'Install uv (https://docs.astral.sh/uv/) and ensure chroma-mcp is available. ' +
        'Underlying: ' +
        underlying
    );
  }

  // 6. Build the IngestEventsService once at construction. `resolveEventQueue`
  //    MUST return `null` so the outbox row is written but no BullMQ enqueue
  //    is attempted. Generation never runs inline here — that is Phase 5.
  //    See IngestEventsService.ts:235-238 for the queued_only short-circuit.
  const ingest = new IngestEventsService({
    pool,
    resolveEventQueue: () => null,
  });

  // 7. Resolve the generation provider (Phase 5). Best-effort at construction
  //    so the SDK can still serve capture/search even without a provider; a
  //    `client.generate(...)` call without a resolved provider rejects with a
  //    clear error. Provider exceptions during resolution (e.g. a
  //    `ClaudeObservationProvider` constructor rejecting because apiKey is
  //    empty) bubble up here and abort construction.
  const provider = resolveProvider(options.provider);

  // 8. Build and return the client. All I/O methods (capture, captureBatch,
  //    generate, captureAndGenerate, search, context, startSession,
  //    endSession, close) are implemented below.
  let closed = false;

  function mapCaptureEvent(event: CmemCaptureEvent): CreatePostgresAgentEventInput {
    const input: CreatePostgresAgentEventInput = {
      projectId,
      teamId,
      sourceAdapter: event.sourceAdapter,
      eventType: event.eventType,
      payload: event.payload as CreatePostgresAgentEventInput['payload'],
      occurredAt: event.occurredAt ?? new Date(),
    };
    assignDefined(input as unknown as Record<string, unknown>, event as unknown as Record<string, unknown>, [
      'sourceEventId',
      'serverSessionId',
      'platformSource',
      'metadata',
    ]);
    return input;
  }

  const client: CmemClient = {
    teamId,
    projectId,
    repos,
    pool,
    chromaSync,
    async capture(event: CmemCaptureEvent): Promise<CmemCaptureResult> {
      if (closed) {
        throw new Error('cmem-sdk: client is closed');
      }
      const result = await ingest.ingestOne(mapCaptureEvent(event), {
        source: 'cmem-sdk.capture',
        sourceAdapter: event.sourceAdapter,
      });
      // resolveEventQueue: () => null guarantees `outbox` is non-null and
      // `enqueueState` is 'queued_only' whenever the default `generate: true`
      // path runs (IngestEventsService.ts:236-238). If a future caller
      // disables generation we surface a clear error rather than a TS-cast lie.
      if (!result.outbox) {
        throw new Error(
          'cmem-sdk: capture expected a queued outbox row but received none. ' +
            'This indicates IngestEventsService was invoked with generate: false; ' +
            'capture() must produce a generation job for Phase 5 consumption.'
        );
      }
      return {
        agentEventId: result.event.id,
        generationJobId: result.outbox.id,
      };
    },
    async captureBatch(events: CmemCaptureEvent[]): Promise<CmemCaptureResult[]> {
      if (closed) {
        throw new Error('cmem-sdk: client is closed');
      }
      if (events.length === 0) {
        return [];
      }
      // ingestBatch wraps all writes in a single Postgres transaction
      // (IngestEventsService.ts:170-220), which is materially better than
      // looping ingestOne per event. Same resolveEventQueue: () => null
      // semantics apply to every row.
      const results = await ingest.ingestBatch(
        events.map(mapCaptureEvent),
        { source: 'cmem-sdk.captureBatch' }
      );
      return results.map((r, i) => {
        if (!r.outbox) {
          const sourceEventId = events[i]?.sourceEventId ?? '<no source_event_id>';
          throw new Error(
            'cmem-sdk: captureBatch expected a queued outbox row for event ' +
              `${sourceEventId} but received none.`
          );
        }
        return {
          agentEventId: r.event.id,
          generationJobId: r.outbox.id,
        };
      });
    },
    async generate(jobId: string): Promise<CmemGenerateResult> {
      if (closed) {
        throw new Error('cmem-sdk: client is closed');
      }
      if (!provider) {
        throw new Error(
          'cmem-sdk: no generation provider is configured. ' +
            'Pass options.provider to createCmemClient (either a constructed ' +
            'ServerGenerationProvider or { apiKey, model?, provider? }), or set ' +
            'CLAUDE_MEM_SERVER_PROVIDER + the matching API key environment variable.'
        );
      }
      if (typeof jobId !== 'string' || jobId.trim().length === 0) {
        throw new Error('cmem-sdk: generate requires a non-empty jobId string');
      }

      // Step 1: lock the outbox row. queued → processing is the ONLY legal
      //   first-step transition (transitionStatus enforces it at the SQL
      //   level; generation-jobs.ts:191-194). queued → completed throws.
      //   Pre-load via getByIdForScope to give a precise "not claimable"
      //   error rather than the generic "transition was not applied".
      let lockedJob = await repos.observationGenerationJobs.getByIdForScope({
        id: jobId,
        projectId,
        teamId,
      });
      if (!lockedJob) {
        throw new Error(
          `cmem-sdk: generation job ${jobId} not found in scope (projectId=${projectId}, teamId=${teamId})`
        );
      }
      if (lockedJob.status !== 'queued') {
        throw new Error(
          `cmem-sdk: generation job ${jobId} is not claimable (status="${lockedJob.status}"). ` +
            `generate() requires a job in status "queued"; the row may have been claimed ` +
            `by another worker, already processed, or terminally failed.`
        );
      }

      const transitioned = await repos.observationGenerationJobs.transitionStatus({
        id: jobId,
        projectId,
        teamId,
        status: 'processing',
        lockedBy: 'cmem-sdk',
      });
      if (!transitioned) {
        throw new Error(
          `cmem-sdk: failed to lock generation job ${jobId}; it may have been ` +
            `claimed concurrently by another worker.`
        );
      }
      lockedJob = transitioned;

      // Step 2: load events tied to the job. Mirrors
      //   ProviderObservationGenerator.loadEvents (lines 483-532) for the
      //   'agent_event' source type — the SDK only ever produces
      //   'agent_event' jobs via capture(), but we still scope the load
      //   by tenancy.
      const loadedEvents = [];
      if (lockedJob.agentEventId) {
        const ev = await repos.agentEvents.getByIdForScope({
          id: lockedJob.agentEventId,
          projectId,
          teamId,
        });
        if (ev) loadedEvents.push(ev);
      }

      // Step 3: load the project for the prompt's `projectName`.
      const project = await repos.projects.getByIdForTeam(projectId, teamId);

      // Steps 4–5: call the provider and persist. Both can throw while the
      //   row is in 'processing', and generate()'s queued-only guard can
      //   never reclaim a 'processing' row — so any failure here is marked
      //   terminally 'failed' (a legal processing→failed transition) before
      //   re-throwing. That leaves a diagnosable row with the error recorded
      //   in last_error instead of one stuck in 'processing' forever.
      let providerResult: ServerGenerationResult;
      let outcome: Extract<
        Awaited<ReturnType<typeof processGeneratedResponse>>,
        { kind: 'completed' }
      >;
      try {
        // Step 4: call the provider. The lifted core mirrors
        //   ProviderObservationGenerator.ts:200-209 — no BullMQ payload, no
        //   AbortSignal (consumers control their own timeouts via the
        //   provider's fetchImpl), no scope/revocation audit.
        providerResult = await provider.generate({
          job: lockedJob,
          events: loadedEvents,
          project: {
            projectId,
            teamId,
            serverSessionId: lockedJob.serverSessionId,
            projectName: project?.name ?? null,
          },
        });

        // Step 5: persist via processGeneratedResponse (the single Postgres
        //   transaction that writes observations + observation_sources,
        //   then transitions processing → completed). Mirrors
        //   ProviderObservationGenerator.ts:211-227 minus the
        //   session_summary branch (SDK currently captures only agent_event
        //   jobs) and minus the BullMQ identity-context fields.
        const persistInput: Parameters<typeof processGeneratedResponse>[0] = {
          pool,
          job: lockedJob,
          rawText: providerResult.rawText,
          providerLabel: providerResult.providerLabel,
          sourceAdapter: 'sdk',
        };
        if (providerResult.modelId !== undefined) {
          persistInput.modelId = providerResult.modelId;
        }
        const persisted = await processGeneratedResponse(persistInput);

        if (persisted.kind === 'parse_error') {
          // The provider returned text we couldn't parse. Surface a clear
          // error; the catch below transitions the row to 'failed'.
          throw new Error(
            `cmem-sdk: generation parse error for job ${persisted.jobId}: ${persisted.reason}`
          );
        }
        outcome = persisted;
      } catch (err) {
        await repos.observationGenerationJobs
          .transitionStatus({
            id: jobId,
            projectId,
            teamId,
            status: 'failed',
            lastError: { message: err instanceof Error ? err.message : String(err) },
          })
          .catch(() => {
            // The row was already moved on (e.g. completed inside step 5's
            // own transaction, or claimed by another worker). Nothing to
            // recover; preserve the original error for the caller.
          });
        throw err;
      }

      // Step 6 (Phase 6): index the freshly-persisted observations into
      //   Chroma so subsequent client.search() calls can find them. Postgres
      //   is already canonical at this point — losing the Chroma index is
      //   degraded (next search falls through to FTS), not catastrophic, so
      //   indexing failures log + continue instead of throwing. The opposite
      //   policy would re-emit an error and roll back the user's already-
      //   completed generate(), which is worse than a silent reindex later.
      if (outcome.observations.length > 0) {
        await indexObservationsToChroma(
          chromaSync,
          outcome.observations,
          { projectId, teamId },
        );
      }

      const result: CmemGenerateResult = {
        jobId: outcome.jobId,
        observations: outcome.observations,
        providerLabel: providerResult.providerLabel,
        privateContentDetected: outcome.privateContentDetected,
      };
      if (providerResult.modelId !== undefined) {
        result.modelId = providerResult.modelId;
      }
      return result;
    },
    async captureAndGenerate(event: CmemCaptureEvent): Promise<CmemCaptureAndGenerateResult> {
      if (closed) {
        throw new Error('cmem-sdk: client is closed');
      }
      const captured = await client.capture(event);
      const generated = await client.generate(captured.generationJobId);
      return {
        agentEventId: captured.agentEventId,
        generationJobId: captured.generationJobId,
        result: generated,
      };
    },
    async search(input: { query: string; limit?: number }): Promise<CmemSearchResponse> {
      if (closed) {
        throw new Error('cmem-sdk: client is closed');
      }
      const limit = input.limit ?? 10;
      const query = typeof input.query === 'string' ? input.query : '';

      // Empty-query path — no semantic intent to express. Mirror the
      // SearchManager filter-only branch (SearchManager.ts:165-176) by
      // returning the most recent observations for this tenant. Chroma is
      // never consulted here, so `chroma: false` (it is NOT degraded — this
      // is the intended filter-only behavior, not a Chroma failure).
      if (query.trim().length === 0) {
        const observations = await repos.observations.listByProject({
          projectId,
          teamId,
          limit,
        });
        return { observations, chroma: false, degraded: false };
      }

      // Default path — Chroma semantic. Per plan §6 line 240:
      //   queryChromaRaw → UUID doc ids → hydrate via getByIdForScope.
      // We call ChromaMcpManager.callTool directly (not ChromaSync.queryChroma)
      // because the latter routes through deduplicateQueryResults() which
      // is hard-coded to SQLite-shaped `obs_<digits>_<field>` ids and would
      // silently drop our UUID-shaped doc ids. ChromaSync still owns the
      // collection lifecycle (ensureCollectionExists / close); only the
      // query parse differs.
      try {
        await chromaSync.ensureCollectionExists();
        const mgr = ChromaMcpManager.getInstance();
        // Per-tenant `where` filter: doc metadata carries projectId + teamId
        // so a future shared collection can stay safely scoped, even though
        // today's collection name is already `cm__<projectId>`.
        const whereFilter = {
          $and: [
            { projectId },
            { teamId },
          ],
        };
        const raw = (await mgr.callTool('chroma_query_documents', {
          collection_name: chromaSync.getCollectionName(),
          query_texts: [query],
          n_results: limit,
          where: whereFilter,
          include: ['documents', 'metadatas', 'distances'],
        })) as {
          ids?: string[][];
          documents?: string[][];
          metadatas?: Array<Array<Record<string, unknown> | null>>;
          distances?: number[][];
        };

        const docIds = raw?.ids?.[0] ?? [];
        if (docIds.length === 0) {
          return { observations: [], chroma: true, degraded: false };
        }

        // Hydrate via getByIdForScope. We preserve Chroma's rank order
        // because semantic distance is the whole reason we called Chroma.
        // listByProject would reorder by created_at and undo that.
        const hydrated: PostgresObservation[] = [];
        for (const docId of docIds) {
          if (typeof docId !== 'string') continue;
          const obs = await repos.observations.getByIdForScope({
            id: docId,
            projectId,
            teamId,
          });
          if (obs) hydrated.push(obs);
        }
        return { observations: hydrated, chroma: true, degraded: false };
      } catch (err) {
        // Runtime safety net — Chroma transiently died (subprocess exit,
        // ECONNREFUSED, etc.). Mirrors SearchManager.ts:255's catch-and-
        // degrade-once pattern. This is NOT a feature toggle: a successful
        // run never enters this branch. We log loudly so an operator can
        // investigate the uvx chroma-mcp subprocess. See plan §6 line 242
        // and the 2026-05-29 correction log.
        logger.error(
          'CHROMA',
          'semantic search failed; returning degraded FTS results — investigate uvx chroma-mcp',
          { projectId, teamId, query },
          err as Error,
        );
        const observations = await repos.observations.search({
          projectId,
          teamId,
          query,
          limit,
        });
        return {
          observations,
          chroma: false,
          degraded: true,
          error: { message: 'chroma-mcp transient failure' },
        };
      }
    },
    async context(input: { query: string; limit?: number }): Promise<CmemContextResponse> {
      if (closed) {
        throw new Error('cmem-sdk: client is closed');
      }
      // Reuse search so the Chroma / degraded-FTS branching lives in exactly
      // one place. The context-pack format below copies the
      // ServerV1PostgresRoutes /v1/context handler verbatim
      // (ServerV1PostgresRoutes.ts:892-895): map → filter non-empty → join.
      const result = await client.search(input);
      const context = result.observations
        .map(observation => observation.content)
        .filter(text => typeof text === 'string' && text.length > 0)
        .join('\n\n');
      return {
        observations: result.observations,
        context,
        degraded: result.degraded,
      };
    },
    async startSession(input: CmemStartSessionInput = {}): Promise<CmemSessionInfo> {
      if (closed) {
        throw new Error('cmem-sdk: client is closed');
      }
      const createInput: Parameters<typeof repos.sessions.create>[0] = {
        projectId,
        teamId,
      };
      assignDefined(createInput as unknown as Record<string, unknown>, input as unknown as Record<string, unknown>, [
        'externalSessionId',
        'contentSessionId',
        'agentId',
        'agentType',
        'platformSource',
        'metadata',
      ]);
      const session = await repos.sessions.create(createInput);
      return { serverSessionId: session.id };
    },
    async endSession(serverSessionId: string): Promise<void> {
      if (closed) {
        throw new Error('cmem-sdk: client is closed');
      }
      // endSession is idempotent (server-sessions.ts:145-162). It returns
      // null only if the (id, projectId, teamId) tuple does not exist;
      // surface that as a clear error so callers don't silently no-op.
      const updated = await repos.sessions.endSession({
        id: serverSessionId,
        projectId,
        teamId,
      });
      if (!updated) {
        throw new Error(
          `cmem-sdk: endSession could not find server_session ${serverSessionId} ` +
            `for tenant (projectId=${projectId}, teamId=${teamId})`
        );
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await chromaSync.close().catch(() => {});
      if (ownsPool) {
        await closePostgresPool(pool).catch(() => {});
      }
    },
  };

  return client;
}
