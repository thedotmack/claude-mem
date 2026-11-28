// The one pure mapper from a WorkViewSnapshot (local worker today, cmem.ai later) to the WorkModel the screens use.
// It follows the plan's mapping table. Where the snapshot has no value, the field takes the table's "missing" value;
// nothing is estimated or made up (spec §12). Relative imports with .ts extensions so `node --test` can load it.
import { assertConsistentRequest, EVIDENCE_KINDS, type WorkProductKind, type Agent, type AgentTool, type CurrentPeriod, type Device, type EvidenceKind, type NextStep, type NextStepMissing, type PastPeriod, type Request, type SkillRun } from '../data.ts'
import { createFocusAreaResolver, toFocusModel, type MinedGoalItem } from './to-focus-model.ts'
import { normalizeRequestStatus, presentStatus, STALE_AFTER_MS, type NormalizedStatus } from './status-normalization.ts'
import type { MappedWorkModel, RequestReadError } from './work-data-source.ts'
import type { OwnerRule, RuleQuote, RuleRecord } from '../data-rules.ts'
import type { AutoRefresh, BuildStory, StoryChapter } from './work-data-source.ts'
import { measuredEstimate } from './measured-estimate.ts'
import { repeatsOwnerWords } from './prompt-echo.ts'
import { SOLO_REQUESTER } from './work-view-overview.ts'
import type { WorkViewAgent, WorkViewBuildStory, WorkViewGoalItem, WorkViewGoalList, WorkViewHumanRequest, WorkViewProgress, WorkViewRefresh, WorkViewRule, WorkViewSnapshot, WorkViewWorkProduct } from './work-view-api-types.ts'

export const THIS_COMPUTER: Device = { id: 'this-computer', name: 'This computer', syncedMinutesAgo: 0, online: true }
/**
 * Stands in when a request names no agent the snapshot knows: the card then names the machine (§13.2). The UI words
 * its name in the reader's language and draws its tile dashed (components/bits.tsx AgentIcon).
 */
export const UNRECORDED_AGENT: Agent = { id: 'agent-not-recorded', tool: 'other', name: 'Agent not recorded', role: 'Recorded work', deviceId: THIS_COMPUTER.id }
/**
 * The mapper's English words for the role of a session with no title and no project folder (toAgent). The UI words it
 * in the reader's language (lib/agent-words.ts); a session title or folder name is the agent's own and stays as
 * written.
 */
export const RECORDED_SESSION_ROLE = 'Recorded session'
/**
 * What workers before 16.0.0 wrote before a subagent's role ("Subagent · repo"). The mapper no longer writes it: a
 * subagent is known by its typed status (data.ts isSubagent), and its role is its own. agentOwnRole reads an older
 * worker's role without it (G19: the 15.19.0 worker still sends it).
 */
export const SUBAGENT_ROLE_PREFIX = 'Subagent · '

/**
 * An agent's own role: its session title, folder or "Recorded session". A subagent mapped by a worker before 16.0.0
 * carries SUBAGENT_ROLE_PREFIX before it, which is read off here, in this one place, as nextStepShown reads an older
 * worker's fillers (G19). Whether the agent is a subagent comes from its typed status, never from these words.
 */
export function agentOwnRole(agent: Pick<Agent, 'role' | 'status'>): string {
  return agent.status !== undefined && agent.role.startsWith(SUBAGENT_ROLE_PREFIX) ? agent.role.slice(SUBAGENT_ROLE_PREFIX.length) : agent.role
}
/**
 * The English filler workers before 16.0.0 wrote in place of a next step when none was recorded. The mapper now
 * writes the missing value instead (NextStepMissing, decision G3); this stays so nextStepShown can read an older
 * worker's payload (G19: the 15.19.0 worker still sends it), and as the shared page's English for that value.
 */
export const NEXT_STEP_NOT_RECORDED = 'Next step not recorded'
/**
 * The same filler for a request with only asks, before any agent recorded work (the `no-agent-work` value now). Like
 * NEXT_STEP_NOT_RECORDED it is not a step: nextStepShown reads it as missing, so My Work's cards and setup's Reveal
 * (setup/setup-reveal.ts) leave the line out (decision G3), and the shared page still words that value with it
 * (live/to-shared-focus.ts).
 */
export const NO_WORK_YET = 'No agent work recorded yet'
/**
 * What the mapper writes for a conversation's or a prompt's time when none is recorded. The drawer's conversation rows
 * and its prompts leave it out (components/conversation-continue.tsx ConversationRow): it tells one conversation from no
 * other. A saved rule's times are null when not recorded instead (recordedTime); workers before 16.0.0 wrote this text
 * there too.
 */
export const TIME_NOT_RECORDED = 'Time not recorded'
/**
 * The English workers before 16.0.0 wrote in place of a saved rule's time that is not recorded: a quote's or a record's
 * time, the latest time it was seen, and when it was replaced. The mapper now writes null; recordedTime reads both as
 * not recorded (G19: the 15.19.0 worker still sends the words), so My Rules words them in the reader's language.
 */
const LEGACY_RULE_TIMES_NOT_RECORDED: ReadonlySet<string> = new Set([TIME_NOT_RECORDED, 'not recorded', 'a date not recorded'])
/** A rule's recorded time as the mapper words it, or null when none is recorded (or an older worker's words say so). */
export const recordedTime = (at: string | null | undefined): string | null => at && !LEGACY_RULE_TIMES_NOT_RECORDED.has(at) ? at : null
/**
 * What workers before 16.0.0 wrote for a request whose start is not recorded. The mapper now writes null
 * (Request.startedAt); recordedStart reads both as not recorded (G19), and the shared page keeps writing these words, as
 * it did before 16.0.0 (live/to-shared-focus.ts).
 */
export const LEGACY_START_NOT_RECORDED = 'Start not recorded'
/** When a request started, as the mapper words it, or null when it is not recorded. */
export const recordedStart = (startedAt: string | null | undefined): string | null => startedAt && startedAt !== LEGACY_START_NOT_RECORDED ? startedAt : null
/**
 * What workers before 16.0.0 wrote for a workstream with no recorded title and a task with no recorded name. The mapper
 * now writes null; recordedWorkstreamTitle and recordedTaskName read both as not recorded (G19), and the drawer words
 * that in the reader's language.
 */
