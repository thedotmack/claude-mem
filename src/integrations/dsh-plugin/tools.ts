/**
 * Model-facing memory tools over a `WorkerClient`. Owns schemas, validation,
 * and presentation; execution goes through the worker client.
 * @module dsh-claude-mem/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WorkerClient } from './worker.js'
import type {
  MemGetObservationsRequest,
  MemObservation,
  MemSaveRequest,
  MemSearchRequest,
  MemSearchResult,
  MemTimelineRequest,
} from './types.js'

export interface ToolsConfig {
  search?: boolean
  timeline?: boolean
  getObservations?: boolean
  save?: boolean
  context?: boolean
  timeoutMs: number
}

/** One observation's index projection (id/title/type/project/createdAtEpoch/narrative). */
interface IndexItem {
  id: number
  title: string
  type?: string
  project?: string
  createdAtEpoch?: number
  narrative?: string
}

/** Full observation projection — every field the worker returns, for `mem_get_observations`. */
interface FullItem extends IndexItem {
  memorySessionId?: string
  subtitle?: string
  text?: string
  facts?: string[]
  concepts?: string[]
  filesRead?: string[]
  filesModified?: string[]
  metadata?: Record<string, unknown>
  createdAt?: string
  promptNumber?: number
  discoveryTokens?: number
  contentHash?: string
  generatedByModel?: string
  relevanceCount?: number
  mergedIntoProject?: string
  agentType?: string
  agentId?: string
  syncedAt?: number
  originDeviceId?: string
  originLocalId?: string
  syncRev?: string
}

interface QueryOutput {
  items: IndexItem[]
  content?: string
}

interface FullQueryOutput {
  items: FullItem[]
  content?: string
}

/** Project an observation down to the index view (search/timeline). */
function projectIndexItem(item: MemObservation, opts: { createdAtEpoch?: boolean }): IndexItem {
  return {
    id: item.id,
    title: item.title,
    ...item.type !== undefined ? { type: item.type } : {},
    ...item.project !== undefined ? { project: item.project } : {},
    ...(opts.createdAtEpoch && item.createdAtEpoch !== undefined) ? { createdAtEpoch: item.createdAtEpoch } : {},
    ...item.narrative !== undefined ? { narrative: item.narrative } : {},
  }
}

/** Project an observation to its full shape, keeping every field the worker returned. */
function projectFullItem(item: MemObservation): FullItem {
  const full: FullItem = {
    id: item.id,
    title: item.title,
  }
  if (item.memorySessionId !== undefined) full.memorySessionId = item.memorySessionId
  if (item.type !== undefined) full.type = item.type
  if (item.project !== undefined) full.project = item.project
  if (item.subtitle !== undefined) full.subtitle = item.subtitle
  if (item.text !== undefined) full.text = item.text
  if (item.narrative !== undefined) full.narrative = item.narrative
  if (item.facts !== undefined) full.facts = [...item.facts]
  if (item.concepts !== undefined) full.concepts = [...item.concepts]
  if (item.filesRead !== undefined) full.filesRead = [...item.filesRead]
  if (item.filesModified !== undefined) full.filesModified = [...item.filesModified]
  if (item.metadata !== undefined) full.metadata = { ...item.metadata }
  if (item.createdAt !== undefined) full.createdAt = item.createdAt
  if (item.createdAtEpoch !== undefined) full.createdAtEpoch = item.createdAtEpoch
  if (item.promptNumber !== undefined) full.promptNumber = item.promptNumber
  if (item.discoveryTokens !== undefined) full.discoveryTokens = item.discoveryTokens
  if (item.contentHash !== undefined) full.contentHash = item.contentHash
  if (item.generatedByModel !== undefined) full.generatedByModel = item.generatedByModel
  if (item.relevanceCount !== undefined) full.relevanceCount = item.relevanceCount
  if (item.mergedIntoProject !== undefined) full.mergedIntoProject = item.mergedIntoProject
  if (item.agentType !== undefined) full.agentType = item.agentType
  if (item.agentId !== undefined) full.agentId = item.agentId
  if (item.syncedAt !== undefined) full.syncedAt = item.syncedAt
  if (item.originDeviceId !== undefined) full.originDeviceId = item.originDeviceId
  if (item.originLocalId !== undefined) full.originLocalId = item.originLocalId
  if (item.syncRev !== undefined) full.syncRev = item.syncRev
  return full
}

