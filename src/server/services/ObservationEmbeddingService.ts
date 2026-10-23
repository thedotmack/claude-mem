// SPDX-License-Identifier: Apache-2.0

// Embeddings for search by meaning. Everything here degrades to "no vectors":
// CLAUDE_MEM_SERVER_VECTOR_SEARCH off, a database without pgvector, a model
// that fails to load, or an embed error leaves search keyword-only and
// observation writes untouched. Rows written
// without vectors are picked up by backfillMissingEmbeddings, which runs at
// startup in the generation worker, or in a server that has none.

import { availableParallelism } from 'os';
import pg from 'pg';
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import type { VectorSchemaMode } from '../../storage/postgres/schema.js';
import {
  PostgresObservationEmbeddingsRepository,
  observationEmbeddingParts,
  vectorSearchAvailable,
  type ObservationEmbeddingPart,
} from '../../storage/postgres/observation-embeddings.js';
import { LocalEmbedder } from '../../services/vector/LocalEmbedder.js';
import { resolveEmbeddingModel } from '../../services/vector/models.js';
import type { Embedder } from '../../services/vector/types.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

let sharedEmbedder: Embedder | null = null;
// The most recent embed failure, cleared by the next success, so /v1/info can
// say why search is keyword-only instead of leaving it to the log.
let lastEmbedError: { message: string; at: string } | null = null;

function newSharedEmbedder(threads?: number): LocalEmbedder {
  return new LocalEmbedder(resolveEmbeddingModel(SettingsDefaultsManager.get('CLAUDE_MEM_EMBEDDING_MODEL')), threads);
}

/** The embedder for CLAUDE_MEM_EMBEDDING_MODEL; an unknown model name throws. */
export function getSharedEmbedder(): Embedder {
  sharedEmbedder ??= newSharedEmbedder();
  return sharedEmbedder;
}

/**
 * CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS: a number, 0 for no cap, empty for
 * half the CPU threads. A value that is not a number of threads takes the
 * default rather than every thread.
 */
function backfillThreads(): number {
  const half = Math.max(1, Math.floor(availableParallelism() / 2));
  const value = SettingsDefaultsManager.get('CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS').trim();
  const threads = Number(value);
  return value === '' || !Number.isFinite(threads) || threads < 0 ? half : Math.floor(threads);
}

/**
 * At startup, before anything embeds: when stored rows have no vectors from
 * the current model (search by meaning just turned on, or the model changed),
 * warn that the backfill may take hours and cap the shared embedder's threads
 * until the next restart, so catching up does not take every core. The model's
 * thread count is fixed when it loads, which is why this must run first; the
 * embedder it replaces has not loaded. Returns the cap applied, or null.
 */
export async function capEmbedderThreadsForBackfill(client: PostgresQueryable): Promise<number | null> {
  if (!(await vectorSearchOn(client))) return null;
  const model = getSharedEmbedder().modelId;
  const backlog = await new PostgresObservationEmbeddingsRepository(client).countMissing(model);
  if (backlog === 0) return null;
  const threads = backfillThreads();
  if (threads > 0) sharedEmbedder = newSharedEmbedder(threads);
  logger.warn('SYSTEM', 'embedding stored observations for search by meaning; this may take hours', {
    observations: backlog,
    model,
    threads: threads > 0 ? `${threads} of ${availableParallelism()}, until the next restart` : 'all',
    progress: '/v1/info vectorSearch.observationsWithoutVectors',
    settings: 'CLAUDE_MEM_EMBEDDING_BACKFILL_THREADS=0 uses every thread; CLAUDE_MEM_SERVER_VECTOR_SEARCH=false stops it',
  });
  return threads > 0 ? threads : null;
}

/** CLAUDE_MEM_SERVER_VECTOR_SEARCH: 'true' is on, 'false' off, anything else auto. */
export function vectorSearchMode(): VectorSchemaMode {
  const value = SettingsDefaultsManager.get('CLAUDE_MEM_SERVER_VECTOR_SEARCH').toLowerCase();
  return value === 'true' ? 'on' : value === 'false' ? 'off' : 'auto';
}

// Unless the setting is off, the embeddings table decides: the schema
// bootstrap created it or left it out.
async function vectorSearchOn(client: PostgresQueryable): Promise<boolean> {
  return vectorSearchMode() !== 'off' && vectorSearchAvailable(client);
}

function recordEmbedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  lastEmbedError = { message, at: new Date().toISOString() };
  return message;
}

export interface VectorSearchStatus {
  /** The setting is on, pgvector 0.8+ was installable and the embeddings table exists. */
  available: boolean;
  model: string;
  /** Observations a search by meaning cannot find yet; null when unavailable. */
  observationsWithoutVectors: number | null;
  lastEmbedError: { message: string; at: string } | null;
}

// The missing-vector count reads every observation, a few hundred
// milliseconds on a large store, so /v1/info reuses it for a minute rather
// than counting on every request.
const MISSING_COUNT_TTL_MS = 60_000;
const missingCounts = new WeakMap<PostgresQueryable, Map<string, { at: number; count: Promise<number> }>>();

