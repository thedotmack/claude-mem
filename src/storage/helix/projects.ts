import { randomUUID } from 'crypto'
import { CreateProjectSchema, ProjectSchema, type CreateProject, type Project } from '../../core/schemas/project.js'
import { parseJsonObject, stringifyJson } from '../sqlite/serde.js'
import type { HelixNode, HelixTransport } from './transport.js'

function mapProjectRow(row: HelixNode): Project {
  return ProjectSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug ?? null,
    rootPath: row.root_path ?? null,
    metadata: parseJsonObject(typeof row.metadata === 'string' ? row.metadata : '{}'),
    createdAtEpoch: row.created_at_epoch,
    updatedAtEpoch: row.updated_at_epoch
  })
}

export class HelixProjectsRepository {
  constructor(private readonly transport: HelixTransport) {}

  async create(input: CreateProject): Promise<Project> {
    const project = CreateProjectSchema.parse(input)
    const duplicateChecks = [
      project.slug ? this.transport.findNodes('Project', { slug: project.slug }) : Promise.resolve([]),
      project.rootPath ? this.transport.findNodes('Project', { root_path: project.rootPath }) : Promise.resolve([])
    ]
    const [duplicateSlug, duplicateRootPath] = await Promise.all(duplicateChecks)
    if (duplicateSlug.length > 0) {
      throw new Error(`Project slug already exists: ${project.slug}`)
    }
    if (duplicateRootPath.length > 0) {
      throw new Error(`Project root path already exists: ${project.rootPath}`)
    }

    const now = Date.now()
    const row = await this.transport.insertNode('Project', {
      id: randomUUID(),
      name: project.name,
      slug: project.slug ?? null,
      root_path: project.rootPath ?? null,
      metadata: stringifyJson(project.metadata),
      created_at_epoch: now,
      updated_at_epoch: now
    })
    return mapProjectRow(row)
  }

  async getById(id: string): Promise<Project | null> {
    const rows = await this.transport.findNodes('Project', { id })
    return rows[0] ? mapProjectRow(rows[0]) : null
  }

  async list(): Promise<Project[]> {
    const rows = await this.transport.findNodes('Project')
    return rows
      .map(mapProjectRow)
      .sort((left, right) => right.updatedAtEpoch - left.updatedAtEpoch || left.name.localeCompare(right.name))
  }
}

