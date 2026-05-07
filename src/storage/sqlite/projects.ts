// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import { Database } from 'bun:sqlite';
import { CreateProjectSchema, ProjectSchema, type CreateProject, type Project } from '../../core/schemas/project.js';
import { ensureServerStorageSchema } from './schema.js';
import { parseJsonObject, stringifyJson } from './serde.js';

interface ProjectRow {
  id: string;
  name: string;
  slug: string | null;
  root_path: string | null;
  metadata: string;
  created_at_epoch: number;
  updated_at_epoch: number;
}

function mapProjectRow(row: ProjectRow): Project {
  return ProjectSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    rootPath: row.root_path,
    metadata: parseJsonObject(row.metadata),
    createdAtEpoch: row.created_at_epoch,
    updatedAtEpoch: row.updated_at_epoch
  });
}

export class ProjectsRepository {
  constructor(private db: Database) {
    ensureServerStorageSchema(this.db);
  }

  create(input: CreateProject): Project {
    const project = CreateProjectSchema.parse(input);
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO projects (id, name, slug, root_path, metadata, created_at_epoch, updated_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      project.name,
      project.slug ?? null,
      project.rootPath ?? null,
      stringifyJson(project.metadata),
      now,
      now
    );

    return this.getById(id)!;
  }

  upsert(input: CreateProject & { id?: string }): Project {
    const project = CreateProjectSchema.parse(input);
    const now = Date.now();
    const id = input.id ?? randomUUID();

    this.db.prepare(`
      INSERT INTO projects (id, name, slug, root_path, metadata, created_at_epoch, updated_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        slug = excluded.slug,
        root_path = excluded.root_path,
        metadata = excluded.metadata,
        updated_at_epoch = excluded.updated_at_epoch
    `).run(id, project.name, project.slug ?? null, project.rootPath ?? null, stringifyJson(project.metadata), now, now);

    return this.getById(id)!;
  }

  getById(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | null;
    return row ? mapProjectRow(row) : null;
  }

  getByRootPath(rootPath: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE root_path = ?').get(rootPath) as ProjectRow | null;
    return row ? mapProjectRow(row) : null;
  }

  list(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY updated_at_epoch DESC, name ASC').all() as ProjectRow[];
    return rows.map(mapProjectRow);
  }
}