const LEGACY_WORKSTREAM_TITLE = 'Supporting work'
const LEGACY_TASK_NAME = 'Untitled task'
export const recordedWorkstreamTitle = (title: string | null | undefined): string | null => title && title !== LEGACY_WORKSTREAM_TITLE ? title : null
export const recordedTaskName = (name: string | null | undefined): string | null => name && name !== LEGACY_TASK_NAME ? name : null
/**
 * The English title workers before 16.0.0 wrote for a conversation whose title is not recorded: "Conversation" and the
 * first eight characters of its session id. The mapper now writes null instead, so no English rides the model as a title
 * (fix round R2, rule 4); the screens read this filler as not recorded too (live/conversation-continuation.ts
 * conversationNaming), so a page reading an older worker, such as the live 15.19.0 worker behind the preview, names the
 * conversation the same way, in the reader's language (G19).
 */
export const legacyUntitledConversationTitle = (conversationSessionId: string) => `Conversation ${conversationSessionId.slice(0, 8)}`
/**
 * The English that workers before 16.0.0 wrote for the step kinds that are not recorded words (data.ts NextStepKind):
 * a checked result's "Ship it", and "Unblock: " before a blocked request's step. nextStepShown reads them as their
 * kinds (G19), and the shared page still writes them, so its words stay as they were (live/to-shared-focus.ts).
 */
export const LEGACY_SHIP_STEP = 'Ship it'
export const LEGACY_UNBLOCK_PREFIX = 'Unblock: '
/** The fillers an older worker may send, and the missing value each one stands for. */
const LEGACY_MISSING_NEXT_STEP: ReadonlyMap<string, NextStepMissing> = new Map([
  [NEXT_STEP_NOT_RECORDED, 'not-recorded'],
  [`${LEGACY_UNBLOCK_PREFIX}${NEXT_STEP_NOT_RECORDED}`, 'not-recorded'],
  [NO_WORK_YET, 'no-agent-work'],
  [`${LEGACY_UNBLOCK_PREFIX}${NO_WORK_YET}`, 'no-agent-work'],
])

/** What a next-step line shows (decision G3): a step of one kind (data.ts NextStepKind), or why none is recorded. */
export type ShownNextStep =
  | { kind: 'step'; who: NextStep['who']; step: 'recorded' | 'unblock'; text: string }
  | { kind: 'step'; who: NextStep['who']; step: 'ship'; text?: undefined }
  | { kind: 'missing'; who: NextStep['who'] | null; missing: NextStepMissing }

/**
 * What a request's next-step line shows (decision G3): its step and the step's kind, or why none is recorded. Reads
 * the values this mapper writes and the English older workers wrote in their place (fillers, "Ship it", "Unblock: …";
 * G19), so every screen and the shared page decide it in this one place. An empty text counts as not recorded.
 */
export function nextStepShown(next: Partial<NextStep> | null | undefined): ShownNextStep {
  const who = next?.who ?? null
  if (next?.missing) return { kind: 'missing', who, missing: next.missing }
  if (next?.kind === 'ship' && who) return { kind: 'step', who, step: 'ship' }
  const text = next?.text?.trim() ?? ''
  const legacy = LEGACY_MISSING_NEXT_STEP.get(text)
  if (!text || legacy || !who) return { kind: 'missing', who, missing: legacy ?? 'not-recorded' }
  if (text === LEGACY_SHIP_STEP) return { kind: 'step', who, step: 'ship' }
  if (text.startsWith(LEGACY_UNBLOCK_PREFIX)) {
    const step = text.slice(LEGACY_UNBLOCK_PREFIX.length).trim()
    return step ? { kind: 'step', who, step: 'unblock', text: step } : { kind: 'missing', who, missing: 'not-recorded' }
  }
  return { kind: 'step', who, step: next?.kind === 'unblock' ? 'unblock' : 'recorded', text }
}
const KNOWN_TOOLS: AgentTool[] = ['claude', 'codex', 'gemini']
const PLATFORM_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' }
/**
 * The tool a conversation names when its platform has no name of its own above: the catalog word "Agent". A tool's
 * own name is a name and shows as written; this word the screens say in the reader's language (conversationToolWords).
 */
export const UNNAMED_TOOL = 'Agent'
/** A conversation's tool as the screens show it: its own name, or "Agent" in the reader's language (`t`). */
export const conversationToolWords = (tool: string, t: (english: string) => string) => tool === UNNAMED_TOOL ? t(UNNAMED_TOOL) : tool
/**
 * Where the worker serves a source record: /api/work-view/evidence/<kind>/<id> (WorkViewRoutes). A link of any other
 * shape is not a record the drawer can open, so it is not listed as one.
 */
const EVIDENCE_URL = /^\/api\/work-view\/evidence\/([\w-]+)\/\d+$/
/** The kinds the evidence route serves: every EvidenceKind (data.ts, the one list) but `record`, which names no route. */
const EVIDENCE_ROUTE_KINDS: readonly EvidenceKind[] = EVIDENCE_KINDS.filter((kind) => kind !== 'record')
// work-product.mjs kinds onto the drawer's kinds; anything unknown is a plain link.
const WORK_PRODUCT_KIND: Record<string, WorkProductKind> = {
  'pull-request': 'PR', commit: 'Commit', branch: 'Branch', artifact: 'Page', page: 'Page', deployment: 'Page',
  deck: 'Deck', document: 'Doc', documentation: 'Doc', image: 'File', video: 'File', spreadsheet: 'File', file: 'File',
}

/** Origin-only metadata stays visible without an href; unavailable local files remain hidden. */
function mapWorkProduct(products: WorkViewWorkProduct[] | undefined): Request['workProduct'] {
  return (products ?? []).filter((product) => product.available !== false || product.availability === 'origin-only').map((product) => ({
    kind: WORK_PRODUCT_KIND[product.kind] ?? 'Link',
    label: cleanText(product.title, 140) || product.kind,
    href: product.availability === 'origin-only' ? undefined : product.url ?? product.fileUrl ?? undefined,
    ...(product.deliverable === true ? { deliverable: true as const } : {}),
    ...(product.availability === 'origin-only' ? { availability: 'origin-only' as const } : {}),
  }))
}
/**
 * A source record's kind from its evidence link (/api/work-view/evidence/<kind>/<id>), or null for a link that is not
 * one. A kind the one list does not name throws, as the mapper does for other values it cannot read: the request then
 * shows as one that could not be read, with the link in its reason. It never becomes `record` unsaid.
 */
