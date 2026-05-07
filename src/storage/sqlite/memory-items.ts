// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { Database } from 'bun:sqlite';
import {
  CreateMemoryItemSchema,
  CreateMemorySourceSchema,
  MemoryItemSchema,
  MemorySourceSchema,
  type CreateMemoryItem,
  type CreateMemorySource,
  type MemoryItem,
  type MemoryItemKind,
  type MemorySource,
  type MemorySourceType
} from '../../core/schemas/memory-item.js';
import { ensureServerStorageSchema } from './schema.js';
import { parseJsonArray, parseJsonObject, stringifyJson } from './serde.js';

interface MemoryItemRow {
  id: string;
  project_id: string;
  server_session_id: string | null;
  legacy_observation_id: number | null;
  kind: MemoryItemKind;
  type: string;
  title: string | null;
  subtitle: string | null;
  text: string | null;
  narrative: string | null;
  facts: string;
  concepts: string;
  files_read: string;
  files_modified: string;
  metadata: string;
  created_at_epoch: number;
  updated_at_epoch: number;
}

interface MemorySourceRow {
  id: string;
  memory_item_id: string;
  source_type: MemorySourceType;
  legacy_table: string | null;
  legacy_id: number | null;
  source_uri: string | null;
  metadata: string;
  created_at_epoch: number;
}

function mapMemoryItemRow(row: MemoryItemRow): MemoryItem {
  return MemoryItemSchema.parse({
    id: row.id,
    projectId: row.project_id,
    serverSessionId: row.server_session_id,
    legacyObservationId: row.legacy_observation_id,
    kind: row.kind,
    type: row.type,
    title: row.title,
    subtitle: row.subtitle,
    text: row.text,
    narrative: row.narrative,
    facts: parseJsonArray(row.facts),
    concepts: parseJsonArray(row.concepts),
    filesRead: parseJsonArray(row.files_read),
    filesModified: parseJsonArray(row.files_modified),
    metadata: parseJsonObject(row.metadata),
    createdAtEpoch: row.created_at_epoch,
    updatedAtEpoch: row.updated_at_epoch
  });
}

function mapMemorySourceRow(row: MemorySourceRow): MemorySource {
  return MemorySourceSchema.parse({
    id: row.id,
    memoryItemId: row.memory_item_id,
    sourceType: row.source_type,
    legacyTable: row.legacy_table,
    legacyId: row.legacy_id,
    sourceUri: row.source_uri,
    metadata: parseJsonObject(row.metadata),
    createdAtEpoch: row.created_at_epoch
  });
}

function buildFtsQuery(query: string): string {
  return query
    .normalize('NFKC')
    .trim()
    .split(/\s+/)
    .flatMap(token => token.split(/[^\p{L}\p{N}_]+/gu))
    .filter(Boolean)
    .map(token => `"${token}"`)
    .join(' ');
}

export class MemoryItemsRepository {
  constructor(private db: Database) {
    ensureServerStorageSchema(this.db);
  }

  create(input: CreateMemoryItem): MemoryItem {
    const item = CreateMemoryItemSchema.parse(input);
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO memory_items (
        id, project_id, server_session_id, legacy_observation_id, kind, type,
        title, subtitle, text, narrative, facts, concepts, files_read,
        files_modified, metadata, created_at_epoch, updated_at_epoch
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      item.projectId,
      item.serverSessionId ?? null,
      item.legacyObservationId ?? null,
      item.kind,
      item.type,
      item.title ?? null,
      item.subtitle ?? null,
      item.text ?? null,
      item.narrative ?? null,
      stringifyJson(item.facts ?? []),
      stringifyJson(item.concepts ?? []),
      stringifyJson(item.filesRead ?? []),
      stringifyJson(item.filesModified ?? []),
      stringifyJson(item.metadata),
      now,
      now
    );

    return this.getById(id)!;
  }

  addSource(input: CreateMemorySource): MemorySource {
    const source = CreateMemorySourceSchema.parse(input);
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO memory_sources (
        id, memory_item_id, source_type, legacy_table, legacy_id, source_uri,
        metadata, created_at_epoch
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      source.memoryItemId,
      source.sourceType,
      source.legacyTable ?? null,
      source.legacyId ?? null,
      source.sourceUri ?? null,
      stringifyJson(source.metadata),
      now
    );

    return this.getSourceById(id)!;
  }

  getById(id: string): MemoryItem | null {
    const row = this.db.prepare('SELECT * FROM memory_items WHERE id = ?').get(id) as MemoryItemRow | null;
    return row ? mapMemoryItemRow(row) : null;
  }

  getByLegacyObservationId(legacyObservationId: number): MemoryItem | null {
    const row = this.db.prepare('SELECT * FROM memory_items WHERE legacy_observation_id = ?').get(legacyObservationId) as MemoryItemRow | null;
    return row ? mapMemoryItemRow(row) : null;
  }

  update(id: string, input: Partial<CreateMemoryItem>): MemoryItem | null {
    const existing = this.getById(id);
    if (!existing) {
      return null;
    }
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
      metadata: input.metadata ?? existing.metadata,
    });
    const now = Date.now();

    this.db.prepare(`
      UPDATE memory_items
      SET
        project_id = ?,
        server_session_id = ?,
        legacy_observation_id = ?,
        kind = ?,
        type = ?,
        title = ?,
        subtitle = ?,
        text = ?,
        narrative = ?,
        facts = ?,
        concepts = ?,
        files_read = ?,
        files_modified = ?,
        metadata = ?,
        updated_at_epoch = ?
      WHERE id = ?
    `).run(
      next.projectId,
      next.serverSessionId ?? null,
      next.legacyObservationId ?? null,
      next.kind,
      next.type,
      next.title ?? null,
      next.subtitle ?? null,
      next.text ?? null,
      next.narrative ?? null,
      stringifyJson(next.facts ?? []),
      stringifyJson(next.concepts ?? []),
      stringifyJson(next.filesRead ?? []),
      stringifyJson(next.filesModified ?? []),
      stringifyJson(next.metadata),
      now,
      id,
    );

    return this.getById(id);
  }

  getSourceById(id: string): MemorySource | null {
    const row = this.db.prepare('SELECT * FROM memory_sources WHERE id = ?').get(id) as MemorySourceRow | null;
    return row ? mapMemorySourceRow(row) : null;
  }

  listByProject(projectId: string, limit = 100): MemoryItem[] {
    const rows = this.db.prepare(`
      SELECT * FROM memory_items
      WHERE project_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(projectId, limit) as MemoryItemRow[];
    return rows.map(mapMemoryItemRow);
  }

  search(projectId: string, query: string, limit = 20): MemoryItem[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    const rows = this.db.prepare(`
      SELECT memory_items.*
      FROM memory_items
      JOIN memory_items_fts ON memory_items_fts.memory_item_id = memory_items.id
      WHERE memory_items_fts.project_id = ?
        AND memory_items_fts MATCH ?
      ORDER BY memory_items.updated_at_epoch DESC
      LIMIT ?
    `).all(projectId, ftsQuery, limit) as MemoryItemRow[];
    return rows.map(mapMemoryItemRow);
  }

  listSources(memoryItemId: string): MemorySource[] {
    const rows = this.db.prepare(`
      SELECT * FROM memory_sources
      WHERE memory_item_id = ?
      ORDER BY created_at_epoch ASC
    `).all(memoryItemId) as MemorySourceRow[];
    return rows.map(mapMemorySourceRow);
  }
}
