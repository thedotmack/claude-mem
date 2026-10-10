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

// unicode61 indexes these unsegmented runs as a single token. A user term
// inside a run needs a literal substring predicate, as in worker-local search.
const UNSEGMENTED_SCRIPT = /[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u3100-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;

function buildSearchQuery(query: string): { words: string; symbols: Array<{ literal: string; expanded: string }>; substrings: string[] } {
  const tokenQuery = (text: string): string => text
    .trim()
    .split(/\s+/)
    .flatMap(token => token.split(/[^\p{L}\p{N}_]+/gu))
    .filter(Boolean)
    .map(token => `"${token}"`)
    .join(' ');
  // unicode61 keeps compatibility characters in stored documents. Match each
  // indexed word in its original or normalized form independently.
  const tokens = query.match(/[\p{L}\p{N}\p{S}_][\p{L}\p{N}\p{M}\p{S}_]*/gu) ?? [];
  const words = tokens.filter(token => tokenQuery(token) && !UNSEGMENTED_SCRIPT.test(token)).map(token => {
    const alternatives = [...new Set([token, token.normalize('NFKC')].map(tokenQuery).filter(Boolean))];
    return alternatives.length > 1
      ? `(${alternatives.map(text => `(${text})`).join(' OR ')})`
      : alternatives[0] ?? '';
  }).filter(Boolean).join(' AND ');
  // Symbol-only compatibility terms have no raw FTS token: ™ expands to TM
  // and ℀ to a/c. Keep their literal and expanded alternatives as constraints.
  const symbols = [...new Set(tokens.filter(token => !tokenQuery(token)))]
    .map(literal => ({ literal, expanded: tokenQuery(literal.normalize('NFKC')) }))
    .filter(symbol => symbol.expanded);
  return { words, symbols, substrings: tokens.filter(token => UNSEGMENTED_SCRIPT.test(token)) };
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

  update(id: string, input: Partial<CreateMemoryItem>): MemoryItem | null {
    const existing = this.getById(id);
    if (!existing) {
      return null;
    }
    const next = CreateMemoryItemSchema.parse({
      projectId: input.projectId ?? existing.projectId,
      serverSessionId: input.serverSessionId !== undefined ? input.serverSessionId : existing.serverSessionId,
      legacyObservationId: input.legacyObservationId !== undefined ? input.legacyObservationId : existing.legacyObservationId,
      kind: input.kind ?? existing.kind,
      type: input.type ?? existing.type,
      title: input.title !== undefined ? input.title : existing.title,
      subtitle: input.subtitle !== undefined ? input.subtitle : existing.subtitle,
      text: input.text !== undefined ? input.text : existing.text,
      narrative: input.narrative !== undefined ? input.narrative : existing.narrative,
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
    const { words, symbols, substrings } = buildSearchQuery(query);
    if (!words && symbols.length === 0 && substrings.length === 0) return [];

    const conditions = ['memory_items.project_id = ?'];
    const parameters: Array<string | number> = [projectId];
    const ftsCondition = `memory_items.id IN (
      SELECT memory_item_id FROM memory_items_fts
      WHERE project_id = ? AND memory_items_fts MATCH ?
    )`;
    if (words) {
      conditions.push(ftsCondition);
      parameters.push(projectId, words);
    }
    const indexedFields = ['title', 'subtitle', 'text', 'narrative', 'facts', 'concepts'];
    for (const term of substrings) {
      const alternatives = [...new Set([term, term.normalize('NFKC')])];
      const clauses = alternatives.flatMap(literal => indexedFields.map(field => {
        parameters.push(literal);
        return `instr(lower(COALESCE(memory_items.${field}, '')), lower(?)) > 0`;
      }));
      conditions.push(`(${clauses.join(' OR ')})`);
    }
    for (const symbol of symbols) {
      const literalCondition = indexedFields.map(field => `instr(COALESCE(memory_items.${field}, ''), ?) > 0`).join(' OR ');
      // MATCH stays in its own subquery: SQLite cannot always evaluate a
      // virtual-table MATCH directly beneath an outer OR expression.
      conditions.push(`((${literalCondition}) OR ${ftsCondition})`);
      parameters.push(...indexedFields.map(() => symbol.literal), projectId, symbol.expanded);
    }
    parameters.push(limit);
    const rows = this.db.prepare(`
      SELECT memory_items.*
      FROM memory_items
      WHERE ${conditions.join(' AND ')}
      ORDER BY memory_items.updated_at_epoch DESC
      LIMIT ?
    `).all(...parameters) as MemoryItemRow[];
    return rows.map(mapMemoryItemRow);
  }
}