function evidenceKindOf(href: string): EvidenceKind | null {
  if (!EVIDENCE_URL.test(href)) return null
  const kind = routeKindOf(href)
  if (!kind) throw new Error(`A source record links to an evidence kind this page does not know: ${href}`)
  return kind
}
/** The kind an evidence link names, when it is one of the route's kinds; undefined for any other link. */
function routeKindOf(href: string): EvidenceKind | undefined {
  const named = EVIDENCE_URL.exec(href)?.[1]
  return EVIDENCE_ROUTE_KINDS.find((known) => known === named)
}
/**
 * The English workers before 16.0.0 wrote in front of each source record's title for its kind ("Observation: …"), and no
 * `kind`. The mapper now sends the kind as a value; evidenceShown reads an older worker's words as their kind (G19).
 */
const LEGACY_EVIDENCE_PREFIX: Record<EvidenceKind, string> = { 'work-state': 'Work state', observation: 'Observation', prompt: 'Your prompt', summary: 'Session summary', session: 'Session', record: 'Record' }
/** A source record as the drawer shows it: its kind (null for an older worker's title with no kind it names) and title. */
export function evidenceShown(source: Request['evidence'][number]): { kind: EvidenceKind | null; title: string } {
  if (source.kind) return { kind: source.kind, title: source.title }
  for (const [kind, prefix] of Object.entries(LEGACY_EVIDENCE_PREFIX) as [EvidenceKind, string][]) {
    if (source.title.startsWith(`${prefix}: `)) return { kind, title: source.title.slice(prefix.length + 2) }
  }
  return { kind: null, title: source.title }
}

