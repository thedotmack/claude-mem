import { normalizePlatformSource } from '../../shared/platform-source.js'
import { logger } from '../../utils/logger.js'
import { createDeterministicEmbedding, cosineSimilarity } from '../../storage/helix/embeddings.js'
import type { HelixNode, HelixTransport } from '../../storage/helix/transport.js'
import { ensureHelixSchema } from '../../storage/helix/schema.js'
import { HelixManager } from './HelixManager.js'
import type { VectorSearchMetadata, VectorSearchResult, VectorSync } from './VectorSync.js'
import type { SessionStore } from '../sqlite/SessionStore.js'

export interface HelixDocument {
  id: string;
  document: string;
  metadata: Record<string, string | number>;
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function buildObservationDocument(observation: {
  type: string;
  title?: string | null;
  subtitle?: string | null;
  facts?: string[];
  narrative?: string | null;
  concepts?: string[];
}): string {
  return [
    observation.type,
    observation.title ?? '',
    observation.subtitle ?? '',
    observation.narrative ?? '',
    ...(observation.facts ?? []),
    ...(observation.concepts ?? [])
  ].join('\n')
}

function buildSummaryDocument(summary: {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string | null;
}): string {
  return [
    summary.request,
    summary.investigated,
    summary.learned,
    summary.completed,
    summary.next_steps,
    summary.notes ?? ''
  ].join('\n')
}

function matchesWhereFilter(metadata: VectorSearchMetadata, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true
  if ('$and' in filter) {
    const conditions = Array.isArray(filter.$and) ? filter.$and : []
    return conditions.every(condition => matchesWhereFilter(metadata, condition as Record<string, unknown>))
  }
  if ('$or' in filter) {
    const conditions = Array.isArray(filter.$or) ? filter.$or : []
    return conditions.some(condition => matchesWhereFilter(metadata, condition as Record<string, unknown>))
  }
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('$')) continue
    if ((metadata[key] ?? null) !== value) {
      return false
    }
  }
  return true
}

function mapNodeMetadata(node: HelixNode): VectorSearchMetadata {
  return {
    sqlite_id: Number(node.sqlite_id),
    doc_type: String(node.doc_type ?? 'observation') as VectorSearchMetadata['doc_type'],
    memory_session_id: String(node.memory_session_id ?? ''),
    project: String(node.project ?? ''),
    merged_into_project: typeof node.merged_into_project === 'string' ? node.merged_into_project : null,
    platform_source: typeof node.platform_source === 'string' ? node.platform_source : undefined,
    created_at_epoch: Number(node.created_at_epoch ?? 0)
  }
}

export class HelixSync implements VectorSync {
  private readonly manager: HelixManager | null
  private readonly transportOverride: HelixTransport | null

  constructor(_project: string, options: { manager?: HelixManager; transport?: HelixTransport } = {}) {
    this.manager = options.manager ?? new HelixManager()
    this.transportOverride = options.transport ?? null
  }

  private async transport(): Promise<HelixTransport> {
    if (this.transportOverride) {
      await ensureHelixSchema(this.transportOverride)
      return this.transportOverride
    }
    if (!this.manager) {
      throw new Error('Helix manager unavailable')
    }
    const transport = await this.manager.getTransport()
    await ensureHelixSchema(transport)
    return transport
  }

  private toNodeProperties(docKey: string, document: HelixDocument): HelixNode {
    return {
      doc_key: docKey,
      document_id: document.id,
      sqlite_id: Number(document.metadata.sqlite_id),
      doc_type: String(document.metadata.doc_type),
      project: String(document.metadata.project),
      merged_into_project: typeof document.metadata.merged_into_project === 'string'
        ? document.metadata.merged_into_project
        : null,
      platform_source: typeof document.metadata.platform_source === 'string'
        ? document.metadata.platform_source
        : null,
      created_at_epoch: Number(document.metadata.created_at_epoch ?? 0),
      document: document.document,
      embedding: createDeterministicEmbedding(document.document)
    }
  }

  private async upsertDocument(docKey: string, document: HelixDocument): Promise<void> {
    const transport = await this.transport()
    const rows = await transport.findNodes('SemanticDocument', { doc_key: docKey })
    const properties = this.toNodeProperties(docKey, document)
    if (rows.length > 0) {
      await transport.updateNodes('SemanticDocument', { doc_key: docKey }, properties)
    } else {
      await transport.insertNode('SemanticDocument', properties)
    }
  }

