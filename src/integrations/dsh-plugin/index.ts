/**
 * `dsh-claude-mem` — a DeepSeek Harness plugin integrating claude-mem: query,
 * context injection, manual save, and session lifecycle over a local claude-mem
 * worker's HTTP API. A single self-contained package (no monorepo-only
 * dependencies), installable from a git clone via `dsh plugin add`.
 *
 * Platform scoping is a SIGNAL, never an enforced restriction: `platformSource`
 * defaults to unset (unfiltered), and `ingest`/`summarize` default to off so a
 * plain mount is read-only against existing memory.
 * @module dsh-claude-mem
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-skill'
import { WorkerClient } from './worker.js'
import { applyMemoryTools } from './tools.js'
import { applyMemoryHooks } from './hooks.js'
import { memSearchSkill } from './skill.js'
import { resolveHarnessWorkerUrl } from '../harness-worker.js'

export const name = 'claude-mem'
export const inject = ['tools', 'skills']

/** Environment, persisted settings, then the worker's per-user port default. */
function defaultBaseUrl(): string {
  const explicit = process.env.DSH_MEM_BASE_URL
  return (explicit !== undefined && explicit.length > 0 ? explicit : resolveHarnessWorkerUrl()).replace(/\/+$/, '')
}

/** Plugin configuration. */
export interface Config {
  /** Worker base URL. Defaults to `$DSH_MEM_BASE_URL` or the derived localhost address. */
  baseUrl?: string
  /** Per-request timeout (ms). Defaults to 30000. */
  timeoutMs?: number
  /** Collapse duplicate observations in query results (content fingerprint, not identity). Defaults to true. */
  dedupe?: boolean
  /** Optional platform-scope filter (e.g. `"dsh"`). Omitted = unfiltered. */
  platformSource?: string
  /** Project name for context/session calls; defaults to the session cwd basename. */
  project?: string
  /** Inject session-start context via `agent.inject()`. Defaults to true. */
  injectContext?: boolean
  /** Observe tool results and save manual memories. Defaults to false. */
  ingest?: boolean
  /** Summarize the session on turn stop. Defaults to false. */
  summarize?: boolean
  /** Tool names observed for ingestion (only when `ingest` is true). */
  toolFilter?: { names?: string[] }
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().default(''),
  timeoutMs: Schema.number().default(30_000),
  dedupe: Schema.boolean().default(true),
  platformSource: Schema.string().default(''),
  project: Schema.string().default(''),
  injectContext: Schema.boolean().default(true),
  ingest: Schema.boolean().default(false),
  summarize: Schema.boolean().default(false),
  toolFilter: Schema.object({
    names: Schema.array(Schema.string()).default(['read', 'write', 'edit', 'bash']),
  }).default({ names: ['read', 'write', 'edit', 'bash'] }),
})

type ResolvedConfig = Config & {
  baseUrl: string
  timeoutMs: number
  dedupe: boolean
  platformSource: string
  project: string
  injectContext: boolean
  ingest: boolean
  summarize: boolean
  toolFilter: { names: string[] }
}

/** Mount the worker client, the model-facing tools plus the mem-search skill, and the lifecycle hooks. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)

  const baseUrl = (resolved.baseUrl !== '' ? resolved.baseUrl : defaultBaseUrl()).replace(/\/+$/, '')
  const worker = new WorkerClient({
    baseUrl,
    timeoutMs: resolved.timeoutMs,
    dedupe: resolved.dedupe,
  })

  ctx.skills.register(memSearchSkill)
  applyMemoryTools(ctx, worker, {
    timeoutMs: resolved.timeoutMs,
  })
  applyMemoryHooks(ctx, worker, {
    startLocalWorker: baseUrl === resolveHarnessWorkerUrl(),
    platformSource: resolved.platformSource,
    project: resolved.project,
    injectContext: resolved.injectContext,
    ingest: resolved.ingest,
    summarize: resolved.summarize,
    toolFilter: resolved.toolFilter,
  })
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`claude-mem: ${field} must be a positive integer`)
  }
}