function projectQueryResult(value: MemSearchResult, opts: { createdAtEpoch?: boolean } = {}): QueryOutput {
  const items: IndexItem[] = value.items.map(item => projectIndexItem(item, opts))
  return {
    items,
    ...value.content !== undefined ? { content: value.content } : {},
  }
}

function projectFullResult(value: MemSearchResult): FullQueryOutput {
  const items: FullItem[] = value.items.map(projectFullItem)
  return {
    items,
    ...value.content !== undefined ? { content: value.content } : {},
  }
}

/** Register the enabled memory tools on `ctx.tools`. */
export function applyMemoryTools(ctx: Context, worker: WorkerClient, config: ToolsConfig): void {
  if (config.search !== false) applySearchTool(ctx, worker, config.timeoutMs)
  if (config.timeline !== false) applyTimelineTool(ctx, worker, config.timeoutMs)
  if (config.getObservations !== false) applyGetObservationsTool(ctx, worker, config.timeoutMs)
  if (config.save !== false) applySaveTool(ctx, worker, config.timeoutMs)
  if (config.context !== false) applyContextTool(ctx, worker, config.timeoutMs)
}

function applySearchTool(ctx: Context, worker: WorkerClient, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'mem_search',
    description: 'Search persistent cross-session memory for observations matching a query. Returns an index with ids, titles, and types — fetch full details only for filtered ids.',
    parameters: {
      query: { type: 'string', required: true, description: 'Free-text search query.' },
      limit: { type: 'integer', description: 'Max results (default 20).' },
      project: { type: 'string', description: 'Filter by project name.' },
      platformSource: { type: 'string', description: 'Optional platform filter (e.g. "dsh"); omit to search all memory.' },
      type: { type: 'string', description: "Category: 'observations', 'sessions', or 'prompts'." },
      obsType: { type: 'string', description: 'Comma-separated observation types (e.g. bugfix, feature, decision).' },
      dateStart: { type: 'string', description: 'Start date filter (ISO).' },
      dateEnd: { type: 'string', description: 'End date filter (ISO).' },
      offset: { type: 'integer', description: 'Pagination offset.' },
      orderBy: { type: 'string', description: "'date_desc' or 'date_asc'." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              id: { type: 'number', required: true },
              title: { type: 'string', required: true },
              type: { type: 'string' },
              project: { type: 'string' },
              createdAtEpoch: { type: 'number' },
              narrative: { type: 'string' },
            },
          } },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatQueryOutput(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return projectQueryResult(await worker.search(buildSearchRequest(args), exec.signal), { createdAtEpoch: true })
    },
  }))
}

function applyTimelineTool(ctx: Context, worker: WorkerClient, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'mem_timeline',
    description: 'Get context around one memory observation (its surrounding observations) by id or query.',
    parameters: {
      anchor: { type: 'integer', description: 'Observation id to center around.' },
      query: { type: 'string', description: 'Find the anchor from this query.' },
      depthBefore: { type: 'integer', description: 'Items before anchor (default 3).' },
      depthAfter: { type: 'integer', description: 'Items after anchor (default 3).' },
      project: { type: 'string', description: 'Filter by project name.' },
      platformSource: { type: 'string', description: 'Optional platform filter; omit to search all memory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              id: { type: 'number', required: true },
              title: { type: 'string', required: true },
              type: { type: 'string' },
              project: { type: 'string' },
              narrative: { type: 'string' },
            },
          } },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatQueryOutput(value) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input: MemTimelineRequest = {
        ...args.anchor !== undefined ? { anchor: args.anchor } : {},
        ...args.query !== undefined ? { query: args.query } : {},
        ...args.depthBefore !== undefined ? { depthBefore: args.depthBefore } : {},
        ...args.depthAfter !== undefined ? { depthAfter: args.depthAfter } : {},
        ...args.project !== undefined ? { project: args.project } : {},
        ...args.platformSource !== undefined ? { platformSource: args.platformSource } : {},
      }
      return projectQueryResult(await worker.timeline(input, exec.signal), { createdAtEpoch: true })
    },
  }))
}

