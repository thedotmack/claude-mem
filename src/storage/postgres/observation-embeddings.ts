// SPDX-License-Identifier: Apache-2.0

import type { JsonObject, PostgresQueryable } from './utils.js';
import { toJsonObject } from './utils.js';

export interface ObservationEmbeddingPart {
  part: string;
  text: string;
}

const SUMMARY_FIELDS = ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'] as const;

/**
 * The texts embedded for one observation row, one vector each.
 *
 * Mirrors ChromaSync.formatObservationDocs / formatSummaryDocs, so the part
 * names equal the Chroma document id suffixes and vectors carried over from a
 * Chroma collection line up: narrative, text (legacy rows only), fact_<n>, and
 * title when none of those exist; for summaries one part per summary field.
 * A row with none of these (a manual /v1/memories write) embeds its content.
 */
export function observationEmbeddingParts(
  kind: string,
  metadata: JsonObject,
  content: string,
): ObservationEmbeddingPart[] {
  const parts: ObservationEmbeddingPart[] = [];
  const add = (part: string, value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) parts.push({ part, text: value });
  };

  if (kind === 'summary') {
    for (const field of SUMMARY_FIELDS) add(field, metadata[field]);
  } else {
    add('narrative', metadata.narrative);
    add('text', toJsonObject(metadata.legacy).text);
    const facts = Array.isArray(metadata.facts) ? metadata.facts : [];
    facts.forEach((fact, index) => add(`fact_${index}`, fact));
    if (parts.length === 0) {
      const title = typeof metadata.title === 'string' && metadata.title.trim() !== 'Untitled'
        ? metadata.title.trim()
        : '';
      const subtitle = typeof metadata.subtitle === 'string' ? metadata.subtitle.trim() : '';
      add('title', [title, subtitle].filter(text => text.length > 0).join('\n'));
    }
  }
  if (parts.length === 0) add('content', content);
  return parts;
}

/** pgvector's text input form. */
export function toVectorLiteral(vector: ArrayLike<number>): string {
  return `[${Array.from(vector).join(',')}]`;
}

const availability = new WeakMap<object, Promise<boolean>>();

/**
 * Whether this database holds the embeddings table, i.e. pgvector was
 * installable when the schema was bootstrapped. Probed once per client.
 */
export function vectorSearchAvailable(client: PostgresQueryable): Promise<boolean> {
  let probe = availability.get(client);
  if (!probe) {
    probe = client
      .query<{ present: boolean }>(`SELECT to_regclass('observation_embeddings') IS NOT NULL AS present`)
      .then(result => result.rows[0]?.present === true);
    probe.catch(() => availability.delete(client));
    availability.set(client, probe);
  }
  return probe;
}

export class PostgresObservationEmbeddingsRepository {
  constructor(private client: PostgresQueryable) {}

  async upsert(input: {
    observationId: string;
    model: string;
    parts: ObservationEmbeddingPart[];
    vectors: ArrayLike<number>[];
  }): Promise<void> {
    if (input.parts.length === 0) return;
    await this.client.query(
      `
        INSERT INTO observation_embeddings (observation_id, project_id, team_id, part, model, embedding)
        SELECT o.id, o.project_id, o.team_id, t.part, $2, t.embedding::vector
        FROM observations o, unnest($3::text[], $4::text[]) AS t(part, embedding)
        WHERE o.id = $1
        ON CONFLICT (observation_id, part) DO UPDATE SET
          model = excluded.model,
          embedding = excluded.embedding,
          created_at = now()
      `,
      [
        input.observationId,
        input.model,
        input.parts.map(p => p.part),
        input.vectors.map(toVectorLiteral),
      ]
    );
  }

  /**
   * Observations with no embedding at all, in (created_at, id) order after the
   * given cursor, so a row that yields no vector cannot stall a caller paging
   * through the gap.
   */
  async listMissing(input: {
    limit: number;
    after?: { createdAt: Date; id: string } | null;
  }): Promise<MissingEmbeddingRow[]> {
    const result = await this.client.query<{ id: string; kind: string; content: string; metadata: unknown; created_at: Date }>(
      `
        SELECT o.id, o.kind, o.content, o.metadata, o.created_at
        FROM observations o
        WHERE NOT EXISTS (SELECT 1 FROM observation_embeddings e WHERE e.observation_id = o.id)
          AND ($2::timestamptz IS NULL OR (o.created_at, o.id) > ($2::timestamptz, $3::text))
        ORDER BY o.created_at, o.id
        LIMIT $1
      `,
      [input.limit, input.after?.createdAt ?? null, input.after?.id ?? null]
    );
    return result.rows.map(row => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      metadata: toJsonObject(row.metadata),
      createdAt: row.created_at,
    }));
  }
}

export interface MissingEmbeddingRow {
  id: string;
  kind: string;
  content: string;
  metadata: JsonObject;
  createdAt: Date;
}