  // Sequential on purpose: Helix rejects concurrent write transactions with
  // "transaction conflict", so parallel upserts fail under any real load.
  async addDocuments(documents: HelixDocument[]): Promise<number> {
    for (const document of documents) {
      await this.upsertDocument(document.id, document)
    }
    return documents.length
  }

  async syncObservation(
    obsId: number,
    memorySessionId: string,
    project: string,
    observation: {
      type: string;
      title?: string | null;
      subtitle?: string | null;
      facts?: string[];
      narrative?: string | null;
      concepts?: string[];
    },
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string | null
  ): Promise<void> {
    await this.addDocuments([{
      id: `observation:${obsId}`,
      document: buildObservationDocument(observation),
      metadata: {
        sqlite_id: obsId,
        doc_type: 'observation',
        memory_session_id: memorySessionId,
        project,
        prompt_number: promptNumber,
        created_at_epoch: createdAtEpoch,
        platform_source: normalizePlatformSource(platformSource)
      }
    }])
  }

  async syncSummary(
    summaryId: number,
    memorySessionId: string,
    project: string,
    summary: {
      request: string;
      investigated: string;
      learned: string;
      completed: string;
      next_steps: string;
      notes: string | null;
    },
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string | null
  ): Promise<void> {
    await this.addDocuments([{
      id: `summary:${summaryId}`,
      document: buildSummaryDocument(summary),
      metadata: {
        sqlite_id: summaryId,
        doc_type: 'session_summary',
        memory_session_id: memorySessionId,
        project,
        prompt_number: promptNumber,
        created_at_epoch: createdAtEpoch,
        platform_source: normalizePlatformSource(platformSource)
      }
    }])
  }

  async syncUserPrompt(
    promptId: number,
    memorySessionId: string,
    project: string,
    promptText: string,
    promptNumber: number,
    createdAtEpoch: number,
    platformSource?: string | null
  ): Promise<void> {
    await this.addDocuments([{
      id: `prompt:${promptId}`,
      document: promptText,
      metadata: {
        sqlite_id: promptId,
        doc_type: 'user_prompt',
        memory_session_id: memorySessionId,
        project,
        prompt_number: promptNumber,
        created_at_epoch: createdAtEpoch,
        platform_source: normalizePlatformSource(platformSource)
      }
    }])
  }

  async queryHelix(
    query: string,
    limit: number,
    whereFilter?: Record<string, unknown>
  ): Promise<VectorSearchResult> {
    const transport = await this.transport()
    const rows = await transport.findNodes('SemanticDocument')
    const queryEmbedding = createDeterministicEmbedding(query)
    const ranked = rows
      .map(row => {
        const metadata = mapNodeMetadata(row)
        const embedding = Array.isArray(row.embedding) ? row.embedding.map(value => Number(value)) : []
        return {
          id: Number(row.sqlite_id),
          metadata,
          score: cosineSimilarity(embedding, queryEmbedding)
        }
      })
      .filter(result => matchesWhereFilter(result.metadata, whereFilter) && result.score > 0)
      .sort((left, right) => right.score - left.score || Number(right.metadata.created_at_epoch ?? 0) - Number(left.metadata.created_at_epoch ?? 0))
      .slice(0, limit)
    return {
      ids: ranked.map(result => result.id),
      distances: ranked.map(result => 1 - result.score),
      metadatas: ranked.map(result => result.metadata)
    }
  }

  async queryChroma(query: string, limit: number, whereFilter?: Record<string, unknown>): Promise<VectorSearchResult> {
    return await this.queryHelix(query, limit, whereFilter)
  }