function applyGetObservationsTool(ctx: Context, worker: WorkerClient, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'mem_get_observations',
    description: 'Fetch full details for memory observations by id. Returns every field the worker reports (narrative, facts, concepts, files, metadata and timestamps) for parity with the raw API.',
    parameters: {
      ids: { type: 'array', required: true, items: { type: 'integer' }, description: 'Observation ids (required).' },
      project: { type: 'string', description: 'Filter by project name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              id: { type: 'number', required: true },
              title: { type: 'string', required: true },
              memorySessionId: { type: 'string' },
              type: { type: 'string' },
              project: { type: 'string' },
              subtitle: { type: 'string' },
              text: { type: 'string' },
              narrative: { type: 'string' },
              facts: { type: 'array', items: { type: 'string' } },
              concepts: { type: 'array', items: { type: 'string' } },
              filesRead: { type: 'array', items: { type: 'string' } },
              filesModified: { type: 'array', items: { type: 'string' } },
              metadata: { type: 'object', additionalProperties: true },
              createdAt: { type: 'string' },
              createdAtEpoch: { type: 'number' },
              promptNumber: { type: 'number' },
              discoveryTokens: { type: 'number' },
              contentHash: { type: 'string' },
              generatedByModel: { type: 'string' },
              relevanceCount: { type: 'number' },
              mergedIntoProject: { type: 'string' },
              agentType: { type: 'string' },
              agentId: { type: 'string' },
              syncedAt: { type: 'number' },
              originDeviceId: { type: 'string' },
              originLocalId: { type: 'string' },
              syncRev: { type: 'string' },
            },
          } },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatFullOutput(value as unknown as FullQueryOutput) }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.ids.length === 0) throw new Error('at least one observation id is required')
      const input: MemGetObservationsRequest = {
        ids: args.ids,
        ...args.project !== undefined ? { project: args.project } : {},
      }
      return projectFullResult(await worker.getObservations(input, exec.signal)) as never
    },
  }))
}

function applySaveTool(ctx: Context, worker: WorkerClient, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'mem_save',
    description: 'Save one manual memory as an observation in persistent memory (no generation job; stores the text as given).',
    parameters: {
      text: { type: 'string', required: true, description: 'Memory text to save.' },
      title: { type: 'string', description: 'Optional title.' },
      project: { type: 'string', description: 'Optional project.' },
      metadata: { type: 'object', additionalProperties: true, description: 'Optional free-form metadata.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          id: { type: 'number', required: true },
          title: { type: 'string', required: true },
          project: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Saved observation #${value.id} (${value.title})` }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const input: MemSaveRequest = {
        text: args.text.trim(),
        ...args.title !== undefined ? { title: args.title } : {},
        ...args.project !== undefined ? { project: args.project } : {},
        ...args.metadata !== undefined ? { metadata: args.metadata } : {},
      }
      return await worker.save(input, exec.signal)
    },
  }))
}

function applyContextTool(ctx: Context, worker: WorkerClient, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'mem_context',
    description: 'Render the worker\'s session-start context text for one or more projects (the same text injected at startup).',
    parameters: {
      projects: { type: 'string', required: true, description: 'Project chain, comma-separated; the last is primary.' },
      platformSource: { type: 'string', description: 'Optional platform filter.' },
      full: { type: 'boolean', description: 'Request full context instead of configured limits.' },
      colors: { type: 'boolean', description: 'Request terminal-color formatting.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.projects.trim().length === 0) throw new Error('at least one project is required')
      return await worker.context({
        projects: args.projects,
        ...args.platformSource !== undefined ? { platformSource: args.platformSource } : {},
        ...args.full !== undefined ? { full: args.full } : {},
        ...args.colors !== undefined ? { colors: args.colors } : {},
      }, exec.signal)
    },
  }))
}

