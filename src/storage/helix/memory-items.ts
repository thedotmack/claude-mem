import { randomUUID } from 'crypto'
import {
  CreateMemoryItemSchema,
  CreateMemorySourceSchema,
  MemoryItemSchema,
  MemorySourceSchema,
  type CreateMemoryItem,
  type CreateMemorySource,
  type MemoryItem,
  type MemorySource
} from '../../core/schemas/memory-item.js'
import { parseJsonArray, parseJsonObject, stringifyJson } from '../sqlite/serde.js'
import { cosineSimilarity, createDeterministicEmbedding } from './embeddings.js'
import type { HelixNode, HelixTransport } from './transport.js'

function buildIndexedText(input: {
  title?: string | null;
  subtitle?: string | null;
  text?: string | null;
  narrative?: string | null;
  facts?: string[];
  concepts?: string[];
}): string {
  return [
    input.title ?? '',
    input.subtitle ?? '',
    input.text ?? '',
    input.narrative ?? '',
    ...(input.facts ?? []),
    ...(input.concepts ?? [])
  ].join('\n')
}

function mapMemoryItemRow(row: HelixNode): MemoryItem {
  return MemoryItemSchema.parse({
    id: row.id,
    projectId: row.project_id,
    serverSessionId: row.server_session_id ?? null,
    legacyObservationId: row.legacy_observation_id ?? null,
    kind: row.kind,
    type: row.type,
    title: row.title ?? null,
    subtitle: row.subtitle ?? null,
    text: row.text ?? null,
    narrative: row.narrative ?? null,
    facts: parseJsonArray(typeof row.facts === 'string' ? row.facts : '[]'),
    concepts: parseJsonArray(typeof row.concepts === 'string' ? row.concepts : '[]'),
    filesRead: parseJsonArray(typeof row.files_read === 'string' ? row.files_read : '[]'),
    filesModified: parseJsonArray(typeof row.files_modified === 'string' ? row.files_modified : '[]'),
    metadata: parseJsonObject(typeof row.metadata === 'string' ? row.metadata : '{}'),
    createdAtEpoch: row.created_at_epoch,
    updatedAtEpoch: row.updated_at_epoch
  })
}

function mapMemorySourceRow(row: HelixNode): MemorySource {
  return MemorySourceSchema.parse({
    id: row.id,
    memoryItemId: row.memory_item_id,
    sourceType: row.source_type,
    legacyTable: row.legacy_table ?? null,
    legacyId: row.legacy_id ?? null,
    sourceUri: row.source_uri ?? null,
    metadata: parseJsonObject(typeof row.metadata === 'string' ? row.metadata : '{}'),
    createdAtEpoch: row.created_at_epoch
  })
}

export class HelixMemoryItemsRepository {
  constructor(private readonly transport: HelixTransport) {}

  private async assertProjectSessionPair(projectId: string, serverSessionId: string | null | undefined): Promise<void> {
    if (!serverSessionId) return
    const sessions = await this.transport.findNodes('ServerSession', {
      id: serverSessionId,
      project_id: projectId
    })
    if (sessions.length === 0) {
      throw new Error('memory_items server_session_id must belong to project_id')
    }
  }

  async create(input: CreateMemoryItem): Promise<MemoryItem> {
    const item = CreateMemoryItemSchema.parse(input)
    await this.assertProjectSessionPair(item.projectId, item.serverSessionId)
    if (item.legacyObservationId != null) {
      const existing = await this.transport.findNodes('MemoryItem', {
        legacy_observation_id: item.legacyObservationId
      })
      if (existing.length > 0) {
        throw new Error(`Memory item already exists for legacy observation ${item.legacyObservationId}`)
      }
    }

    await this.transport.ensureSearchIndexes()
    const indexedText = buildIndexedText(item)
    const now = Date.now()
    const row = await this.transport.insertNode('MemoryItem', {
      id: randomUUID(),
      project_id: item.projectId,
      server_session_id: item.serverSessionId ?? null,
      legacy_observation_id: item.legacyObservationId ?? null,
      kind: item.kind,
      type: item.type,
      title: item.title ?? null,
      subtitle: item.subtitle ?? null,
      text: item.text ?? null,
      narrative: item.narrative ?? null,
      facts: stringifyJson(item.facts ?? []),
      concepts: stringifyJson(item.concepts ?? []),
      files_read: stringifyJson(item.filesRead ?? []),
      files_modified: stringifyJson(item.filesModified ?? []),
      metadata: stringifyJson(item.metadata),
      indexed_text: indexedText,
      embedding: createDeterministicEmbedding(indexedText),
      created_at_epoch: now,
      updated_at_epoch: now
    })
    return mapMemoryItemRow(row)
  }