// cleanText is copied from claude-mem v15.0.1 plugin/ui/work-view/view-model.js:6-20: it drops injected
// instructions, code fences, markup and markdown from recorded text, then shortens at a word boundary.
const meaningful = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/^(true|false|null|undefined|\d+)$/i.test(value.trim())
function cleanText(value: unknown, max = 150): string {
  if (!meaningful(value)) return ''
  const text = value
    .replace(/<(environment_context|instructions|system-reminder|INSTRUCTIONS|AGENTS)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim()
  if (/^(?:AGENTS\.md instructions|You are (?:Codex|an AI)|[/{]["']?\w+["']?\s*:)/i.test(text)) return ''
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const boundary = cut.lastIndexOf(' ')
  return `${cut.slice(0, boundary > max * 0.65 ? boundary : max - 1).replace(/[,:;\-\s]+$/, '')}…`
}

/**
 * The instant beside each time below, which the screens word in the reader's language and clock (lib/display-time.ts,
 * Phase 6 fix V3). The English words stay for the shared page, older readers and the sort; no screen shows them.
 */
const isoOf = (epoch: number) => new Date(epoch).toISOString()
const lowercaseMeridiem = (text: string) => text.replace(/\s?(AM|PM)$/, (_, meridiem: string) => ` ${meridiem.toLowerCase()}`)
/** "Oct 20, 1:16 pm", like the fixtures. */
const formatDateTime = (epoch: number) => lowercaseMeridiem(new Date(epoch).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))
/** "1:56 pm" today, "Oct 19" before. */
function formatRecordTime(epoch: number, now: number) {
  const sameDay = new Date(epoch).toDateString() === new Date(now).toDateString()
  return sameDay ? lowercaseMeridiem(new Date(epoch).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })) : new Date(epoch).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
/** "10-20 13:24", the prompt-quote stamp the fixtures use. */
function formatPromptStamp(epoch: number) {
  const date = new Date(epoch)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
const lastPathSegment = (path: string | null) => path?.split('/').filter(Boolean).at(-1) ?? null
/** Conversation and agent keys are JSON arrays: ["conversation", "<platform>", "<session uuid>"]. */
function parseRecordKey(key: string): string[] {
  const parsed: unknown = JSON.parse(key)
  if (!Array.isArray(parsed)) throw new Error(`Record key is not an array: ${key}`)
  return parsed.map(String)
}

/**
 * One agent as the screens show it. A subagent carries its recorded status (which is what marks it as one, data.ts
 * isSubagent), its stop's time, its parent where the recorded session links them, and the short task title its
 * launch recorded (`launch.description`; never `launch.prompt`, the whole task text). A main agent's session start is
 * added by toWorkModel only where two main agents would read the same (sessionsThatTellAgentsApart).
 */
export function toAgent(agent: WorkViewAgent, parentId?: string): Agent {
  const tool = KNOWN_TOOLS.includes(agent.platformSource as AgentTool) ? agent.platformSource as AgentTool : 'other'
  const mapped: Agent = { id: agent.id, tool, name: agent.label, role: agent.sessionTitle ?? lastPathSegment(agent.project) ?? RECORDED_SESSION_ROLE, deviceId: THIS_COMPUTER.id }
  if (!agent.isSubagent) return mapped
  const finished = agent.presence?.status === 'finished'
  const finishedAt = finished && agent.presence?.finishedAt ? Date.parse(agent.presence.finishedAt) : NaN
  // The worker cuts it to 160 characters (agent-view.mjs readAgentLaunches); the screens cut it to one line.
  const launchDescription = cleanText(agent.launch?.description, 160)
  return {
    ...mapped,
    status: finished ? 'finished' : agent.presence?.status === 'recent' ? 'working' : 'quiet',
    ...(Number.isFinite(finishedAt) ? { finishedAt: formatDateTime(finishedAt), finishedAtIso: new Date(finishedAt).toISOString() } : {}),
    canMarkFinished: agent.canMarkFinished === true,
    ...(parentId ? { parentId } : {}),
    ...(launchDescription ? { launchDescription } : {}),
  }
}

/**
 * How much of a session id tells two sessions apart: its first 8 characters, a UUID's first block, as a conversation
 * with no title is named ("Conversation 1a2b3c4d", toRequest). Only the short form rides the overview, which has a
 * 300 KiB budget for 140 requests (docs/development/viewer-sync-recovery.md).
 */
const SESSION_SHORT_ID_CHARS = 8

/**
 * The start of each main agent's session, by agent id, for the main agents whose card would read the same as another's:
 * the same name and role on the same machine (several sessions in one folder; By agent's card header shows those).
 * Every other agent gets none, so the overview carries the fact only where it tells cards apart.
 */
export function sessionsThatTellAgentsApart(raw: WorkViewAgent[], mapped: Agent[]): Map<string, string> {
  const headerOf = (agent: Agent) => JSON.stringify([agent.name, agent.role, agent.deviceId])
  const mains = mapped.filter((agent) => agent.status === undefined)
  const counts = new Map<string, number>()
  for (const agent of mains) counts.set(headerOf(agent), (counts.get(headerOf(agent)) ?? 0) + 1)
  const sessions = new Map(raw.map((agent) => [agent.id, agent.contentSessionId]))
  const shortIds = new Map<string, string>()
  for (const agent of mains) {
    const session = sessions.get(agent.id)
    if (counts.get(headerOf(agent))! > 1 && session) shortIds.set(agent.id, session.slice(0, SESSION_SHORT_ID_CHARS))
  }
  return shortIds
}

/**
 * Each subagent's parent, by agent id: the main agent of the conversation the subagent ran in (agent-view.mjs: a
 * subagent works inside its parent's conversation, and its group carries that conversation's platform and session).
 * Linked only when exactly one main agent of that platform and session is in the snapshot; with none, or with two
 * (a session seen twice), the subagent has no parent here. Read from the recorded session only, never from names,
 * folders or roles, which several unrelated agents can share.
 */
export function subagentParents(agents: WorkViewAgent[]): Map<string, string> {
  const sessionKey = (agent: WorkViewAgent) => JSON.stringify([agent.platformSource, agent.contentSessionId])
  const mainsBySession = new Map<string, string[]>()
  for (const agent of agents) {
    if (agent.isSubagent || !agent.contentSessionId) continue
    mainsBySession.set(sessionKey(agent), [...(mainsBySession.get(sessionKey(agent)) ?? []), agent.id])
  }
  const parents = new Map<string, string>()
  for (const agent of agents) {
    if (!agent.isSubagent || !agent.contentSessionId) continue
    const mains = mainsBySession.get(sessionKey(agent)) ?? []
    if (mains.length === 1) parents.set(agent.id, mains[0])
  }
  return parents
}

/**
 * The next step a request carries, as values the screens word (data.ts NextStepKind): a checked result is the owner's
 * to ship; a blocked one puts its recorded step on them as one that unblocks it; with no recorded step it carries why
 * (decision G3). Never English text.
 */
function nextStepFor(status: NormalizedStatus, who: NextStep['who'], recordedNext: string | null, missing: NextStepMissing): NextStep {
  if (status === 'checked') return { who, kind: 'ship' }
  const kind = status === 'blocked' ? { kind: 'unblock' as const } : {}
  return recordedNext === null ? { who, ...kind, missing } : { who, ...kind, text: recordedNext }
}

/**
 * The review's milestones, oldest first, as build-story steps. Every milestone already happened. A step's time is a
 * value: the formatted time, or null when the review recorded none, which the drawer words (never English here).
 */
function storySteps(progress: WorkViewProgress, now: number): Request['story'] {
  return [...(progress.milestones ?? [])]
    .sort((a, b) => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0))
    .map((milestone) => {
      const at = Date.parse(milestone.at ?? '')
      return { label: cleanText(milestone.text, 200), at: Number.isFinite(at) ? formatRecordTime(at, now) : null, ...(Number.isFinite(at) ? { atIso: isoOf(at) } : {}), status: 'complete' as const }
    })
    .filter((step) => step.label)
}

/** The worker's check route uses the same rule (WorkViewRoutes.ts reviewIsNewerThanLifecycle). */
function reviewIsNewerThanLifecycle(review: Pick<WorkViewProgress, 'checkedAt'>, lifecycle: WorkViewHumanRequest['lifecycle']): boolean {
  if (!lifecycle?.explicit || !lifecycle.atEpoch) return true
  const reviewedAt = Date.parse(review.checkedAt ?? '')
  return Number.isFinite(reviewedAt) && reviewedAt >= lifecycle.atEpoch
}

/** One human request → one Request. Its area follows merges; a placement in no live area reads "Not sorted yet" (absent).
 * Throws when the result breaks the lifecycle rules; the caller turns that into a read-error card. */
function toRequest(raw: WorkViewHumanRequest, agents: WorkViewAgent[], now: number, resolveArea: ReturnType<typeof createFocusAreaResolver>): Request {
  const copy = raw.humanCopy
  const copyReady = !!copy && ['current', 'outdated'].includes(copy.state)
  const generatedTitle = raw.titleSource === 'request-group' || raw.titleSource === 'title-cache'
  const updatedAt = raw.updatedAtEpoch ?? Math.max(0, ...raw.items.map((item) => item.lastUpdateEpoch || 0))
  const recordedReview = raw.progress ?? null
  // A memory review can be newer than the recorded items: its shipped state and its 100% both count then.
  // An explicit status recorded after the review (a reopen) wins, and the older review cannot claim it finished.
  const reviewCounts = !!recordedReview && reviewIsNewerThanLifecycle(recordedReview, raw.lifecycle)
  const review = reviewCounts || (recordedReview && recordedReview.percent < 100) ? recordedReview : null
  // The owner's move the review recorded holds only while nothing was recorded after what the reviewer saw
  // (reviewedThrough, the comparison request-groups.mjs reviewIsCurrent makes): any later activity clears it until the
  // next review decides it again. A review without reviewedThrough records no move here.
  const currentOwnerMove = reviewCounts && recordedReview.ownerMove && Date.parse(recordedReview.reviewedThrough ?? '') >= updatedAt ? recordedReview.ownerMove : null
  // With only asks, the latest ask is the request's last update.
  const statusItems = raw.items.length ? raw.items : [{ kind: 'prompt', status: '', lastUpdateEpoch: updatedAt }]
  const status = normalizeRequestStatus({ items: statusItems, lifecycle: raw.lifecycle, checked: raw.review?.checked === true, progressState: reviewCounts ? review?.state : null, progressPercent: reviewCounts ? review?.percent : null, ownerMoveRecorded: !!currentOwnerMove }, now)
  const shippedAt = review?.state === 'shipped' && review.shippedAt ? Date.parse(review.shippedAt) : NaN
  const completedEpoch = raw.completedAtEpoch ?? (Number.isFinite(shippedAt) ? shippedAt : null)
  const { state, stage, who } = presentStatus(status, now - updatedAt <= STALE_AFTER_MS)
  // The recorded sentence is the step while the request waits on the owner: their move, or a 100% review to check.
  // 200: the review check's cap for it (request-groups.mjs validateProgress).
  const recordedNext = (currentOwnerMove && (status === 'needs-you' || status === 'needs-review') && cleanText(currentOwnerMove.what, 200))
    || (copyReady && cleanText(copy.next, 240))
    || cleanText(raw.items.find((item) => item.nextStep?.text)?.nextStep?.text, 140)
    || null
  // With no step recorded: did any agent record work (items, activity or a review), or are there only asks?
  const missingNext: NextStepMissing = raw.items.length || raw.activity.length || recordedReview ? 'not-recorded' : 'no-agent-work'
  const agentId = agents.some((agent) => agent.id === raw.agentIds[0]) ? raw.agentIds[0] : UNRECORDED_AGENT.id
  const started = raw.startedAtEpoch
  const reviewedAt = review ? Date.parse(review.checkedAt ?? '') : NaN
  const readings = review?.readings ?? []
  // A recorded ship completes the request at 100%; review readings that stopped short of it are not its trace.
  const readingsStopShort = status === 'shipped' && !!review && review.percent < 100
  // Each source with its kind as a value, which the drawer words in the reader's language (no English kind in its title).
  // The owner's own words come first, as their prompt, whichever record holds them (a prompt, a summary's or a session's
  // request); then each item's record by its kind.
  const evidence: Request['evidence'] = [
    ...(raw.original.url && evidenceKindOf(raw.original.url) ? [{ kind: 'prompt' as const, title: cleanText(raw.original.text, 80), href: raw.original.url }] : []),
    ...raw.items.flatMap((item) => {
      const kind = evidenceKindOf(item.url)
      return kind ? [{ kind, title: cleanText(item.title, 80), href: item.url }] : []
    }),
  ].filter((source, index, all) => all.findIndex((other) => other.href === source.href) === index)
  const focusAreaId = resolveArea(raw.focusAreaId)
  const title = generatedTitle ? raw.title.trim() || null : copyReady && copy.title?.trim() ? copy.title.trim() : null
  // Checked against the full prompts here, since the card's quotes are cut to 400 characters.
  const ownerWords = [raw.original, ...raw.scopeUpdates].map((prompt) => prompt.text ?? '')
  const titleRepeatsPrompt = !!title && repeatsOwnerWords(title, ownerWords)
  const summary = raw.groupId && recordedReview ? (reviewCounts ? recordedReview.summary?.trim() || null : null) : copyReady && copy.summary?.trim() ? copy.summary.trim() : null
  const summaryRepeatsPrompt = !!summary && repeatsOwnerWords(summary, ownerWords)
  // Checked against the recorded text alone, whatever kind of step it is (a blocked request's included).
  // A checked request's step is the owner's ship, not this recorded text.
  const nextRepeatsPrompt = status !== 'checked' && recordedNext !== null && repeatsOwnerWords(recordedNext, ownerWords)

  return assertConsistentRequest({
    id: raw.id,
    contentFingerprint: raw.contentFingerprint,
    // Group reviews already contain display copy; their source is independent of the optional human-copy writer.
    title,
    ...(titleRepeatsPrompt ? { titleRepeatsPrompt } : {}),
    summary,
    ...(summaryRepeatsPrompt ? { summaryRepeatsPrompt } : {}),
    ...(nextRepeatsPrompt ? { nextRepeatsPrompt } : {}),
    stageNote: copy?.stage?.trim() || undefined,
    ...(focusAreaId ? { focusAreaId } : {}),
    // The worker serves it only while it holds in the area the request is in (my-focus.mjs subFocusPlacementFor).
    ...(focusAreaId && raw.subFocusId ? { subFocusId: raw.subFocusId } : {}),
    canMoveFocus: !!raw.anchorConversationKey,
    askedBy: raw.requestedBy ?? SOLO_REQUESTER,
    agentId,
    // Not recorded is null, which the screens word (never English text as data).
    startedAt: started ? formatDateTime(started) : null,
    startedAtIso: started ? new Date(started).toISOString() : undefined,
    runningForMs: started ? (completedEpoch ?? now) - started : null,
    // Counts up only while the request is open: not closed, and not completed by a recorded time or a lifecycle that
    // says complete (the projection's own rule, even when the lifecycle carries no time).
    runningLive: started && completedEpoch === null && status !== 'closed' && raw.lifecycle?.complete !== true ? true : undefined,
    stage,
    state,
    closed: status === 'closed' || undefined,
    // The percent comes only from a memory review. An explicit shipped lifecycle is complete by definition.
    progress: {
      percent: status === 'shipped' ? 100 : review ? review.percent : null,
      readings: review ? Math.max(1, readings.length) : 0,
      reviewedAt: Number.isFinite(reviewedAt) ? formatRecordTime(reviewedAt, now) : 'Not reviewed yet',
      ...(Number.isFinite(reviewedAt) ? { reviewedAtIso: isoOf(reviewedAt) } : {}),
      // A current progress record is one assessment, not an invented historical reading.
      history: readingsStopShort || (review && readings.length === 0) ? undefined : readings.map((reading) => reading.percent),
      completedAt: status === 'shipped' && completedEpoch ? formatDateTime(completedEpoch) : undefined,
      ...(status === 'shipped' && completedEpoch ? { completedAtIso: isoOf(completedEpoch) } : {}),
    },
    estimate: measuredEstimate(readings, status === 'shipped', now),
    next: nextStepFor(status, who, recordedNext, missingNext),
    // No agent activity yet: the card shows the human's own asks instead.
    terminal: raw.activity.length
      ? raw.activity.slice(0, 4).reverse().map((activity) => cleanText(`${activity.kind} ${activity.title}${activity.detail ? `: ${activity.detail}` : ''}`, 160)).filter(Boolean)
      : [raw.original, ...raw.scopeUpdates].slice(-4).map((prompt) => cleanText(`ask ${prompt.text}`, 160)).filter(Boolean),
    activityWord: copyReady ? 'Working' : 'Translating',
    // A title or name that is not recorded is null, which the drawer words (never English text as data).
    workstreams: raw.workstreams.map((stream) => ({
      title: cleanText(copy?.workstreams?.find((entry) => entry.id === stream.id)?.title, 115) || null,
      tasks: stream.items.filter((item) => item.kind === 'work-state').map((item) => ({ name: cleanText(item.title, 160) || null, done: ['done', 'completed'].includes(item.status) })),
    })),
    granular: raw.activity.map((activity) => ({
      kind: activity.kind === 'observation' ? 'memory' as const : 'work' as const,
      text: cleanText(activity.detail ? `${activity.title}: ${activity.detail}` : activity.title, 200),
      at: formatRecordTime(activity.atEpoch, now),
      atIso: isoOf(activity.atEpoch),
      ...(activity.media ? { media: activity.media } : {}),
    })).filter((record) => record.text),
    conversations: raw.conversationKeys.map((key) => {
      const [, platform, sessionId] = parseRecordKey(key)
      const session = agents.find((agent) => agent.platformSource === platform && agent.contentSessionId === sessionId && agent.sessionTitle)
      return {
        tool: PLATFORM_LABEL[platform] ?? UNNAMED_TOOL,
        at: key === raw.id && raw.original.atEpoch ? formatDateTime(raw.original.atEpoch) : TIME_NOT_RECORDED,
        ...(key === raw.id && raw.original.atEpoch ? { atIso: isoOf(raw.original.atEpoch) } : {}),
        // Its session's own title, or null when none is recorded: the screens word that ("{tool} conversation", R2).
        title: session?.sessionTitle ?? null,
        platform,
        conversationSessionId: sessionId,
      }
    }),
    prompts: [raw.original, ...raw.scopeUpdates]
      .map((prompt) => ({ at: prompt.atEpoch ? formatPromptStamp(prompt.atEpoch) : TIME_NOT_RECORDED, quote: cleanText(prompt.text, 400) }))
      .filter((prompt) => prompt.quote),
    workProduct: mapWorkProduct(raw.workProduct),
    ...(raw.media ? { media: raw.media } : {}),
    followUps: [],
    story: review ? storySteps(review, now) : [],
    storyNarrative: review?.narrative?.trim() || undefined,
    evidence,
    checkedAt: raw.review?.checked && raw.review.checkedAtEpoch ? formatDateTime(raw.review.checkedAtEpoch) : undefined,
    ...(raw.review?.checked && raw.review.checkedAtEpoch ? { checkedAtIso: isoOf(raw.review.checkedAtEpoch) } : {}),
    ...(raw.review?.mode ? { review: { mode: raw.review.mode, hash: raw.review.hash ?? null,
      available: raw.review.available, version: raw.review.version, conflict: raw.review.conflict,
      legacy: raw.review.legacy, pending: raw.review.pending, message: raw.review.message } } : {}),
    ...(raw.suggestion ? { suggestion: { conversationKey: raw.suggestion.conversationKey,
      requestId: raw.suggestion.requestId, requestTitle: cleanText(raw.suggestion.requestTitle, 200),
      evidence: cleanText(raw.suggestion.evidence, 500),
      ...(Number.isFinite(raw.suggestion.confidence) ? { confidence: raw.suggestion.confidence } : {}),
      expectedSuggestionHash: raw.suggestion.expectedSuggestionHash, sharedConflict: raw.suggestion.sharedConflict } } : {}),
  })
}

// ---- The owner-goals run, as recorded: the words behind each focus area and ask, and Past focus. Ranks and
// times-asked come from the run; nothing is recounted here.
const GOAL_KINDS: WorkViewGoalItem['kind'][] = ['focus-area', 'ask']
const OWNER_GOALS_SKILL = 'owner-goals'
const RECORDED_PROMPT_TIME = /^\d{4}-(\d{2}-\d{2})(?: (\d{2}:\d{2}))?$/
const RECORDED_DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `YYYY-MM-DD HH:MM` → the `MM-DD HH:MM` stamp goals use; a bare day → `MM-DD`; nothing recorded → ''. */
function toGoalPromptStamp(recordedAt: string | null, whatIsDated: string): string {
  if (recordedAt === null || recordedAt === '') return ''
  const match = RECORDED_PROMPT_TIME.exec(recordedAt)
  if (!match) throw new Error(`${whatIsDated} has an unreadable time: ${recordedAt}`)
  return match[2] ? `${match[1]} ${match[2]}` : match[1]
}

function requireRecordedCount(value: number | null | undefined, whatIsCounted: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${whatIsCounted} is not recorded`)
  return value
}

/** One owner-goals item, as the area header and Past focus read it. `label` is the area it names (or, on items saved
 * before 2026-10-27, the product). */
function toGoalItem(item: WorkViewGoalItem): MinedGoalItem & { label: string } {
  if (!GOAL_KINDS.includes(item.kind)) throw new Error(`Owner-goals item "${item.title}" has an unknown kind: ${item.kind}`)
  const what = `${item.kind === 'ask' ? 'ask' : 'focus area'} "${item.title}"`
  requireRecordedCount(item.rank, `The rank of the ${what}`)
  return {
    id: item.id,
    title: item.title,
    focusAreaId: item.focusAreaId,
    label: item.focusArea ?? item.product ?? (item.kind === 'focus-area' ? 'Focus area' : 'Area not recorded'),
    latestAt: toGoalPromptStamp(item.latestAt, `The ${what}`),
    timesAsked: requireRecordedCount(item.timesAsked, `How often the ${what} was asked`),
    quotes: item.evidence.map((evidence) => ({ at: toGoalPromptStamp(evidence.at, `A quote under the ${what}`), quote: evidence.quote })),
  }
}

/** "Aug 18 – Sep 17" from an exclusive end day; the year is added when the month is not in `currentYear`. */
function periodLabel(periodStart: string, periodEndExclusive: string | null, currentYear: number): string {
  const start = RECORDED_DAY.exec(periodStart)
  if (!start) throw new Error(`A saved owner-goals month has an unreadable start day: ${periodStart}`)
  const startText = `${MONTH_LABELS[Number(start[2]) - 1]} ${Number(start[3])}`
  if (!periodEndExclusive) return Number(start[1]) === currentYear ? `From ${startText}` : `From ${startText}, ${start[1]}`
  if (!RECORDED_DAY.test(periodEndExclusive)) throw new Error(`A saved owner-goals month has an unreadable end day: ${periodEndExclusive}`)
  const lastDay = new Date(`${periodEndExclusive}T12:00:00Z`)
  lastDay.setUTCDate(lastDay.getUTCDate() - 1)
  const endText = `${MONTH_LABELS[lastDay.getUTCMonth()]} ${lastDay.getUTCDate()}`
  const startYear = Number(start[1])
  const endYear = lastDay.getUTCFullYear()
  if (startYear === currentYear && endYear === currentYear) return `${startText} – ${endText}`
  return startYear === endYear ? `${startText} – ${endText}, ${endYear}` : `${startText}, ${startYear} – ${endText}, ${endYear}`
}

function toPastPeriod(list: WorkViewGoalList, currentYear: number): PastPeriod {
  const periodStart = list.periodStart ?? list.listName
  return {
    id: list.listName,
    label: periodLabel(periodStart, list.periodEnd, currentYear),
    promptCount: requireRecordedCount(list.sourcePromptCount, `The prompt count for ${list.listName}`),
    headline: list.summary ?? 'No summary recorded for this month.',
    areas: list.areas.map(toGoalItem).map((goal) => ({ title: goal.title, label: goal.label, timesAsked: goal.timesAsked, quote: goal.quotes[0] ?? null })),
  }
}

/** "Oct 18": the day as the run wrote it (its own timezone), not converted to the viewer's. */
function recordedDayLabel(generatedAt: string): string {
  const day = RECORDED_DAY.exec(generatedAt.slice(0, 10))
  if (!day) throw new Error(`The ${OWNER_GOALS_SKILL} run has no readable day in generated_at (${generatedAt})`)
  return `${MONTH_LABELS[Number(day[2]) - 1]} ${Number(day[3])}`
}

function generatedAtEpoch(list: WorkViewGoalList): number {
  const epoch = Date.parse(list.generatedAt ?? '')
  if (!Number.isFinite(epoch)) throw new Error(`The ${OWNER_GOALS_SKILL} run has no readable generated_at (${list.generatedAt ?? 'missing'})`)
  return epoch
}

type MappedGoals = Pick<MappedWorkModel, 'currentPeriod' | 'pastPeriods' | 'goalsReadError'> & { minedAreas: MinedGoalItem[]; minedAsks: MinedGoalItem[]; goalsRun: SkillRun | null }
const NO_GOALS: MappedGoals = { minedAreas: [], minedAsks: [], currentPeriod: null, pastPeriods: [], goalsReadError: null, goalsRun: null }

/** The owner-goals run → the words behind areas and asks, and Past focus. A run that can't be read leaves them empty
 * with the reason; the areas and My Work are unaffected. */
function toGoalsModel(goals: WorkViewGoalList | null | undefined, goalHistory: WorkViewGoalList[] | undefined): MappedGoals {
  if (!goals) return NO_GOALS
  try {
    const generatedAt = generatedAtEpoch(goals)
    const windowDays = requireRecordedCount(goals.windowDays, `The ${OWNER_GOALS_SKILL} window`)
    const generatedYear = new Date(generatedAt).getFullYear()
    const currentPeriod: CurrentPeriod = {
      label: goals.periodStart ? periodLabel(goals.periodStart, goals.periodEnd, generatedYear) : `${windowDays} days to ${recordedDayLabel(goals.generatedAt!)}`,
      windowDays,
      promptCount: requireRecordedCount(goals.sourcePromptCount, `The ${OWNER_GOALS_SKILL} prompt count`),
    }
    return {
      minedAreas: goals.areas.map(toGoalItem),
      minedAsks: goals.asks.map(toGoalItem),
      currentPeriod,
      pastPeriods: (goalHistory ?? []).map((list) => toPastPeriod(list, generatedYear)),
      goalsReadError: null,
      goalsRun: { label: OWNER_GOALS_SKILL, lastRunAt: formatDateTime(generatedAt), lastRunAtIso: isoOf(generatedAt), deviceName: THIS_COMPUTER.name.toLowerCase() },
    }
  } catch (error) {
    return { ...NO_GOALS, goalsReadError: error instanceof Error ? error.message : String(error) }
  }
}

// ---- My Rules: story suggestions with the owner's saved decisions (plan Phase 8). Nothing is re-scored here.
const REQUEST_PROGRESS_SKILL = 'request-progress'
const RULE_SOURCES: Record<string, OwnerRule['source']> = { 'request-progress': 'request-progress', 'owner-goals': 'owner-goals', you: 'you' }
const QUOTE_KINDS: RuleQuote['kind'][] = ['directive', 'correction', 'praise', 'frustration']
const DAY_MS = 86_400_000

/** One saved or suggested rule → the OwnerRule My Rules shows. Throws on a value it can't read honestly. */
function toOwnerRule(rule: WorkViewRule, now: number): OwnerRule {
  const source = RULE_SOURCES[rule.source]
  if (!source) throw new Error(`Rule "${rule.then}" has an unknown source: ${rule.source}`)
  const latest = Date.parse(rule.latestAt ?? '')
  // A time that is not recorded is null, which My Rules words in the reader's language (never English text as data).
  const quotes = rule.quotes.map((quote): RuleQuote => {
    const at = Date.parse(quote.at ?? '')
    return { at: Number.isFinite(at) ? formatDateTime(at) : null, ...(Number.isFinite(at) ? { atIso: isoOf(at) } : {}), quote: quote.quote, kind: QUOTE_KINDS.includes(quote.kind as RuleQuote['kind']) ? quote.kind as RuleQuote['kind'] : 'directive', where: 'prompt' }
  })
  const savedAt = Date.parse(rule.savedAt ?? '')
  // Each record also says what it is (`fact`), so My Rules words it in the reader's language and shows a prompt in
  // full; `label` stays the English line older screens read.
  const records: RuleRecord[] = [
    ...quotes.map((quote): RuleRecord => ({ kind: 'Prompt', label: `Your prompt: “${cleanText(quote.quote, 60)}”`, at: quote.at, ...(quote.atIso ? { atIso: quote.atIso } : {}), fact: 'your-prompt', said: quote.quote })),
    ...(source === 'request-progress' ? [{ kind: 'Review', label: 'request-progress · build story', at: Number.isFinite(latest) ? formatDateTime(latest) : null, ...(Number.isFinite(latest) ? { atIso: isoOf(latest) } : {}), fact: 'build-story' } satisfies RuleRecord] : []),
    ...(Number.isFinite(savedAt) ? [{ kind: 'Instructions', label: source === 'you' ? 'Written in My Rules on this computer' : 'Saved in My Rules on this computer', at: formatDateTime(savedAt), atIso: isoOf(savedAt), fact: source === 'you' ? 'written-here' : 'saved-here' } satisfies RuleRecord] : []),
  ]
  const replacedAt = Date.parse(rule.replacedAt ?? '')
  return {
    id: rule.ruleId,
    scopeId: rule.scopeId,
    setBy: rule.setBy,
    when: rule.when,
    then: rule.then,
    quotes,
    quotesOmitted: rule.quotesOmitted ?? 0,
    timesSeen: rule.timesSeen,
    latestAt: Number.isFinite(latest) ? formatRecordTime(latest, now) : null,
    ...(Number.isFinite(latest) ? { latestAtIso: isoOf(latest) } : {}),
    // Only orders rules by strength; an unrecorded date counts as a year old rather than as recent.
    latestDaysAgo: Number.isFinite(latest) ? Math.max(0, (now - latest) / DAY_MS) : 365,
    source,
    status: rule.status,
    replacedBy: rule.replacedBy ? { ruleId: rule.replacedBy, at: Number.isFinite(replacedAt) ? formatRecordTime(replacedAt, now) : null, ...(Number.isFinite(replacedAt) ? { atIso: isoOf(replacedAt) } : {}) } : undefined,
    records,
  }
}

type MappedRules = Pick<MappedWorkModel, 'rules' | 'ruleScopes' | 'rulesLearning' | 'rulesFile' | 'rulesReadError'> & { progressRun: SkillRun | null }

/** The saved rules and the build story's suggestions → My Rules. Unreadable rules empty My Rules with the reason. */
function toRulesModel(snapshot: Pick<WorkViewSnapshot, 'rules' | 'ruleScopes' | 'rulesLearning' | 'rulesFile'>, now: number): MappedRules {
  const learning = snapshot.rulesLearning ?? null
  const writtenAt = Date.parse(learning?.writtenAt ?? '')
  const progressRun = Number.isFinite(writtenAt) ? { label: REQUEST_PROGRESS_SKILL, lastRunAt: formatDateTime(writtenAt), lastRunAtIso: isoOf(writtenAt), deviceName: THIS_COMPUTER.name.toLowerCase() } : null
  const base = {
    ruleScopes: snapshot.ruleScopes ?? [],
    rulesLearning: learning ? { preferencesFound: learning.preferencesFound, newSuggestions: learning.newSuggestions, reviewsRead: learning.reviewsRead } : null,
    rulesFile: snapshot.rulesFile ?? null,
    progressRun,
  }
  try {
    const rules = (snapshot.rules ?? []).map((rule) => toOwnerRule(rule, now))
    const missingScope = rules.find((rule) => !base.ruleScopes.some((scope) => scope.id === rule.scopeId))
    if (missingScope) throw new Error(`Rule "${missingScope.then}" is in a scope the worker did not list: ${missingScope.scopeId}`)
    return { ...base, rules, rulesReadError: null }
  } catch (error) {
    return { ...base, rules: [], rulesReadError: error instanceof Error ? error.message : String(error) }
  }
}

/** refresh.json as My Work shows it: no tokens, costs or internal fields. */
function toAutoRefresh(raw: WorkViewRefresh | null): AutoRefresh | null {
  if (!raw) return null
  const finished = Date.parse(raw.finishedAt ?? '')
  return {
    state: raw.state,
    finishedAt: Number.isFinite(finished) ? formatDateTime(finished) : null,
    error: raw.state === 'failed' || raw.state === 'waiting-for-agent' ? raw.error?.trim() || null : null,
    ...(Number.isFinite(finished) ? { finishedAtIso: new Date(finished).toISOString() } : {}),
  }
}

/** The build story request-progress wrote: its first paragraph is My Work's recap. No story, no recap. */
function toBuildStory(story: WorkViewBuildStory | null, now: number): BuildStory | null {
  const blocks = (story?.narrative ?? '').split(/\n\s*\n/).map((block) => block.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim()).filter(Boolean)
  // Chapter headings stay in the story as plain lines; the recap is the first real paragraph.
  const recap = blocks.find((block) => !block.startsWith('#'))
  if (!recap) return null
  const paragraphs = blocks.map((block) => block.replace(/^#+\s*/, ''))
  // Which blocks were headings: the sheet draws them as headings over their paragraphs (c-work-story-sheet).
  const chapters: StoryChapter[] = []
  for (const block of blocks) {
    if (block.startsWith('#')) chapters.push({ heading: block.replace(/^#+\s*/, ''), paragraphs: [] })
    else if (chapters.length) chapters[chapters.length - 1].paragraphs.push(block)
    else chapters.push({ heading: null, paragraphs: [block] })
  }
  const writtenAt = Date.parse(story?.writtenAt ?? '')
  // The ISO time too: it dates the headings' UTC days and times, which the page shows in the reader's own clock.
  const written = Number.isFinite(writtenAt)
  return { recap, paragraphs, writtenAt: written ? formatRecordTime(writtenAt, now) : null, ...(written ? { writtenAtIso: new Date(writtenAt).toISOString() } : {}), chapters }
}

export function toWorkModel(snapshot: WorkViewSnapshot, now: number): MappedWorkModel {
  if (!Array.isArray(snapshot?.humanRequests) || typeof snapshot.source?.connected !== 'boolean') {
    throw new Error('The work view has no humanRequests list or no source health')
  }
  const requests: Request[] = []
  const requestReadErrors: RequestReadError[] = []
  const { goalsRun, minedAreas, minedAsks, ...goalsModel } = toGoalsModel(snapshot.goals, snapshot.goalHistory)
  const { focusAreas, otherAsks } = toFocusModel(snapshot.focusAreas, minedAreas, minedAsks)
  const resolveArea = createFocusAreaResolver(focusAreas)
  for (const raw of snapshot.humanRequests) {
    try {
      requests.push(toRequest(raw, snapshot.agents, now, resolveArea))
    } catch (error) {
      requestReadErrors.push({
        requestId: raw.id,
        title: raw.humanCopy?.title?.trim() || null,
        reason: error instanceof Error ? error.message : String(error),
        // Linked only to a record the evidence route serves (one of its kinds), so the card never links a route that is not there.
        evidenceHref: raw.original?.url && routeKindOf(raw.original.url) ? raw.original.url : null,
      })
    }
  }
  const { progressRun, ...rulesModel } = toRulesModel(snapshot, now)
  const parents = subagentParents(snapshot.agents)
  const mappedAgents = snapshot.agents.map((agent) => toAgent(agent, parents.get(agent.id)))
  const sessionShortIds = sessionsThatTellAgentsApart(snapshot.agents, mappedAgents)
  const agents = mappedAgents.map((agent) => sessionShortIds.has(agent.id) ? { ...agent, sessionShortId: sessionShortIds.get(agent.id)! } : agent)
  if (requests.some((request) => request.agentId === UNRECORDED_AGENT.id)) agents.push(UNRECORDED_AGENT)
  return {
    sourceKind: 'local',
    requests,
    requestReadErrors,
    agents,
    devices: [THIS_COMPUTER],
    people: [...new Set(requests.map((request) => request.askedBy))],
    unlinkedWorkCount: Array.isArray(snapshot.unlinkedWork) ? snapshot.unlinkedWork.length : 0,
    sourceHealth: { connected: snapshot.source.connected, error: snapshot.source.error },
    ...(snapshot.sharedState ? { sharedState: snapshot.sharedState } : {}),
    ...goalsModel,
    focusAreas,
    otherAsks,
    ...rulesModel,
    buildStory: toBuildStory(snapshot.story?.story ?? null, now),
    lastRuns: { goals: goalsRun, progress: progressRun },
    refresh: toAutoRefresh(snapshot.refresh ?? null),
  }
}
