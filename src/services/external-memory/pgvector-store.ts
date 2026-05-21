// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'crypto';
import type { PostgresQueryable } from '../../storage/postgres/utils.js';
import type { PaginatedResult, Observation, Summary } from '../worker-types.js';
import type { ObservationSearchResult, SessionSummarySearchResult } from '../sqlite/types.js';
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

interface ExternalMemoryDetailRow {
  id: number | string;
  memory_session_id: string;
  project: string;
  kind: 'observation' | 'summary';
  type: string | null;
  title: string | null;
  subtitle: string | null;
  content: string;
  facts: unknown;
  narrative: string | null;
  concepts: unknown;
  files_read: unknown;
  files_modified: unknown;
  prompt_number: number | null;
  discovery_tokens: number | string | null;
  metadata: unknown;
  created_at: string | Date | null;
  created_at_epoch: number | string;
}

export interface ExternalObservationQueryOptions {
  orderBy?: 'date_desc' | 'date_asc' | 'relevance';
  limit?: number;
  offset?: number;
  project?: string;
  platformSource?: string;
  type?: string | string[];
  concepts?: string | string[];
  files?: string | string[];
  dateRange?: { start?: string | number; end?: string | number };
}

export interface ExternalTimelineData {
  observations: ObservationSearchResult[];
  sessions: SessionSummarySearchResult[];
  prompts: [];
}

export interface ExternalMemoryStats {
  observations: number;
  summaries: number;
  firstObservationAt: string | null;
}

export interface ExternalMemoryProjectCatalog {
  projects: string[];
  sources: string[];
  projectsBySource: Record<string, string[]>;
}

export class PgvectorMemoryStore {
  constructor(private readonly client: PostgresQueryable) {}

