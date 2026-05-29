// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { Database } from 'bun:sqlite';
import {
  CreateMemoryRelationSchema,
  MemoryRelationSchema,
  type CreateMemoryRelation,
  type MemoryRelation,
  type MemoryRelationType
} from '../../core/schemas/memory-item.js';
import { ensureServerStorageSchema } from './schema.js';
import { parseJsonObject, stringifyJson } from './serde.js';

interface MemoryRelationRow {
  id: string;
  source_memory_id: string;
  target_memory_id: string;
  relation_type: MemoryRelationType;
  is_active: number;
  condition: string | null;
  metadata: string;
  created_at_epoch: number;
}

function mapMemoryRelationRow(row: MemoryRelationRow): MemoryRelation {
  return MemoryRelationSchema.parse({
    id: row.id,
    sourceMemoryId: row.source_memory_id,
    targetMemoryId: row.target_memory_id,
    relationType: row.relation_type,
    isActive: row.is_active === 1,
    condition: row.condition,
    metadata: parseJsonObject(row.metadata),
    createdAtEpoch: row.created_at_epoch
  });
}

export class MemoryRelationsRepository {
  constructor(private db: Database) {
    ensureServerStorageSchema(this.db);
  }

  create(input: CreateMemoryRelation): MemoryRelation {
    const relation = CreateMemoryRelationSchema.parse(input);
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO memory_relations (
        id, source_memory_id, target_memory_id, relation_type,
        is_active, condition, metadata, created_at_epoch
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      relation.sourceMemoryId,
      relation.targetMemoryId,
      relation.relationType,
      (relation.isActive ?? true) ? 1 : 0,
      relation.condition ?? null,
      stringifyJson(relation.metadata ?? {}),
      now
    );

    return this.getById(id)!;
  }

  getById(id: string): MemoryRelation | null {
    const row = this.db.prepare('SELECT * FROM memory_relations WHERE id = ?').get(id) as MemoryRelationRow | null;
    return row ? mapMemoryRelationRow(row) : null;
  }

  listBySource(sourceMemoryId: string): MemoryRelation[] {
    const rows = this.db.prepare(`
      SELECT * FROM memory_relations
      WHERE source_memory_id = ?
      ORDER BY created_at_epoch ASC
    `).all(sourceMemoryId) as MemoryRelationRow[];
    return rows.map(mapMemoryRelationRow);
  }

  listByTarget(targetMemoryId: string): MemoryRelation[] {
    const rows = this.db.prepare(`
      SELECT * FROM memory_relations
      WHERE target_memory_id = ?
      ORDER BY created_at_epoch ASC
    `).all(targetMemoryId) as MemoryRelationRow[];
    return rows.map(mapMemoryRelationRow);
  }

  setActive(id: string, isActive: boolean): MemoryRelation | null {
    this.db.prepare(`
      UPDATE memory_relations SET is_active = ? WHERE id = ?
    `).run(isActive ? 1 : 0, id);
    return this.getById(id);
  }

  /**
   * Returns IDs of memory_items that have an active 'supersedes' relation
   * pointing at them — i.e., they have been superseded and should be
   * excluded from default search/list results.
   */
  getSupersededIds(projectId?: string): string[] {
    const query = projectId
      ? `
          SELECT DISTINCT mr.target_memory_id
          FROM memory_relations mr
          JOIN memory_items mi ON mi.id = mr.target_memory_id
          WHERE mr.relation_type = 'supersedes'
            AND mr.is_active = 1
            AND mi.project_id = ?
        `
      : `
          SELECT DISTINCT target_memory_id
          FROM memory_relations
          WHERE relation_type = 'supersedes'
            AND is_active = 1
        `;

    const rows = projectId
      ? this.db.prepare(query).all(projectId) as { target_memory_id: string }[]
      : this.db.prepare(query).all() as { target_memory_id: string }[];

    return rows.map(r => r.target_memory_id);
  }
}
