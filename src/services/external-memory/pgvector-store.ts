// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import { computeObservationContentHash } from '../sqlite/observations/store.js';
import type {
  ExternalMemorySearchResult,
  ExternalMemoryWriteResult,
  ExternalObservationInput,
  ExternalSummaryInput,
} from './types.js';

interface ExternalMemoryRow {
  id: number;
  content: string;
  created_at_epoch: number;
}

export class PgvectorMemoryStore {
  constructor(private readonly client: PostgresQueryable) {}

  async upsertObservation(input: ExternalObservationInput): Promise<ExternalMemoryWriteResult> {
    const content = formatObservationContent(input);
    const contentHash = computeObservationContentHash(input.memorySessionId, input.title, input.narrative);
    const row = await this.upsertItem({
      memorySessionId: input.memorySessionId,
      project: input.project,
      kind: 'observation',
      type: input.type,
      title: input.title,
      subtitle: input.subtitle,
      content,
      facts: input.facts,
      narrative: input.narrative,
      concepts: input.concepts,
      filesRead: input.filesRead,
      filesModified: input.filesModified,
      promptNumber: input.promptNumber ?? null,
      discoveryTokens: input.discoveryTokens ?? 0,
      sqliteId: input.sqliteId,
      contentHash,
      metadata: input.metadata ?? {},
      createdAtEpoch: input.createdAtEpoch,
      embedding: input.embedding ?? null,
    });
    return { id: row.id, createdAtEpoch: row.created_at_epoch };
  }

  async upsertSummary(input: ExternalSummaryInput): Promise<ExternalMemoryWriteResult> {
    const content = formatSummaryContent(input);
    const contentHash = computeSummaryContentHash(input);
    const row = await this.upsertItem({
      memorySessionId: input.memorySessionId,
      project: input.project,
      kind: 'summary',
      type: 'session_summary',
      title: input.request || 'Session summary',
      subtitle: null,
      content,
      facts: [],
      narrative: input.learned || input.completed || null,
      concepts: [],
      filesRead: [],
      filesModified: [],
      promptNumber: input.promptNumber ?? null,
      discoveryTokens: input.discoveryTokens ?? 0,
      sqliteId: input.sqliteId,
      contentHash,
      metadata: input.metadata ?? {},
      createdAtEpoch: input.createdAtEpoch,
      embedding: input.embedding ?? null,
    });
    return { id: row.id, createdAtEpoch: row.created_at_epoch };
  }

  async searchByVector(input: {
    project: string;
    embedding: number[];
    limit?: number;
  }): Promise<ExternalMemorySearchResult[]> {
    const result = await this.client.query<ExternalMemoryRow>(
      `
        SELECT id, content, created_at_epoch
        FROM claude_mem_external_memory_items
        WHERE project = $1 AND embedding IS NOT NULL
        ORDER BY embedding <=> $2::vector ASC
        LIMIT $3
      `,
      [input.project, vectorLiteral(input.embedding), input.limit ?? 20]
    );
    return result.rows.map(mapSearchRow);
  }

  async searchByText(input: {
    project: string;
    query: string;
    limit?: number;
  }): Promise<ExternalMemorySearchResult[]> {
    const result = await this.client.query<ExternalMemoryRow>(
      `
        SELECT id, content, created_at_epoch
        FROM claude_mem_external_memory_items
        WHERE project = $1
          AND content_search @@ websearch_to_tsquery('english', $2)
        ORDER BY ts_rank(content_search, websearch_to_tsquery('english', $2)) DESC, created_at DESC
        LIMIT $3
      `,
      [input.project, input.query, input.limit ?? 20]
    );
    return result.rows.map(mapSearchRow);
  }

  private async upsertItem(input: {
    memorySessionId: string;
    project: string;
    kind: 'observation' | 'summary';
    type: string;
    title: string | null;
    subtitle: string | null;
    content: string;
    facts: string[];
    narrative: string | null;
    concepts: string[];
    filesRead: string[];
    filesModified: string[];
    promptNumber: number | null;
    discoveryTokens: number;
    sqliteId: number;
    contentHash: string;
    metadata: Record<string, unknown>;
    createdAtEpoch: number;
    embedding: number[] | null;
  }): Promise<{ id: number; created_at_epoch: number }> {
    const result = await this.client.query<{ id: number; created_at_epoch: number }>(
      `
        INSERT INTO claude_mem_external_memory_items (
          memory_session_id, project, kind, type, title, subtitle, content,
          facts, narrative, concepts, files_read, files_modified, prompt_number,
          discovery_tokens, source_sqlite_id, content_hash, metadata, created_at,
          created_at_epoch, embedding
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8::jsonb, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13,
          $14, $15, $16, $17::jsonb, to_timestamp($18::double precision / 1000.0),
          $18, $19::vector
        )
        ON CONFLICT (memory_session_id, kind, content_hash) DO UPDATE SET
          updated_at = now(),
          metadata = EXCLUDED.metadata
        RETURNING id, created_at_epoch
      `,
      [
        input.memorySessionId,
        input.project,
        input.kind,
        input.type,
        input.title,
        input.subtitle,
        input.content,
        JSON.stringify(input.facts),
        input.narrative,
        JSON.stringify(input.concepts),
        JSON.stringify(input.filesRead),
        JSON.stringify(input.filesModified),
        input.promptNumber,
        input.discoveryTokens,
        input.sqliteId,
        input.contentHash,
        JSON.stringify(input.metadata),
        input.createdAtEpoch,
        input.embedding ? vectorLiteral(input.embedding) : null,
      ]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('pgvector upsert did not return a row');
    }
    return row;
  }
}

function formatObservationContent(input: ExternalObservationInput): string {
  return [
    input.title,
    input.subtitle,
    input.narrative,
    ...input.facts,
  ].filter(Boolean).join('\n\n');
}

function formatSummaryContent(input: ExternalSummaryInput): string {
  return [
    input.request && `Request: ${input.request}`,
    input.investigated && `Investigated: ${input.investigated}`,
    input.learned && `Learned: ${input.learned}`,
    input.completed && `Completed: ${input.completed}`,
    input.nextSteps && `Next steps: ${input.nextSteps}`,
    input.notes && `Notes: ${input.notes}`,
  ].filter(Boolean).join('\n\n');
}

function computeSummaryContentHash(input: ExternalSummaryInput): string {
  return createHash('sha256')
    .update([
      input.memorySessionId,
      input.request,
      input.investigated,
      input.learned,
      input.completed,
      input.nextSteps,
      input.notes ?? '',
    ].join('\x00'))
    .digest('hex')
    .slice(0, 16);
}

function vectorLiteral(embedding: number[]): string {
  if (embedding.length === 0) {
    throw new Error('pgvector embedding must not be empty');
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new Error('pgvector embedding values must be finite numbers');
    }
  }
  return `[${embedding.join(',')}]`;
}

function mapSearchRow(row: ExternalMemoryRow): ExternalMemorySearchResult {
  return {
    id: Number(row.id),
    content: row.content,
    createdAtEpoch: Number(row.created_at_epoch),
  };
}