function cachedCountMissing(client: PostgresQueryable, model: string): Promise<number> {
  let byModel = missingCounts.get(client);
  if (!byModel) missingCounts.set(client, byModel = new Map());
  const cached = byModel.get(model);
  if (cached && Date.now() - cached.at < MISSING_COUNT_TTL_MS) return cached.count;
  const count = new PostgresObservationEmbeddingsRepository(client).countMissing(model);
  byModel.set(model, { at: Date.now(), count });
  count.catch(() => byModel!.delete(model));
  return count;
}

export async function getVectorSearchStatus(
  client: PostgresQueryable,
  embedder: Embedder = getSharedEmbedder(),
): Promise<VectorSearchStatus> {
  const available = await vectorSearchOn(client);
  return {
    available,
    model: embedder.modelId,
    observationsWithoutVectors: available
      ? await cachedCountMissing(client, embedder.modelId)
      : null,
    lastEmbedError,
  };
}

/**
 * How long a request waits for the embedding model to finish loading. A
 * server outside Docker downloads the model at first use, which can take
 * minutes or never finish behind a firewall; past this, the request goes on
 * without vectors (keyword-only search, or a write the backfill embeds later)
 * while the load carries on in the background.
 */
export const EMBEDDER_READY_WAIT_MS = 2_000;

/**
 * Whether the embedder can embed now, waiting at most `waitMs` for its model
 * to load, and no longer than until `signal` aborts.
 */
