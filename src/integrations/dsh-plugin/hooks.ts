/**
 * Lifecycle hooks: drive session-start context injection, optional ingestion
 * on tool result, and optional summarization on turn stop. Platform scoping is
 * a signal, never an enforced restriction.
 * @module dsh-claude-mem/hooks
 */

import type { Context } from './sdk-contract.js'
import type { Agent } from './sdk-contract.js'
import type { ContentBlock, UserMessage } from './sdk-contract.js'
import { createUserMessage } from './vendor/sdk.mjs'
import type { ToolExecution, ToolExecutionResult, PostToolDecision } from './sdk-contract.js'
import { basename } from 'node:path'
import { createHarnessWorkerClient } from '../harness-worker.js'
import type { WorkerClient } from './worker.js'

export interface HooksConfig {
  startLocalWorker?: boolean
  platformSource?: string
  project?: string
  injectContext: boolean
  ingest: boolean
  summarize: boolean
  toolFilter: { names: string[] }
}

/** Attach the memory lifecycle hooks to their extension points. */
export function applyMemoryHooks(ctx: Context, worker: WorkerClient, config: HooksConfig): void {
  // The public DSH lifecycle is agent/created; agent/session-start is not emitted.
  ctx.on('agent/created', async (payload: { agent: Agent }) => {
    const { agent } = payload
    if (!config.injectContext) return
    await seedSessionContext(worker, agent, config)
  })

  if (config.ingest) {
    ctx.on('tools/post-execute', (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => {
      void observeToolResult(worker, exec, result, config)
      return next()
    })
  }

  if (config.summarize) {
    ctx.on('agent/turn-stopping', (payload: { agent: Agent }) => {
      void summarizeSession(worker, payload.agent, config)
    })
  }
}

async function seedSessionContext(worker: WorkerClient, agent: Agent, config: HooksConfig): Promise<void> {
  try {
    if (config.startLocalWorker) await createHarnessWorkerClient().ready()
    const cwd = agent.session.header.cwd
    if (!config.project && !cwd) return
    const text = await worker.context({ ...(config.project ? { projects: config.project } : { cwd }), ...platform(config) })
    if (text.length === 0) return
    const message: UserMessage = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:claude-mem' },
    })
    agent.inject(message)
  } catch {
    // Context seeding is best-effort: an unavailable worker must not block the
    // first turn. The worker being down is reported by the mem_* tools instead.
  }
}

async function observeToolResult(worker: WorkerClient, exec: ToolExecution, result: Readonly<ToolExecutionResult>, config: HooksConfig): Promise<void> {
  if (result.isError) return
  if (!config.toolFilter.names.includes(exec.name)) return
  const agent = exec.agent
  if (agent === undefined) return
  const text = resultContentText(result.content)
  if (text.length === 0) return
  const project = projectName(agent, config)
  try {
    await worker.save({
      text: `[${exec.name}] ${text}`,
      project,
      ...platform(config),
    })
  } catch {
    // Ingestion is fire-and-forget alongside the real tool's success.
  }
}

async function summarizeSession(worker: WorkerClient, agent: Agent, config: HooksConfig): Promise<void> {
  const project = projectName(agent, config)
  try {
    await worker.sessionSummarize({ contentSessionId: agent.session.id, project, ...platform(config) })
  } catch {
    // Summarization is best-effort.
  }
}

function projectName(agent: Agent, config: HooksConfig): string {
  if (config.project !== undefined && config.project.trim().length > 0) return config.project
  const cwd = agent.session.header.cwd
  if (cwd !== undefined) {
    const base = basename(cwd)
    if (base.length > 0) return base
  }
  return 'dsh'
}

function platform(config: HooksConfig): { platformSource?: string } {
  return config.platformSource !== undefined && config.platformSource.length > 0
    ? { platformSource: config.platformSource }
    : {}
}

function resultContentText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}
