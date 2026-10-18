// SPDX-License-Identifier: Apache-2.0

// Embeddings for search by meaning. Everything here degrades to "no vectors":
// a database without pgvector, a model that fails to load, or an embed error
// leaves search keyword-only and observation writes untouched. Rows written
// without vectors are picked up by backfillMissingEmbeddings, which the
// generation worker runs at startup.

import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import {
  PostgresObservationEmbeddingsRepository,
  observationEmbeddingParts,
  vectorSearchAvailable,
  type ObservationEmbeddingPart,
} from '../../storage/postgres/observation-embeddings.js';
import { LocalEmbedder } from '../../services/vector/LocalEmbedder.js';
import type { Embedder } from '../../services/vector/types.js';
import { logger } from '../../utils/logger.js';

let sharedEmbedder: Embedder | null = null;

export function getSharedEmbedder(): Embedder {
  sharedEmbedder ??= new LocalEmbedder();
  return sharedEmbedder;
}

/** The query's vector, or null when search should stay keyword-only. */
export async function embedSearchQuery(
  client: PostgresQueryable,
  query: string | null | undefined,
  embedder: Embedder = getSharedEmbedder(),
): Promise<Float32Array | null> {
  if (!query || query.trim().length === 0) return null;
  try {
    if (!(await vectorSearchAvailable(client))) return null;
    const [vector] = await embedder.embed([query]);
    return vector ?? null;
  } catch (error) {
    logger.warn('SYSTEM', 'query embedding failed; searching by keyword only', {
      error: error instanceof Error ? error.message : String(error),
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
    if (!(await vectorSearchAvailable(client))) return null;
    const partsPerRow = rows.map(row => observationEmbeddingParts(row.kind, row.metadata, row.content));
    const vectors = await embedder.embed(partsPerRow.flat().map(p => p.text));
    let offset = 0;
    return partsPerRow.map(parts => {
      const slice = vectors.slice(offset, offset + parts.length);
      offset += parts.length;
      return { parts, vectors: slice };
    });
  } catch (error) {
    logger.warn('SYSTEM', 'observation embedding failed; rows are written without vectors', {
      error: error instanceof Error ? error.message : String(error),
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
  if (!(await vectorSearchAvailable(client))) return totals;

  const repo = new PostgresObservationEmbeddingsRepository(client);
  let after: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const rows = await repo.listMissing({ limit: batchSize, after });
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