async function embedderReadyWithin(embedder: Embedder, waitMs: number, signal?: AbortSignal): Promise<boolean> {
  if (!embedder.isReady || !embedder.warm || embedder.isReady()) return true;
  const warming = embedder.warm();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const giveUp = new Promise<boolean>(resolve => {
    if (waitMs !== Infinity) timer = setTimeout(() => resolve(false), waitMs);
    if (signal) {
      onAbort = () => resolve(false);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([warming, giveUp]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * At startup, when search by meaning is on: begin loading the model in the
 * background, so the first save or search does not wait for the download.
 */
export async function warmSharedEmbedder(client: PostgresQueryable): Promise<void> {
  if (!(await vectorSearchOn(client))) return;
  const embedder = getSharedEmbedder();
  void embedder.warm?.().then(ready => {
    if (!ready) logger.warn('SYSTEM', 'the embedding model did not load; search is keyword-only until it does');
  });
}

/** The query's vector and its model, or null when search should stay keyword-only. */
export async function embedSearchQuery(
  client: PostgresQueryable,
  query: string | null | undefined,
  embedder: Embedder = getSharedEmbedder(),
  options: { waitForModelMs?: number } = {},
): Promise<{ vector: Float32Array; model: string } | null> {
  if (!query || query.trim().length === 0) return null;
  try {
    if (!(await vectorSearchOn(client))) return null;
    if (!(await embedderReadyWithin(embedder, options.waitForModelMs ?? EMBEDDER_READY_WAIT_MS))) {
      logger.debug('SYSTEM', 'embedding model still loading; searching by keyword only');
      return null;
    }
    const [vector] = await embedder.embed([query], 'query');
    lastEmbedError = null;
    return vector ? { vector, model: embedder.modelId } : null;
  } catch (error) {
    logger.warn('SYSTEM', 'query embedding failed; searching by keyword only', {
      error: recordEmbedError(error),
    });
    return null;
  }
}

/** One row's vectors, shaped for PostgresObservationEmbeddingsRepository.upsert. */
export interface EmbeddedParts {
  /** The model that made these vectors. */
  model: string;
  parts: ObservationEmbeddingPart[];
  vectors: Float32Array[];
}

/**
 * Embed the parts of rows about to be written, in one batch, before the write
 * transaction opens so the model never holds it. Null when vectors are
 * unavailable; the rows are then written without them.
 */
export async function embedObservationRows(
  client: PostgresQueryable,
  rows: Array<{ kind: string; metadata: Record<string, unknown>; content: string }>,
  embedder: Embedder = getSharedEmbedder(),
  options: { waitForModelMs?: number } = {},
): Promise<EmbeddedParts[] | null> {
  if (rows.length === 0) return [];
  try {
    if (!(await vectorSearchOn(client))) return null;
    if (!(await embedderReadyWithin(embedder, options.waitForModelMs ?? EMBEDDER_READY_WAIT_MS))) {
      logger.debug('SYSTEM', 'embedding model still loading; rows are written without vectors for the backfill');
      return null;
    }
    const partsPerRow = rows.map(row => observationEmbeddingParts(row.kind, row.metadata, row.content));
    const vectors = await embedder.embed(partsPerRow.flat().map(p => p.text));
    lastEmbedError = null;
    let offset = 0;
    return partsPerRow.map(parts => {
      const slice = vectors.slice(offset, offset + parts.length);
      offset += parts.length;
      return { model: embedder.modelId, parts, vectors: slice };
    });
  } catch (error) {
    logger.warn('SYSTEM', 'observation embedding failed; rows are written without vectors', {
      error: recordEmbedError(error),
    });
    return null;
  }
}

/**
 * Embed every observation that has no vector yet. Safe to run beside live
 * writes: each row is upserted on its own, and a row gaining vectors between
 * the read and the write is simply overwritten with the same values.
 */
export async function backfillMissingEmbeddings(
  client: PostgresQueryable,
  options: { batchSize?: number; embedder?: Embedder; signal?: AbortSignal } = {},
): Promise<{ observations: number; parts: number }> {
  if (!(await vectorSearchOn(client))) return { observations: 0, parts: 0 };
  const embedder = options.embedder ?? getSharedEmbedder();
  // Wait for the model before taking the lock, so a slow first download holds
  // nothing, and so rows written while it loaded are still ahead of the scan.
  // A stop (the server shutting down) ends the wait.
  if (!(await embedderReadyWithin(embedder, Infinity, options.signal))) {
    if (!options.signal?.aborted) {
      logger.warn('SYSTEM', 'embedding model did not load; the backfill resumes at the next start');
    }
    return { observations: 0, parts: 0 };
  }
  // One process backfills at a time: generation workers can run as several
  // processes, and each would otherwise embed the same missing rows. The lock
  // is a session-level advisory lock, so it needs one connection for the
  // whole backfill, which can run for hours. From a pool, that connection is
  // a client of its own, opened with the pool's settings and outside it, so
  // the backfill never takes a pool connection from requests for longer than
  // one read or write; a process that finds the lock taken leaves the work to
  // the one holding it.
  let lockClient: PostgresQueryable = client;
  let closeLockClient: (() => Promise<void>) | null = null;
  if (isPool(client)) {
    const dedicated = new pg.Client(client.options);
    dedicated.on('error', (error: Error) => {
      logger.warn('SYSTEM', 'embedding backfill lock connection failed', { error: error.message });
    });
    await dedicated.connect();
    lockClient = dedicated;
    closeLockClient = () => dedicated.end();
  }
  try {
    const lock = await lockClient.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(${BACKFILL_LOCK_KEY}) AS locked`);
    if (lock.rows[0]?.locked !== true) {
      logger.info('SYSTEM', 'another process is backfilling embeddings; this one leaves it to that one');
      return { observations: 0, parts: 0 };
    }
    try {
      // Reads and writes go through the pool (or the caller's own client).
      return await embedMissingObservations(client, { ...options, embedder });
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(${BACKFILL_LOCK_KEY})`);
    }
  } finally {
    await closeLockClient?.();
  }
}

/** A pg.Pool, as opposed to a single client or a client checked out of a pool. */
function isPool(client: PostgresQueryable): client is PostgresQueryable & { options: pg.ClientConfig } {
  const candidate = client as { connect?: unknown; release?: unknown; options?: unknown };
  return typeof candidate.connect === 'function'
    && typeof candidate.release !== 'function'
    && typeof candidate.options === 'object';
}

const BACKFILL_LOCK_KEY = `hashtext('claude-mem observation embedding backfill')`;

async function embedMissingObservations(
  client: PostgresQueryable,
  options: { batchSize?: number; embedder?: Embedder; signal?: AbortSignal },
): Promise<{ observations: number; parts: number }> {
  const embedder = options.embedder ?? getSharedEmbedder();
  const batchSize = options.batchSize ?? 64;
  const totals = { observations: 0, parts: 0 };

  const repo = new PostgresObservationEmbeddingsRepository(client);
  let after: { createdAt: string; id: string } | null = null;
  // A stop (the server shutting down) ends the backfill between batches, so
  // its connection is released before the pool closes; the next start resumes.
  while (!options.signal?.aborted) {
    const rows = await repo.listMissing({ model: embedder.modelId, limit: batchSize, after });
    if (rows.length === 0) break;
    const last = rows[rows.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };

    let embedded: Array<EmbeddedParts | null> | null = await embedObservationRows(client, rows, embedder, { waitForModelMs: Infinity });
    if (!embedded) {
      // Retry a failed batch a row at a time, so a row the model cannot embed
      // is skipped instead of stopping every row after it at each start. If
      // every row fails, the fault is not the rows'; stop until the next start.
      embedded = [];
      for (const row of rows) embedded.push((await embedObservationRows(client, [row], embedder, { waitForModelMs: Infinity }))?.[0] ?? null);
      if (embedded.every(parts => parts === null)) break;
    }
    if (options.signal?.aborted) break;
    for (let i = 0; i < rows.length; i++) {
      const parts = embedded[i];
      if (!parts) continue;
      await repo.upsert({ observationId: rows[i]!.id, ...parts });
      totals.observations++;
      totals.parts += parts.parts.length;
    }
  }
  if (totals.observations > 0) {
    logger.info('SYSTEM', 'embedded observations that had no vectors', totals);
  }
  return totals;
}