  async upsertObservation(input: ExternalObservationInput): Promise<ExternalMemoryWriteResult> {
    const content = formatObservationContent(input);
    const contentHash = computeExternalObservationContentHash(input.memorySessionId, input.title, input.narrative);
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
      sqliteId: input.sqliteId ?? null,
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
      sqliteId: input.sqliteId ?? null,
      contentHash,
      metadata: {
        request: input.request,
        investigated: input.investigated,
        learned: input.learned,
        completed: input.completed,
        next_steps: input.nextSteps,
        notes: input.notes,
        ...(input.metadata ?? {}),
      },
      createdAtEpoch: input.createdAtEpoch,
      embedding: input.embedding ?? null,
    });
    return { id: row.id, createdAtEpoch: row.created_at_epoch };
  }

  async getObservationById(id: number): Promise<ObservationSearchResult | null> {
    const rows = await this.getObservationsByIds([id], { orderBy: 'relevance' });
    return rows[0] ?? null;
  }

  async getObservationsByIds(ids: number[], options: ExternalObservationQueryOptions = {}): Promise<ObservationSearchResult[]> {
    if (ids.length === 0) return [];

    const params: unknown[] = [ids];
    const conditions = [`kind = 'observation'`, `id = ANY($1::bigint[])`];
    appendObservationFilters(conditions, params, options);

    const orderClause = options.orderBy === 'relevance'
      ? ''
      : `ORDER BY created_at_epoch ${options.orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = options.limit ? `LIMIT $${pushParam(params, options.limit)}` : '';

    const result = await this.client.query<ExternalMemoryDetailRow>(
      `
        ${selectDetailColumns()}
        FROM claude_mem_external_memory_items
        WHERE ${conditions.join(' AND ')}
        ${orderClause}
        ${limitClause}
      `,
      params
    );

    const rows = result.rows.map(mapObservationRow);
    if (options.orderBy !== 'relevance') return rows;

    const rowMap = new Map(rows.map(row => [row.id, row]));
    return ids.map(id => rowMap.get(id)).filter((row): row is ObservationSearchResult => !!row);
  }

  async getSessionSummariesByIds(
    ids: number[],
    options: { orderBy?: 'date_desc' | 'date_asc' | 'relevance'; limit?: number; project?: string } = {}
  ): Promise<SessionSummarySearchResult[]> {
    if (ids.length === 0) return [];

    const params: unknown[] = [ids];
    const conditions = [`kind = 'summary'`, `id = ANY($1::bigint[])`];
    if (options.project) {
      conditions.push(`project = $${pushParam(params, options.project)}`);
    }

    const orderClause = options.orderBy === 'relevance'
      ? ''
      : `ORDER BY created_at_epoch ${options.orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    const limitClause = options.limit ? `LIMIT $${pushParam(params, options.limit)}` : '';

    const result = await this.client.query<ExternalMemoryDetailRow>(
      `
        ${selectDetailColumns()}
        FROM claude_mem_external_memory_items
        WHERE ${conditions.join(' AND ')}
        ${orderClause}
        ${limitClause}
      `,
      params
    );

    const rows = result.rows.map(mapSummaryRow);
    if (options.orderBy !== 'relevance') return rows;

    const rowMap = new Map(rows.map(row => [row.id, row]));
    return ids.map(id => rowMap.get(id)).filter((row): row is SessionSummarySearchResult => !!row);
  }

  async listObservations(options: ExternalObservationQueryOptions = {}): Promise<PaginatedResult<Observation>> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    if (options.platformSource && options.platformSource !== 'claude') {
      return { items: [], hasMore: false, offset, limit };
    }

    const params: unknown[] = [];
    const conditions = [`kind = 'observation'`];
    appendObservationFilters(conditions, params, options);
    const limitParam = pushParam(params, limit + 1);
    const offsetParam = pushParam(params, offset);

    const result = await this.client.query<ExternalMemoryDetailRow>(
      `
        ${selectDetailColumns()}
        FROM claude_mem_external_memory_items
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at_epoch DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `,
      params
    );

    const rows = result.rows.map(row => {
      const observation = mapObservationRow(row);
      return {
        ...observation,
        title: observation.title ?? '',
        prompt_number: observation.prompt_number ?? 0,
        merged_into_project: null,
        platform_source: 'claude',
      } satisfies Observation;
    });

    return { items: rows.slice(0, limit), hasMore: rows.length > limit, offset, limit };
  }

  async searchObservations(
    query: string | undefined,
    options: ExternalObservationQueryOptions = {}
  ): Promise<ObservationSearchResult[]> {
    const limit = Math.max(1, Number(options.limit ?? 20));
    const offset = Math.max(0, Number(options.offset ?? 0));
    if (options.platformSource && options.platformSource !== 'claude') {
      return [];
    }

    const params: unknown[] = [];
    const conditions = [`kind = 'observation'`];
    appendObservationFilters(conditions, params, options);
    appendDateRangeFilter(conditions, params, options.dateRange);

    const normalizedQuery = query?.trim();
    let orderClause = `ORDER BY created_at_epoch ${options.orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    if (normalizedQuery) {
      const queryParam = pushParam(params, normalizedQuery);
      conditions.push(`content_search @@ websearch_to_tsquery('english', $${queryParam})`);
      orderClause = `ORDER BY ts_rank(content_search, websearch_to_tsquery('english', $${queryParam})) DESC, created_at_epoch DESC`;
    }

    const limitParam = pushParam(params, limit);
    const offsetParam = pushParam(params, offset);
    const result = await this.client.query<ExternalMemoryDetailRow>(
      `
        ${selectDetailColumns()}
        FROM claude_mem_external_memory_items
        WHERE ${conditions.join(' AND ')}
        ${orderClause}
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `,
      params
    );

    return result.rows.map(mapObservationRow);
  }

  async searchSummaries(
    query: string | undefined,
    options: {
      orderBy?: 'date_desc' | 'date_asc' | 'relevance';
      limit?: number;
      offset?: number;
      project?: string;
      platformSource?: string;
      dateRange?: { start?: string | number; end?: string | number };
    } = {}
  ): Promise<SessionSummarySearchResult[]> {
    const limit = Math.max(1, Number(options.limit ?? 20));
    const offset = Math.max(0, Number(options.offset ?? 0));
    if (options.platformSource && options.platformSource !== 'claude') {
      return [];
    }

    const params: unknown[] = [];
    const conditions = [`kind = 'summary'`];
    if (options.project) {
      conditions.push(`project = $${pushParam(params, options.project)}`);
    }
    appendDateRangeFilter(conditions, params, options.dateRange);

    const normalizedQuery = query?.trim();
    let orderClause = `ORDER BY created_at_epoch ${options.orderBy === 'date_asc' ? 'ASC' : 'DESC'}`;
    if (normalizedQuery) {
      const queryParam = pushParam(params, normalizedQuery);
      conditions.push(`content_search @@ websearch_to_tsquery('english', $${queryParam})`);
      orderClause = `ORDER BY ts_rank(content_search, websearch_to_tsquery('english', $${queryParam})) DESC, created_at_epoch DESC`;
    }

    const limitParam = pushParam(params, limit);
    const offsetParam = pushParam(params, offset);
    const result = await this.client.query<ExternalMemoryDetailRow>(
      `
        ${selectDetailColumns()}
        FROM claude_mem_external_memory_items
        WHERE ${conditions.join(' AND ')}
        ${orderClause}
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `,
      params
    );

    return result.rows.map(mapSummaryRow);
  }

  async getTimelineAroundObservation(
    _anchorId: number,
    anchorEpoch: number,
    depthBefore: number,
    depthAfter: number,
    project?: string
  ): Promise<ExternalTimelineData> {
    return this.getTimelineAroundTimestamp(anchorEpoch, depthBefore, depthAfter, project);
  }

  async getTimelineAroundTimestamp(
    anchorEpoch: number,
    depthBefore: number,
    depthAfter: number,
    project?: string
  ): Promise<ExternalTimelineData> {
    const params: unknown[] = [anchorEpoch];
    const projectFilter = project ? `AND project = $${pushParam(params, project)}` : '';
    const beforeLimit = pushParam(params, Math.max(0, Number(depthBefore) || 0));
    const afterLimit = pushParam(params, Math.max(0, (Number(depthAfter) || 0) + 1));

    const result = await this.client.query<ExternalMemoryDetailRow>(
      `
        WITH before_items AS (
          ${selectDetailColumns()}
          FROM claude_mem_external_memory_items
          WHERE kind IN ('observation', 'summary')
            AND created_at_epoch < $1
            ${projectFilter}
          ORDER BY created_at_epoch DESC
          LIMIT $${beforeLimit}
        ),
        after_items AS (
          ${selectDetailColumns()}
          FROM claude_mem_external_memory_items
          WHERE kind IN ('observation', 'summary')
            AND created_at_epoch >= $1
            ${projectFilter}
          ORDER BY created_at_epoch ASC
          LIMIT $${afterLimit}
        )
        SELECT * FROM before_items
        UNION ALL
        SELECT * FROM after_items
        ORDER BY created_at_epoch ASC
      `,
      params
    );

    return {
      observations: result.rows.filter(row => row.kind === 'observation').map(mapObservationRow),
      sessions: result.rows.filter(row => row.kind === 'summary').map(mapSummaryRow),
      prompts: [],
    };
  }

  async getStats(): Promise<ExternalMemoryStats> {
    const result = await this.client.query<{
      observations: number | string;
      summaries: number | string;
      first_observation_at: string | Date | null;
    }>(
      `
        SELECT
          COUNT(*) FILTER (WHERE kind = 'observation') AS observations,
          COUNT(*) FILTER (WHERE kind = 'summary') AS summaries,
          MIN(created_at) FILTER (WHERE kind = 'observation') AS first_observation_at
        FROM claude_mem_external_memory_items
      `
    );

    const row = result.rows[0];
    return {
      observations: Number(row?.observations ?? 0),
      summaries: Number(row?.summaries ?? 0),
      firstObservationAt: formatNullableTimestamp(row?.first_observation_at ?? null),
    };
  }

  async getAllProjects(platformSource?: string): Promise<string[]> {
    if (platformSource && platformSource !== 'claude') {
      return [];
    }

    const result = await this.client.query<{ project: string }>(
      `
        SELECT DISTINCT project
        FROM claude_mem_external_memory_items
        WHERE project IS NOT NULL AND project != ''
        ORDER BY project ASC
      `
    );
    return result.rows.map(row => row.project);
  }

  async getProjectCatalog(): Promise<ExternalMemoryProjectCatalog> {
    const result = await this.client.query<{ project: string; latest_epoch: number | string }>(
      `
        SELECT project, MAX(created_at_epoch) AS latest_epoch
        FROM claude_mem_external_memory_items
        WHERE project IS NOT NULL AND project != ''
        GROUP BY project
        ORDER BY latest_epoch DESC
      `
    );

    const projects = result.rows.map(row => row.project);
    return {
      projects,
      sources: projects.length > 0 ? ['claude'] : [],
      projectsBySource: projects.length > 0 ? { claude: projects } : {},
    };
  }

  async listSummaries(options: { offset?: number; limit?: number; project?: string; platformSource?: string } = {}): Promise<PaginatedResult<Summary>> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    if (options.platformSource && options.platformSource !== 'claude') {
      return { items: [], hasMore: false, offset, limit };
    }

    const params: unknown[] = [];
    const conditions = [`kind = 'summary'`];
    if (options.project) {
      conditions.push(`project = $${pushParam(params, options.project)}`);
    }
    const limitParam = pushParam(params, limit + 1);
    const offsetParam = pushParam(params, offset);

    const result = await this.client.query<ExternalMemoryDetailRow>(
      `
        ${selectDetailColumns()}
        FROM claude_mem_external_memory_items
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at_epoch DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}
      `,
      params
    );

    const rows = result.rows.map(row => {
      const summary = mapSummaryRow(row);
      return {
        id: summary.id,
        session_id: summary.memory_session_id,
        project: summary.project,
        platform_source: 'claude',
        request: summary.request,
        investigated: summary.investigated,
        learned: summary.learned,
        completed: summary.completed,
        next_steps: summary.next_steps,
        notes: summary.notes,
        created_at: summary.created_at,
        created_at_epoch: summary.created_at_epoch,
      } satisfies Summary;
    });

    return { items: rows.slice(0, limit), hasMore: rows.length > limit, offset, limit };
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
    sqliteId: number | null;
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
          metadata = EXCLUDED.metadata,
          embedding = COALESCE(EXCLUDED.embedding, claude_mem_external_memory_items.embedding)
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

function selectDetailColumns(): string {
  return `
        SELECT id, memory_session_id, project, kind, type, title, subtitle, content,
               facts, narrative, concepts, files_read, files_modified, prompt_number,
               discovery_tokens, metadata, created_at, created_at_epoch
  `;
}

function appendObservationFilters(
  conditions: string[],
  params: unknown[],
  options: ExternalObservationQueryOptions
): void {
  if (options.project) {
    conditions.push(`project = $${pushParam(params, options.project)}`);
  }

  if (options.type) {
    const values = Array.isArray(options.type) ? options.type : [options.type];
    conditions.push(`type = ANY($${pushParam(params, values)}::text[])`);
  }

  if (options.concepts) {
    const values = Array.isArray(options.concepts) ? options.concepts : [options.concepts];
    conditions.push(`concepts ?| $${pushParam(params, values)}::text[]`);
  }

  if (options.files) {
    const values = Array.isArray(options.files) ? options.files : [options.files];
    const clauses = values.map(value => {
      const param = pushParam(params, `%${value}%`);
      return `(EXISTS (SELECT 1 FROM jsonb_array_elements_text(files_read) AS f(value) WHERE f.value LIKE $${param}) OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(files_modified) AS f(value) WHERE f.value LIKE $${param}))`;
    });
    conditions.push(`(${clauses.join(' OR ')})`);
  }
}

function appendDateRangeFilter(
  conditions: string[],
  params: unknown[],
  dateRange: { start?: string | number; end?: string | number } | undefined
): void {
  if (!dateRange) {
    return;
  }
  const startEpoch = parseDateEpoch(dateRange.start);
  const endEpoch = parseDateEpoch(dateRange.end);
  if (startEpoch !== null) {
    conditions.push(`created_at_epoch >= $${pushParam(params, startEpoch)}`);
  }
  if (endEpoch !== null) {
    conditions.push(`created_at_epoch <= $${pushParam(params, endEpoch)}`);
  }
}

function parseDateEpoch(value: string | number | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pushParam(params: unknown[], value: unknown): number {
  params.push(value);
  return params.length;
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

function computeExternalObservationContentHash(
  memorySessionId: string,
  title: string | null,
  narrative: string | null
): string {
  return createHash('sha256')
    .update([memorySessionId || '', title || '', narrative || ''].join('\x00'))
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

function mapObservationRow(row: ExternalMemoryDetailRow): ObservationSearchResult {
  return {
    id: Number(row.id),
    memory_session_id: row.memory_session_id,
    project: row.project,
    text: row.content,
    type: (row.type || 'discovery') as ObservationSearchResult['type'],
    title: row.title,
    subtitle: row.subtitle,
    facts: stringifyJson(row.facts),
    narrative: row.narrative,
    concepts: stringifyJson(row.concepts),
    files_read: stringifyJson(row.files_read),
    files_modified: stringifyJson(row.files_modified),
    prompt_number: row.prompt_number,
    discovery_tokens: Number(row.discovery_tokens ?? 0),
    created_at: formatCreatedAt(row),
    created_at_epoch: Number(row.created_at_epoch),
    metadata: stringifyJson(row.metadata),
  } as ObservationSearchResult;
}

function mapSummaryRow(row: ExternalMemoryDetailRow): SessionSummarySearchResult {
  const metadata = parseRecord(row.metadata);
  return {
    id: Number(row.id),
    memory_session_id: row.memory_session_id,
    project: row.project,
    request: readString(metadata.request, row.title),
    investigated: readString(metadata.investigated, null),
    learned: readString(metadata.learned, row.narrative),
    completed: readString(metadata.completed, null),
    next_steps: readString(metadata.next_steps, null),
    files_read: null,
    files_edited: null,
    notes: readString(metadata.notes, null),
    prompt_number: row.prompt_number,
    discovery_tokens: Number(row.discovery_tokens ?? 0),
    created_at: formatCreatedAt(row),
    created_at_epoch: Number(row.created_at_epoch),
  };
}

function stringifyJson(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value ?? []);
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function readString(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' ? value : fallback;
}

function formatCreatedAt(row: ExternalMemoryDetailRow): string {
  if (row.created_at instanceof Date) {
    return row.created_at.toISOString();
  }
  if (typeof row.created_at === 'string') {
    return row.created_at;
  }
  return new Date(Number(row.created_at_epoch)).toISOString();
}

function formatNullableTimestamp(value: string | Date | null): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}