  async addSource(input: CreateMemorySource): Promise<MemorySource> {
    const source = CreateMemorySourceSchema.parse(input)
    if (source.legacyTable && source.legacyId != null) {
      const duplicate = await this.transport.findNodes('MemorySource', {
        source_type: source.sourceType,
        legacy_table: source.legacyTable,
        legacy_id: source.legacyId
      })
      if (duplicate.length > 0) {
        throw new Error(`Memory source already exists for ${source.legacyTable}:${source.legacyId}`)
      }
    }
    const now = Date.now()
    const row = await this.transport.insertNode('MemorySource', {
      id: randomUUID(),
      memory_item_id: source.memoryItemId,
      source_type: source.sourceType,
      legacy_table: source.legacyTable ?? null,
      legacy_id: source.legacyId ?? null,
      source_uri: source.sourceUri ?? null,
      metadata: stringifyJson(source.metadata),
      created_at_epoch: now
    })
    return mapMemorySourceRow(row)
  }

  async getById(id: string): Promise<MemoryItem | null> {
    const rows = await this.transport.findNodes('MemoryItem', { id })
    return rows[0] ? mapMemoryItemRow(rows[0]) : null
  }

  async update(id: string, input: Partial<CreateMemoryItem>): Promise<MemoryItem | null> {
    const existing = await this.getById(id)
    if (!existing) return null
    const next = CreateMemoryItemSchema.parse({
      projectId: input.projectId ?? existing.projectId,
      serverSessionId: input.serverSessionId ?? existing.serverSessionId,
      legacyObservationId: input.legacyObservationId ?? existing.legacyObservationId,
      kind: input.kind ?? existing.kind,
      type: input.type ?? existing.type,
      title: input.title ?? existing.title,
      subtitle: input.subtitle ?? existing.subtitle,
      text: input.text ?? existing.text,
      narrative: input.narrative ?? existing.narrative,
      facts: input.facts ?? existing.facts,
      concepts: input.concepts ?? existing.concepts,
      filesRead: input.filesRead ?? existing.filesRead,
      filesModified: input.filesModified ?? existing.filesModified,
      metadata: input.metadata ?? existing.metadata
    })
    await this.assertProjectSessionPair(next.projectId, next.serverSessionId)
    const indexedText = buildIndexedText(next)
    const rows = await this.transport.updateNodes('MemoryItem', { id }, {
      project_id: next.projectId,
      server_session_id: next.serverSessionId ?? null,
      legacy_observation_id: next.legacyObservationId ?? null,
      kind: next.kind,
      type: next.type,
      title: next.title ?? null,
      subtitle: next.subtitle ?? null,
      text: next.text ?? null,
      narrative: next.narrative ?? null,
      facts: stringifyJson(next.facts ?? []),
      concepts: stringifyJson(next.concepts ?? []),
      files_read: stringifyJson(next.filesRead ?? []),
      files_modified: stringifyJson(next.filesModified ?? []),
      metadata: stringifyJson(next.metadata),
      indexed_text: indexedText,
      embedding: createDeterministicEmbedding(indexedText),
      updated_at_epoch: Date.now()
    })
    return rows[0] ? mapMemoryItemRow(rows[0]) : null
  }

  async getSourceById(id: string): Promise<MemorySource | null> {
    const rows = await this.transport.findNodes('MemorySource', { id })
    return rows[0] ? mapMemorySourceRow(rows[0]) : null
  }

  async listByProject(projectId: string, limit = 100): Promise<MemoryItem[]> {
    const rows = await this.transport.findNodes('MemoryItem', { project_id: projectId })
    return rows
      .map(mapMemoryItemRow)
      .sort((left, right) => right.createdAtEpoch - left.createdAtEpoch)
      .slice(0, limit)
  }

  async search(projectId: string, query: string, limit = 20): Promise<MemoryItem[]> {
    const rows = await this.transport.findNodes('MemoryItem', { project_id: projectId })
    const queryEmbedding = createDeterministicEmbedding(query)
    return rows
      .map(row => ({
        row,
        score: cosineSimilarity(
          Array.isArray(row.embedding) ? row.embedding.map(value => Number(value)) : [],
          queryEmbedding
        )
      }))
      .filter(entry => entry.score > 0)
      .sort((left, right) => right.score - left.score || Number(right.row.updated_at_epoch) - Number(left.row.updated_at_epoch))
      .slice(0, limit)
      .map(entry => mapMemoryItemRow(entry.row))
  }
}

