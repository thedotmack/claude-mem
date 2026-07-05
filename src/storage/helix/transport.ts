import { Client, Predicate, g, readBatch, writeBatch } from '@helix-db/helix-db'
import { logger } from '../../utils/logger.js'

export type HelixPropertyValue =
  | string
  | number
  | boolean
  | null
  | string[]
  | number[]
  | boolean[]

export type HelixNode = Record<string, HelixPropertyValue>

export interface HelixTransport {
  ensureSearchIndexes(): Promise<void>;
  insertNode(label: string, properties: HelixNode): Promise<HelixNode>;
  findNodes(label: string, filters?: Record<string, string | number | boolean | null>): Promise<HelixNode[]>;
  updateNodes(
    label: string,
    filters: Record<string, string | number | boolean | null>,
    properties: HelixNode
  ): Promise<HelixNode[]>;
}

type FilterValue = string | number | boolean | null

function extractRows(result: unknown): HelixNode[] {
  if (Array.isArray(result)) {
    return result as HelixNode[]
  }
  if (result && typeof result === 'object') {
    for (const value of Object.values(result as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        return value as HelixNode[]
      }
    }
  }
  return []
}

function applyFilters<T>(traversal: T, filters?: Record<string, FilterValue>): T {
  if (!filters || Object.keys(filters).length === 0) {
    return traversal
  }
  let next: any = traversal
  for (const [key, value] of Object.entries(filters)) {
    next = next.where(Predicate.eq(key, value))
  }
  return next as T
}

export class HelixHttpTransport implements HelixTransport {
  private indexesEnsured = false

  constructor(private readonly client: Client) {}

  async ensureSearchIndexes(): Promise<void> {
    if (this.indexesEnsured) return
    const batch = writeBatch()
      .varAs('text_index', g().createTextIndexNodes('MemoryItem', 'indexed_text'))
      .varAs('vector_index', g().createVectorIndexNodes('MemoryItem', 'embedding'))
      .varAs('semantic_text_index', g().createTextIndexNodes('SemanticDocument', 'document'))
      .varAs('semantic_vector_index', g().createVectorIndexNodes('SemanticDocument', 'embedding'))
      .returning([])
    await this.client.query().dynamic(batch.toDynamicRequest()).send()
    this.indexesEnsured = true
  }

  async insertNode(label: string, properties: HelixNode): Promise<HelixNode> {
    const batch = writeBatch()
      .varAs('rows', g().addN(label, properties).valueMap())
      .returning(['rows'])
    const rows = extractRows(await this.client.query().dynamic(batch.toDynamicRequest()).send())
    return rows[0] ?? properties
  }

  async findNodes(label: string, filters?: Record<string, FilterValue>): Promise<HelixNode[]> {
    const traversal = applyFilters(g().nWithLabel(label), filters).valueMap()
    const batch = readBatch()
      .varAs('rows', traversal)
      .returning(['rows'])
    return extractRows(await this.client.query().dynamic(batch.toDynamicRequest()).send())
  }

  async updateNodes(
    label: string,
    filters: Record<string, FilterValue>,
    properties: HelixNode
  ): Promise<HelixNode[]> {
    let traversal: any = applyFilters(g().nWithLabel(label), filters)
    for (const [key, value] of Object.entries(properties)) {
      traversal = traversal.setProperty(key, value)
    }
    const batch = writeBatch()
      .varAs('rows', traversal.valueMap())
      .returning(['rows'])
    return extractRows(await this.client.query().dynamic(batch.toDynamicRequest()).send())
  }
}

export class InMemoryHelixTransport implements HelixTransport {
  private readonly nodes = new Map<string, HelixNode[]>()

  async ensureSearchIndexes(): Promise<void> {}

  async insertNode(label: string, properties: HelixNode): Promise<HelixNode> {
    const rows = this.nodes.get(label) ?? []
    const copy = { ...properties }
    rows.push(copy)
    this.nodes.set(label, rows)
    return copy
  }

  async findNodes(label: string, filters?: Record<string, FilterValue>): Promise<HelixNode[]> {
    const rows = this.nodes.get(label) ?? []
    return rows
      .filter(row => {
        for (const [key, value] of Object.entries(filters ?? {})) {
          if ((row[key] ?? null) !== value) {
            return false
          }
        }
        return true
      })
      .map(row => ({ ...row }))
  }

  async updateNodes(
    label: string,
    filters: Record<string, FilterValue>,
    properties: HelixNode
  ): Promise<HelixNode[]> {
    const rows = this.nodes.get(label) ?? []
    const updated: HelixNode[] = []
    for (const row of rows) {
      let matches = true
      for (const [key, value] of Object.entries(filters)) {
        if ((row[key] ?? null) !== value) {
          matches = false
          break
        }
      }
      if (!matches) continue
      Object.assign(row, properties)
      updated.push({ ...row })
    }
    return updated
  }
}

export function createHelixHttpTransport(baseUrl: string, apiKey?: string): HelixTransport {
  const client = new Client(baseUrl)
  if (apiKey) {
    client.withApiKey(apiKey)
  }
  logger.debug('HELIX', 'Created Helix HTTP transport', { baseUrl })
  return new HelixHttpTransport(client)
}