function buildSearchRequest(args: {
  query: string
  limit?: number
  project?: string
  platformSource?: string
  type?: string
  obsType?: string
  dateStart?: string
  dateEnd?: string
  offset?: number
  orderBy?: string
}): MemSearchRequest {
  const orderBy = args.orderBy === 'date_asc' || args.orderBy === 'date_desc' ? args.orderBy : undefined
  return {
    query: args.query.trim(),
    ...args.limit !== undefined ? { limit: args.limit } : {},
    ...args.project !== undefined ? { project: args.project } : {},
    ...args.platformSource !== undefined ? { platformSource: args.platformSource } : {},
    ...args.type !== undefined ? { type: args.type } : {},
    ...args.obsType !== undefined ? { obsType: args.obsType } : {},
    ...args.dateStart !== undefined ? { dateStart: args.dateStart } : {},
    ...args.dateEnd !== undefined ? { dateEnd: args.dateEnd } : {},
    ...args.offset !== undefined ? { offset: args.offset } : {},
    ...orderBy !== undefined ? { orderBy } : {},
  }
}

export function formatQueryOutput(value: QueryOutput): string {
  if (value.content !== undefined && value.content.length > 0) return value.content
  if (value.items.length === 0) return 'No results found.'
  return value.items
    .map((item) => {
      const type = item.type !== undefined ? ` [${item.type}]` : ''
      const project = item.project !== undefined ? ` (${item.project})` : ''
      const narrative = item.narrative !== undefined ? `\n  ${item.narrative}` : ''
      return `#${item.id} ${item.title}${type}${project}${narrative}`
    })
    .join('\n')
}

/** Render full observation details (every field) for `mem_get_observations`. */
export function formatFullOutput(value: FullQueryOutput): string {
  if (value.content !== undefined && value.content.length > 0) return value.content
  if (value.items.length === 0) return 'No results found.'
  return value.items
    .map((item) => {
      const lines: string[] = [`#${item.id} ${item.title}`]
      const meta: string[] = []
      if (item.type !== undefined) meta.push(`type=${item.type}`)
      if (item.project !== undefined) meta.push(`project=${item.project}`)
      if (item.memorySessionId !== undefined) meta.push(`session=${item.memorySessionId}`)
      if (item.createdAt !== undefined) meta.push(`created=${item.createdAt}`)
      if (meta.length > 0) lines.push(`[${meta.join(', ')}]`)
      if (item.subtitle !== undefined) lines.push(`subtitle: ${item.subtitle}`)
      if (item.narrative !== undefined) lines.push(`narrative: ${item.narrative}`)
      if (item.text !== undefined && item.text.length > 0) lines.push(`text: ${item.text}`)
      if (item.facts !== undefined && item.facts.length > 0) lines.push(`facts: ${JSON.stringify(item.facts)}`)
      if (item.concepts !== undefined && item.concepts.length > 0) lines.push(`concepts: ${JSON.stringify(item.concepts)}`)
      if (item.filesRead !== undefined && item.filesRead.length > 0) lines.push(`filesRead: ${JSON.stringify(item.filesRead)}`)
      if (item.filesModified !== undefined && item.filesModified.length > 0) lines.push(`filesModified: ${JSON.stringify(item.filesModified)}`)
      if (item.metadata !== undefined && Object.keys(item.metadata).length > 0) lines.push(`metadata: ${JSON.stringify(item.metadata)}`)
      if (item.contentHash !== undefined) lines.push(`contentHash: ${item.contentHash}`)
      if (item.originDeviceId !== undefined) lines.push(`originDeviceId: ${item.originDeviceId}`)
      if (item.originLocalId !== undefined) lines.push(`originLocalId: ${item.originLocalId}`)
      return lines.join('\n')
    })
    .join('\n\n')
}
