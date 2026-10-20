// SPDX-License-Identifier: Apache-2.0

// Embeddings for search by meaning. Everything here degrades to "no vectors":
// CLAUDE_MEM_SERVER_VECTOR_SEARCH off, a database without pgvector, a model
// that fails to load, or an embed error leaves search keyword-only and
// observation writes untouched. Rows written
// without vectors are picked up by backfillMissingEmbeddings, which the
// generation worker runs at startup.

import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import type { VectorSchemaMode } from '../../storage/postgres/schema.js';
import {
  PostgresObservationEmbeddingsRepository,
  observationEmbeddingParts,
  vectorSearchAvailable,
  type ObservationEmbeddingPart,
} from '../../storage/postgres/observation-embeddings.js';
import { LocalEmbedder } from '../../services/vector/LocalEmbedder.js';
import type { Embedder } from '../../services/vector/types.js';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

let sharedEmbedder: Embedder | null = null;
// The most recent embed failure, cleared by the next success, so /v1/info can
// say why search is keyword-only instead of leaving it to the log.
let lastEmbedError: { message: string; at: string } | null = null;

export function getSharedEmbedder(): Embedder {
  sharedEmbedder ??= new LocalEmbedder();
  return sharedEmbedder;
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

export async function getVectorSearchStatus(
  client: PostgresQueryable,
  embedder: Embedder = getSharedEmbedder(),
): Promise<VectorSearchStatus> {
  const available = await vectorSearchOn(client);
  return {
    available,
    model: embedder.modelId,
    observationsWithoutVectors: available
      ? await new PostgresObservationEmbeddingsRepository(client).countMissing(embedder.modelId)
      : null,
    lastEmbedError,
  };
}

/** The query's vector, or null when search should stay keyword-only. */
export async function embedSearchQuery(
  client: PostgresQueryable,
  query: string | null | undefined,
  embedder: Embedder = getSharedEmbedder(),
): Promise<Float32Array | null> {
  if (!query || query.trim().length === 0) return null;
  try {
    if (!(await vectorSearchOn(client))) return null;
    const [vector] = await embedder.embed([query]);
    lastEmbedError = null;
    return vector ?? null;
  } catch (error) {
    logger.warn('SYSTEM', 'query embedding failed; searching by keyword only', {
      error: recordEmbedError(error),
    });
    return null;
  }
}

export interface EmbeddedParts {
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
): Promise<EmbeddedParts[] | null> {
  if (rows.length === 0) return [];
  try {
    if (!(await vectorSearchOn(client))) return null;
    const partsPerRow = rows.map(row => observationEmbeddingParts(row.kind, row.metadata, row.content));
    const vectors = await embedder.embed(partsPerRow.flat().map(p => p.text));
    lastEmbedError = null;
    let offset = 0;
    return partsPerRow.map(parts => {
      const slice = vectors.slice(offset, offset + parts.length);
      offset += parts.length;
      return { parts, vectors: slice };
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
  options: { batchSize?: number; embedder?: Embedder } = {},
): Promise<{ observations: number; parts: number }> {
  const embedder = options.embedder ?? getSharedEmbedder();
  const batchSize = options.batchSize ?? 64;
  const totals = { observations: 0, parts: 0 };
  if (!(await vectorSearchOn(client))) return totals;

  const repo = new PostgresObservationEmbeddingsRepository(client);
  let after: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const rows = await repo.listMissing({ model: embedder.modelId, limit: batchSize, after });
    if (rows.length === 0) break;
    const last = rows[rows.length - 1]!;
    after = { createdAt: last.createdAt, id: last.id };

    const embedded = await embedObservationRows(client, rows, embedder);
    if (!embedded) break;
    for (let i = 0; i < rows.length; i++) {
      const { parts, vectors } = embedded[i]!;
      await repo.upsert({ observationId: rows[i]!.id, model: embedder.modelId, parts, vectors });
      totals.observations++;
      totals.parts += parts.length;
    }
  }
  if (totals.observations > 0) {
    logger.info('SYSTEM', 'embedded observations that had no vectors', totals);
  }
  return totals;
}
