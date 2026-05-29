// cmem-sdk public API. Plan: plans/2026-05-25-cmem-sdk-and-server-rename.md §3-7.
//
// Phase 3 implements the construction graph: pool → schema bootstrap →
// repositories → tenancy resolution → Chroma (REQUIRED). The capture,
// generate, search, and session methods on the returned client remain
// stubs that throw a clear "not implemented yet" error — Phases 4-6
// fill them in.
//
// Existing internals in this directory (parser.ts, prompts.ts,
// commit-verification.ts, hardened-options.ts, output-classifier.ts) are
// reused by Phase 5. They are intentionally NOT re-exported from the
// public surface here.

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
import { ChromaSync } from '../services/sync/ChromaSync.js';
import { ChromaMcpManager } from '../services/sync/ChromaMcpManager.js';
import { IngestEventsService } from '../server/services/IngestEventsService.js';

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
 * Public client returned by {@link createCmemClient}. Method bodies are
 * filled in by Phase 3-7. Phase 3 wires construction, tenancy, and
 * `close()`; the I/O methods remain stubs.
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
  /** Run the in-process generation pipeline for a queued job. */
  generate(jobOrEventId: string): Promise<void>;
  /** Sugar for capture-then-generate. */
  captureAndGenerate(event: CmemCaptureEvent): Promise<CmemCaptureResult>;
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
 * Construct a {@link CmemClient}.
 *
 * Phase 3 wires:
 *   1. Pool (either supplied or built from `databaseUrl` /
 *      `CLAUDE_MEM_SERVER_DATABASE_URL`).
 *   2. Idempotent schema bootstrap.
 *   3. Repository facade.
 *   4. Tenancy resolution (`teamId`+`projectId`).
 *   5. Chroma (REQUIRED) — `ChromaSync(projectId).ensureCollectionExists()`
 *      plus a `ChromaMcpManager.isHealthy()` belt-and-suspenders probe.
 *      If `uvx chroma-mcp` cannot start, `createCmemClient` REJECTS and
 *      cleans up the SDK-owned pool before throwing.
 *
 * Phases 4-6 wire the I/O methods on the returned client.
 */
export async function createCmemClient(options: CmemClientOptions): Promise<CmemClient> {
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
  //    collection; isHealthy() is the belt-and-suspenders check that the
  //    manager itself is responsive afterwards.
  const chromaSync = new ChromaSync(projectId);
  try {
    await chromaSync.ensureCollectionExists();
    const mgr = ChromaMcpManager.getInstance();
    const healthy = await mgr.isHealthy();
    if (!healthy) {
      throw new Error('chroma-mcp manager reports unhealthy after init');
    }
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

  // 7. Build and return the client. capture / captureBatch / startSession /
  //    endSession are wired in this phase. generate / captureAndGenerate /
  //    search / context remain Phase 5/6 stubs.
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
    if (event.sourceEventId !== undefined) {
      input.sourceEventId = event.sourceEventId;
    }
    if (event.serverSessionId !== undefined) {
      input.serverSessionId = event.serverSessionId;
    }
    if (event.platformSource !== undefined) {
      input.platformSource = event.platformSource;
    }
    if (event.metadata !== undefined) {
      input.metadata = event.metadata as CreatePostgresAgentEventInput['metadata'];
    }
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
    generate() {
      throw new Error('cmem-sdk: generate — Phase 5 not implemented yet');
    },
    captureAndGenerate() {
      throw new Error('cmem-sdk: captureAndGenerate — Phase 5 not implemented yet');
    },
    search() {
      throw new Error('cmem-sdk: search — Phase 6 not implemented yet');
    },
    context() {
      throw new Error('cmem-sdk: context — Phase 6 not implemented yet');
    },
    async startSession(input: CmemStartSessionInput = {}): Promise<CmemSessionInfo> {
      if (closed) {
        throw new Error('cmem-sdk: client is closed');
      }
      const createInput: Parameters<typeof repos.sessions.create>[0] = {
        projectId,
        teamId,
      };
      if (input.externalSessionId !== undefined) {
        createInput.externalSessionId = input.externalSessionId;
      }
      if (input.contentSessionId !== undefined) {
        createInput.contentSessionId = input.contentSessionId;
      }
      if (input.agentId !== undefined) {
        createInput.agentId = input.agentId;
      }
      if (input.agentType !== undefined) {
        createInput.agentType = input.agentType;
      }
      if (input.platformSource !== undefined) {
        createInput.platformSource = input.platformSource;
      }
      if (input.metadata !== undefined) {
        createInput.metadata = input.metadata as Parameters<
          typeof repos.sessions.create
        >[0]['metadata'];
      }
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
