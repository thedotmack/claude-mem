// The Reveal's three sets, read from the live work view snapshot as the extraction saves each one: goals (owner-goals),
// then work (request groups), then rules (the build story's preferences). Nothing is invented: a set the run has not
// reached yet is `null` (placeholders), and a finished run leaves an empty set empty.
import type { WorkViewSnapshot } from '../live/work-view-api-types.ts'

/** data.ts AgentTool, spelled out so this file (and its node test) needs no app alias. */
type AgentTool = 'claude' | 'codex' | 'gemini' | 'other'

/** One overall request. New installs have no progress readings, so `progressPercent` is absent and no bar shows. */
export interface RevealWork { id: string; title: string; agent: AgentTool; lastActiveAt: string; progressPercent?: number }
export interface RevealGoal { id: string; rank: number; title: string; timesAsked: number; latestAt: string }
export interface RevealRule { id: string; text: string; quote: string; quotedAt: string }
/** `null` while that set is still being extracted. */
export interface RevealSets { goals: RevealGoal[] | null; work: RevealWork[] | null; rules: RevealRule[] | null }

/** The worker's setup view on the snapshot (WorkViewRoutes.setupView). */
export interface WorkerExtraction {
  state: 'idle' | 'running' | 'ok' | 'failed' | 'waiting-for-agent'
  reason: string | null
  step: 'goals' | 'work' | 'rules' | null
  agent: string | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}
/** One overall request from the request-group ledger (WorkViewRoutes SetupWorkItem). */
export interface WorkerSetupWork { groupId: string; title: string; platform: string | null; lastActiveAt: string | null; progressPercent: number | null }
export type SnapshotWithSetup = WorkViewSnapshot & {
  setup?: { extraction: WorkerExtraction | null; work?: WorkerSetupWork[] | null } | null
  story?: { groups?: number; story: unknown } | null
}

const SHOWN = 5
const pad = (value: number) => String(value).padStart(2, '0')

/** `MM-DD HH:MM` in local time, the stamp formatPromptDay reads. */
export function promptStamp(at: string | number | null | undefined): string {
  if (at === null || at === undefined || at === '') return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Goal stamps are already the typed minute, `YYYY-MM-DD HH:MM` or a bare day. */
const goalStamp = (at: string | null) => (at && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(5) : '')

const toolFor = (platformSource: string | null | undefined): AgentTool =>
  platformSource === 'claude' ? 'claude' : platformSource === 'codex' ? 'codex' : platformSource?.startsWith('gemini') ? 'gemini' : 'other'

const RULE_SHOWN_STATUSES = new Set(['on', 'suggested'])

export function revealFromSnapshot(snapshot: SnapshotWithSetup): RevealSets {
  const extraction = snapshot.setup?.extraction ?? null
  const finished = extraction?.state === 'ok' || extraction?.state === 'failed'

  const goals: RevealGoal[] | null = snapshot.goals
    ? [...snapshot.goals.areas].sort((left, right) => (left.rank ?? Infinity) - (right.rank ?? Infinity)).slice(0, SHOWN)
      .map((item, index) => ({ id: item.id, rank: item.rank ?? index + 1, title: item.title, timesAsked: item.timesAsked ?? item.evidence.length, latestAt: goalStamp(item.latestAt) }))
    : null

  // Work comes from the request groups themselves, so a new install (prompts only, no observations) has it too.
  const groups = snapshot.setup?.work ?? null
  const work: RevealWork[] | null = groups
    ? groups.slice(0, SHOWN).map((group) => ({
      id: group.groupId,
      title: group.title,
      agent: toolFor(group.platform),
      lastActiveAt: promptStamp(group.lastActiveAt),
      // A review without evidence (every new install) has no percent: no bar.
      ...(group.progressPercent !== null ? { progressPercent: group.progressPercent } : {}),
    }))
    : null

  const learned = (snapshot.rules ?? []).filter((rule) => RULE_SHOWN_STATUSES.has(rule.status) && rule.quotes.length)
  const rules: RevealRule[] | null = snapshot.story?.story || learned.length
    ? [...learned].sort((left, right) => right.timesSeen - left.timesSeen).slice(0, SHOWN)
      .map((rule) => ({ id: rule.ruleId, text: rule.when ? `${rule.when}: ${rule.then}` : rule.then, quote: rule.quotes[0].quote, quotedAt: promptStamp(rule.quotes[0].at) }))
    : null

  return { goals: goals ?? (finished ? [] : null), work: work ?? (finished ? [] : null), rules: rules ?? (finished ? [] : null) }
}