  /**
   * Backfill every SQLite observation, session summary, and user prompt into
   * Helix. Idempotent: existing doc_keys are fetched once up front and
   * skipped, so a restart resumes where the last run stopped. Mirrors the
   * Chroma startup backfill's role without its watermark machinery — the
   * Helix store itself is the source of truth for what already landed.
   */
  async backfillAllProjects(store: SessionStore): Promise<void> {
    const transport = await this.transport()
    const existing = new Set(
      (await transport.findNodes('SemanticDocument')).map(row => String(row.doc_key))
    )
    logger.info('HELIX', 'Backfill starting', { existingDocs: existing.size })

    let synced = 0
    const flushBatch: HelixDocument[] = []
    // Direct sequential inserts: the pre-fetched `existing` set already proves
    // these doc_keys are absent, so the per-doc find in upsertDocument is
    // skipped, and Helix rejects concurrent write transactions anyway.
    const flush = async () => {
      if (flushBatch.length === 0) return
      for (const doc of flushBatch.splice(0, flushBatch.length)) {
        await transport.insertNode('SemanticDocument', this.toNodeProperties(doc.id, doc))
        synced += 1
      }
      logger.debug('HELIX', 'Backfill progress', { synced })
    }
    const enqueue = async (doc: HelixDocument) => {
      if (existing.has(doc.id)) return
      flushBatch.push(doc)
      if (flushBatch.length >= 100) await flush()
    }

    const observations = store.db.prepare(`
      SELECT
        o.*,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM observations o
      LEFT JOIN sdk_sessions s ON s.memory_session_id = o.memory_session_id
      ORDER BY o.id ASC
    `).all() as Array<Record<string, unknown>>
    for (const row of observations) {
      await enqueue({
        id: `observation:${row.id}`,
        document: buildObservationDocument({
          type: String(row.type ?? ''),
          title: row.title as string | null,
          subtitle: row.subtitle as string | null,
          facts: parseJsonArray(row.facts),
          narrative: row.narrative as string | null,
          concepts: parseJsonArray(row.concepts)
        }),
        metadata: {
          sqlite_id: Number(row.id),
          doc_type: 'observation',
          memory_session_id: String(row.memory_session_id ?? ''),
          project: String(row.project ?? ''),
          prompt_number: Number(row.prompt_number ?? 0),
          created_at_epoch: Number(row.created_at_epoch ?? 0),
          platform_source: normalizePlatformSource(row.platform_source as string | null)
        }
      })
    }

    const summaries = store.db.prepare(`
      SELECT
        ss.*,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON s.memory_session_id = ss.memory_session_id
      ORDER BY ss.id ASC
    `).all() as Array<Record<string, unknown>>
    for (const row of summaries) {
      await enqueue({
        id: `summary:${row.id}`,
        document: buildSummaryDocument({
          request: String(row.request ?? ''),
          investigated: String(row.investigated ?? ''),
          learned: String(row.learned ?? ''),
          completed: String(row.completed ?? ''),
          next_steps: String(row.next_steps ?? ''),
          notes: row.notes as string | null
        }),
        metadata: {
          sqlite_id: Number(row.id),
          doc_type: 'session_summary',
          memory_session_id: String(row.memory_session_id ?? ''),
          project: String(row.project ?? ''),
          prompt_number: Number(row.prompt_number ?? 0),
          created_at_epoch: Number(row.created_at_epoch ?? 0),
          platform_source: normalizePlatformSource(row.platform_source as string | null)
        }
      })
    }

    const prompts = store.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id,
        COALESCE(NULLIF(s.platform_source, ''), 'claude') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.session_db_id = s.id
      ORDER BY up.id ASC
    `).all() as Array<Record<string, unknown>>
    for (const row of prompts) {
      await enqueue({
        id: `prompt:${row.id}`,
        document: String(row.prompt_text ?? ''),
        metadata: {
          sqlite_id: Number(row.id),
          doc_type: 'user_prompt',
          memory_session_id: String(row.memory_session_id ?? ''),
          project: String(row.project ?? ''),
          prompt_number: Number(row.prompt_number ?? 0),
          created_at_epoch: Number(row.created_at_epoch ?? 0),
          platform_source: normalizePlatformSource(row.platform_source as string | null)
        }
      })
    }
    await flush()

    logger.info('HELIX', 'Backfill complete', {
      synced,
      totalRows: observations.length + summaries.length + prompts.length
    })
  }

  async updateMergedIntoProject(sqliteIds: number[], parentProject: string): Promise<void> {
    const transport = await this.transport()
    for (const sqliteId of sqliteIds) {
      await transport.updateNodes('SemanticDocument', { sqlite_id: sqliteId }, {
        merged_into_project: parentProject
      })
    }
    logger.info('HELIX', 'Updated merged_into_project for semantic documents', {
      count: sqliteIds.length,
      parentProject
    })
  }
}
