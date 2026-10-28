// The one pure mapper from a WorkViewSnapshot (local worker today, cmem.ai later) to the WorkModel the screens use.
// It follows the plan's mapping table. Where the snapshot has no value, the field takes the table's "missing" value;
// nothing is estimated or made up (spec §12). Relative imports with .ts extensions so `node --test` can load it.
import { assertConsistentRequest, type WorkProductKind, type Agent, type AgentTool, type CurrentPeriod, type Device, type FocusArea, type PastPeriod, type Request, type SkillRun } from '../data.ts'
import { resolveFocusAreaId, toFocusModel, type MinedGoalItem } from './to-focus-model.ts'
import { normalizeRequestStatus, presentStatus, STALE_AFTER_MS, type NormalizedStatus } from './status-normalization.ts'
import type { MappedWorkModel, RequestReadError } from './work-data-source.ts'
import type { OwnerRule, RuleQuote, RuleRecord } from '../data-rules.ts'
import type { AutoRefresh, BuildStory } from './work-data-source.ts'
import { measuredEstimate } from './measured-estimate.ts'
import type { WorkViewAgent, WorkViewBuildStory, WorkViewGoalItem, WorkViewGoalList, WorkViewHumanRequest, WorkViewProgress, WorkViewRefresh, WorkViewRule, WorkViewSnapshot, WorkViewWorkProduct } from './work-view-api-types.ts'

export const THIS_COMPUTER: Device = { id: 'this-computer', name: 'This computer', syncedMinutesAgo: 0, online: true }
/** Stands in when a request names no agent the snapshot knows: the card then names the machine (§13.2). */
const UNRECORDED_AGENT: Agent = { id: 'agent-not-recorded', tool: 'other', name: 'Agent not recorded', role: 'Recorded work', deviceId: THIS_COMPUTER.id }
/** In solo mode every human request comes from the owner's own prompts. */
const SOLO_REQUESTER = 'You'
const NEXT_STEP_NOT_RECORDED = 'Next step not recorded'
/** A request is built from its prompts; until an agent records work it has only asks. */
const NO_WORK_YET = 'No agent work recorded yet'
const KNOWN_TOOLS: AgentTool[] = ['claude', 'codex', 'gemini']
const PLATFORM_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' }
const EVIDENCE_URL = /^\/api\/work-view\/evidence\/(work-state|observation|prompt|summary|session)\/\d+$/
// work-product.mjs kinds onto the drawer's kinds; anything unknown is a plain link.
const WORK_PRODUCT_KIND: Record<string, WorkProductKind> = {
  'pull-request': 'PR', commit: 'Commit', branch: 'Branch', artifact: 'Page', page: 'Page', deployment: 'Page',
  deck: 'Deck', document: 'Doc', documentation: 'Doc', image: 'File', video: 'File', spreadsheet: 'File', file: 'File',
}

/** Recorded work product the drawer can show. A local file that is gone is left out; a bucket copy keeps its deliverable mark for the card's front. */
function mapWorkProduct(products: WorkViewWorkProduct[] | undefined): Request['workProduct'] {
  return (products ?? []).filter((product) => product.available !== false).map((product) => ({
    kind: WORK_PRODUCT_KIND[product.kind] ?? 'Link',
    label: cleanText(product.title, 140) || product.kind,
    href: product.url ?? product.fileUrl ?? undefined,
    ...(product.deliverable === true ? { deliverable: true as const } : {}),
  }))
}
const EVIDENCE_KIND_LABEL: Record<string, string> = { 'work-state': 'Work state', observation: 'Observation', prompt: 'Your prompt', summary: 'Session summary', session: 'Session' }

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
function formatDuration(milliseconds: number) {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000))
  if (minutes < 1) return 'Just started'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

const lastPathSegment = (path: string | null) => path?.split('/').filter(Boolean).at(-1) ?? null
/** Conversation and agent keys are JSON arrays: ["conversation", "<platform>", "<session uuid>"]. */
function parseRecordKey(key: string): string[] {
  const parsed: unknown = JSON.parse(key)
  if (!Array.isArray(parsed)) throw new Error(`Record key is not an array: ${key}`)
  return parsed.map(String)
}

export function toAgent(agent: WorkViewAgent): Agent {
  const tool = KNOWN_TOOLS.includes(agent.platformSource as AgentTool) ? agent.platformSource as AgentTool : 'other'
  const mapped: Agent = { id: agent.id, tool, name: agent.label, role: agent.sessionTitle ?? lastPathSegment(agent.project) ?? 'Recorded session', deviceId: THIS_COMPUTER.id }
  if (!agent.isSubagent) return mapped
  const finished = agent.presence?.status === 'finished'
  const finishedAt = finished && agent.presence?.finishedAt ? Date.parse(agent.presence.finishedAt) : NaN
  return {
    ...mapped,
    role: `Subagent · ${mapped.role}`,
    status: finished ? 'finished' : agent.presence?.status === 'recent' ? 'working' : 'quiet',
    ...(Number.isFinite(finishedAt) ? { finishedAt: formatDateTime(finishedAt) } : {}),
    canMarkFinished: agent.canMarkFinished === true,
  }
}

function nextTextFor(status: NormalizedStatus, recordedNext: string) {
  if (status === 'checked') return 'Ship it'
  if (status === 'blocked') return `Unblock: ${recordedNext}`
  return recordedNext
}

/** The review's milestones, oldest first, as build-story steps. Every milestone already happened. */
function storySteps(progress: WorkViewProgress, now: number): Request['story'] {
  return [...progress.milestones]
    .sort((a, b) => (Date.parse(a.at ?? '') || 0) - (Date.parse(b.at ?? '') || 0))
    .map((milestone) => {
      const at = Date.parse(milestone.at ?? '')
      return { label: cleanText(milestone.text, 200), description: Number.isFinite(at) ? formatRecordTime(at, now) : 'Date not recorded', status: 'complete' as const }
    })
    .filter((step) => step.label)
}

/** The worker's check route uses the same rule (WorkViewRoutes.ts reviewIsNewerThanLifecycle). */
function reviewIsNewerThanLifecycle(review: Pick<WorkViewProgress, 'checkedAt'>, lifecycle: WorkViewHumanRequest['lifecycle']): boolean {
  if (!lifecycle?.explicit || !lifecycle.atEpoch) return true
  const reviewedAt = Date.parse(review.checkedAt)
  return Number.isFinite(reviewedAt) && reviewedAt >= lifecycle.atEpoch
}

/** One human request → one Request. Its area follows merges; a placement in no live area reads "Sorting…" (absent).
 * Throws when the result breaks the lifecycle rules; the caller turns that into a read-error card. */
function toRequest(raw: WorkViewHumanRequest, agents: WorkViewAgent[], now: number, focusAreas: readonly FocusArea[] = []): Request {
  const copy = raw.humanCopy
  const copyReady = !!copy && ['current', 'outdated'].includes(copy.state)
  const generatedTitle = raw.titleSource === 'request-group' || raw.titleSource === 'title-cache'
  const updatedAt = raw.updatedAtEpoch ?? Math.max(0, ...raw.items.map((item) => item.lastUpdateEpoch || 0))
  const recordedReview = raw.progress ?? null
  // A memory review can be newer than the recorded items: its shipped state and its 100% both count then.
  // An explicit status recorded after the review (a reopen) wins, and the older review cannot claim it finished.
  const reviewCounts = !!recordedReview && reviewIsNewerThanLifecycle(recordedReview, raw.lifecycle)
  const review = reviewCounts || (recordedReview && recordedReview.percent < 100) ? recordedReview : null
  // With only asks, the latest ask is the request's last update.
  const statusItems = raw.items.length ? raw.items : [{ kind: 'prompt', status: '', lastUpdateEpoch: updatedAt }]
  const status = normalizeRequestStatus({ items: statusItems, lifecycle: raw.lifecycle, checked: raw.review?.checked === true, progressState: reviewCounts ? review?.state : null, progressPercent: reviewCounts ? review?.percent : null }, now)
  const shippedAt = review?.state === 'shipped' && review.shippedAt ? Date.parse(review.shippedAt) : NaN
  const completedEpoch = raw.completedAtEpoch ?? (Number.isFinite(shippedAt) ? shippedAt : null)
  const { state, stage, who } = presentStatus(status, now - updatedAt <= STALE_AFTER_MS)
  const recordedNext = (copyReady && cleanText(copy.next, 240))
    || cleanText(raw.items.find((item) => item.nextStep?.text)?.nextStep?.text, 140)
    || (raw.items.length || raw.activity.length || recordedReview ? NEXT_STEP_NOT_RECORDED : NO_WORK_YET)
  const agentId = agents.some((agent) => agent.id === raw.agentIds[0]) ? raw.agentIds[0] : UNRECORDED_AGENT.id
  const started = raw.startedAtEpoch
  const reviewedAt = review ? Date.parse(review.checkedAt) : NaN
  const readings = review?.readings ?? []
  // A recorded ship completes the request at 100%; review readings that stopped short of it are not its trace.
  const readingsStopShort = status === 'shipped' && !!review && review.percent < 100
  const evidence = [
    ...(raw.original.url ? [{ title: `${EVIDENCE_KIND_LABEL.prompt}: ${cleanText(raw.original.text, 80)}`, href: raw.original.url }] : []),
    ...raw.items.map((item) => ({ title: `${EVIDENCE_KIND_LABEL[item.url.split('/')[4]] ?? 'Record'}: ${cleanText(item.title, 80)}`, href: item.url })),
  ].filter((source, index, all) => EVIDENCE_URL.test(source.href) && all.findIndex((other) => other.href === source.href) === index)
  const focusAreaId = resolveFocusAreaId(raw.focusAreaId, focusAreas)

  return assertConsistentRequest({
    id: raw.id,
    contentFingerprint: raw.contentFingerprint,
    // Group reviews already contain display copy; their source is independent of the optional human-copy writer.
    title: generatedTitle ? raw.title.trim() || null : copyReady && copy.title?.trim() ? copy.title.trim() : null,
    summary: raw.groupId && recordedReview ? (reviewCounts ? recordedReview.summary.trim() || null : null) : copyReady && copy.summary?.trim() ? copy.summary.trim() : null,
    stageNote: copy?.stage?.trim() || undefined,
    ...(focusAreaId ? { focusAreaId } : {}),
    canMoveFocus: !!raw.anchorConversationKey,
    askedBy: raw.requestedBy ?? SOLO_REQUESTER,
    agentId,
    startedAt: started ? formatDateTime(started) : 'Start not recorded',
    startedAtIso: started ? new Date(started).toISOString() : undefined,
    runningFor: started ? formatDuration((completedEpoch ?? now) - started) : 'Not recorded',
    stage,
    state,
    closed: status === 'closed' || undefined,
    // The percent comes only from a memory review. An explicit shipped lifecycle is complete by definition.
    progress: {
      percent: status === 'shipped' ? 100 : review ? review.percent : null,
      readings: review ? Math.max(1, readings.length) : 0,
      reviewedAt: Number.isFinite(reviewedAt) ? formatRecordTime(reviewedAt, now) : 'Not reviewed yet',
      history: readingsStopShort ? undefined : readings.map((reading) => reading.percent),
      completedAt: status === 'shipped' && completedEpoch ? formatDateTime(completedEpoch) : undefined,
    },
    estimate: measuredEstimate(readings, status === 'shipped'),
    next: { who, text: nextTextFor(status, recordedNext) },
    // No agent activity yet: the card shows the human's own asks instead.
    terminal: raw.activity.length
      ? raw.activity.slice(0, 4).reverse().map((activity) => cleanText(`${activity.kind} ${activity.title}${activity.detail ? `: ${activity.detail}` : ''}`, 160)).filter(Boolean)
      : [raw.original, ...raw.scopeUpdates].slice(-4).map((prompt) => cleanText(`ask ${prompt.text}`, 160)).filter(Boolean),
    activityWord: copyReady ? 'Working' : 'Translating',
    workstreams: raw.workstreams.map((stream) => ({
      title: cleanText(copy?.workstreams?.find((entry) => entry.id === stream.id)?.title, 115) || 'Supporting work',
      tasks: stream.items.filter((item) => item.kind === 'work-state').map((item) => ({ name: cleanText(item.title, 160) || 'Untitled task', done: ['done', 'completed'].includes(item.status) })),
    })),
    granular: raw.activity.map((activity) => ({
      kind: activity.kind === 'observation' ? 'memory' as const : 'work' as const,
      text: cleanText(activity.detail ? `${activity.title}: ${activity.detail}` : activity.title, 200),
      at: formatRecordTime(activity.atEpoch, now),
    })).filter((record) => record.text),
    conversations: raw.conversationKeys.map((key) => {
      const [, platform, sessionId] = parseRecordKey(key)
      const session = agents.find((agent) => agent.contentSessionId === sessionId && agent.sessionTitle)
      return {
        tool: PLATFORM_LABEL[platform] ?? 'Agent',
        at: key === raw.id && raw.original.atEpoch ? formatDateTime(raw.original.atEpoch) : 'Time not recorded',
        title: session?.sessionTitle ?? `Conversation ${sessionId.slice(0, 8)}`,
      }
    }),
    prompts: [raw.original, ...raw.scopeUpdates]
      .map((prompt) => ({ at: prompt.atEpoch ? formatPromptStamp(prompt.atEpoch) : 'Time not recorded', quote: cleanText(prompt.text, 400) }))
      .filter((prompt) => prompt.quote),
    workProduct: mapWorkProduct(raw.workProduct),
    followUps: [],
    story: review ? storySteps(review, now) : [],
    storyNarrative: review?.narrative?.trim() || undefined,
    evidence,
    checkedAt: raw.review?.checked && raw.review.checkedAtEpoch ? formatDateTime(raw.review.checkedAtEpoch) : undefined,
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
      goalsRun: { label: OWNER_GOALS_SKILL, lastRunAt: formatDateTime(generatedAt), deviceName: THIS_COMPUTER.name.toLowerCase() },
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
  const quotes = rule.quotes.map((quote): RuleQuote => {
    const at = Date.parse(quote.at ?? '')
    return { at: Number.isFinite(at) ? formatDateTime(at) : 'Time not recorded', quote: quote.quote, kind: QUOTE_KINDS.includes(quote.kind as RuleQuote['kind']) ? quote.kind as RuleQuote['kind'] : 'directive', where: 'prompt' }
  })
  const savedAt = Date.parse(rule.savedAt ?? '')
  const records: RuleRecord[] = [
    ...quotes.map((quote) => ({ kind: 'Prompt' as const, label: `Your prompt: “${cleanText(quote.quote, 60)}”`, at: quote.at })),
    ...(source === 'request-progress' ? [{ kind: 'Review' as const, label: 'request-progress · build story', at: Number.isFinite(latest) ? formatDateTime(latest) : 'Time not recorded' }] : []),
    ...(Number.isFinite(savedAt) ? [{ kind: 'Instructions' as const, label: source === 'you' ? 'Written in My Rules on this computer' : 'Saved in My Rules on this computer', at: formatDateTime(savedAt) }] : []),
  ]
  const replacedAt = Date.parse(rule.replacedAt ?? '')
  return {
    id: rule.ruleId,
    scopeId: rule.scopeId,
    setBy: rule.setBy,
    when: rule.when,
    then: rule.then,
    quotes,
    timesSeen: rule.timesSeen,
    latestAt: Number.isFinite(latest) ? formatRecordTime(latest, now) : 'not recorded',
    // Only orders rules by strength; an unrecorded date counts as a year old rather than as recent.
    latestDaysAgo: Number.isFinite(latest) ? Math.max(0, Math.floor((now - latest) / DAY_MS)) : 365,
    source,
    status: rule.status,
    replacedBy: rule.replacedBy ? { ruleId: rule.replacedBy, at: Number.isFinite(replacedAt) ? formatRecordTime(replacedAt, now) : 'a date not recorded' } : undefined,
    records,
  }
}

type MappedRules = Pick<MappedWorkModel, 'rules' | 'ruleScopes' | 'rulesLearning' | 'rulesFile' | 'rulesReadError'> & { progressRun: SkillRun | null }

/** The saved rules and the build story's suggestions → My Rules. Unreadable rules empty My Rules with the reason. */
function toRulesModel(snapshot: Pick<WorkViewSnapshot, 'rules' | 'ruleScopes' | 'rulesLearning' | 'rulesFile'>, now: number): MappedRules {
  const learning = snapshot.rulesLearning ?? null
  const writtenAt = Date.parse(learning?.writtenAt ?? '')
  const progressRun = Number.isFinite(writtenAt) ? { label: REQUEST_PROGRESS_SKILL, lastRunAt: formatDateTime(writtenAt), deviceName: THIS_COMPUTER.name.toLowerCase() } : null
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
  return { state: raw.state, finishedAt: Number.isFinite(finished) ? formatDateTime(finished) : null, error: raw.state === 'failed' || raw.state === 'waiting-for-agent' ? raw.error?.trim() || null : null }
}

/** The build story request-progress wrote: its first paragraph is My Work's recap. No story, no recap. */
function toBuildStory(story: WorkViewBuildStory | null, now: number): BuildStory | null {
  const blocks = (story?.narrative ?? '').split(/\n\s*\n/).map((block) => block.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim()).filter(Boolean)
  // Chapter headings stay in the story as plain lines; the recap is the first real paragraph.
  const recap = blocks.find((block) => !block.startsWith('#'))
  if (!recap) return null
  const paragraphs = blocks.map((block) => block.replace(/^#+\s*/, ''))
  const writtenAt = Date.parse(story?.writtenAt ?? '')
  return { recap, paragraphs, writtenAt: Number.isFinite(writtenAt) ? formatRecordTime(writtenAt, now) : null }
}

export function toWorkModel(snapshot: WorkViewSnapshot, now: number): MappedWorkModel {
  if (!Array.isArray(snapshot?.humanRequests) || typeof snapshot.source?.connected !== 'boolean') {
    throw new Error('The work view has no humanRequests list or no source health')
  }
  const requests: Request[] = []
  const requestReadErrors: RequestReadError[] = []
  const { goalsRun, minedAreas, minedAsks, ...goalsModel } = toGoalsModel(snapshot.goals, snapshot.goalHistory)
  const { focusAreas, otherAsks } = toFocusModel(snapshot.focusAreas, minedAreas, minedAsks)
  for (const raw of snapshot.humanRequests) {
    try {
      requests.push(toRequest(raw, snapshot.agents, now, focusAreas))
    } catch (error) {
      requestReadErrors.push({
        requestId: raw.id,
        title: raw.humanCopy?.title?.trim() || null,
        reason: error instanceof Error ? error.message : String(error),
        evidenceHref: raw.original?.url && EVIDENCE_URL.test(raw.original.url) ? raw.original.url : null,
      })
    }
  }
  const { progressRun, ...rulesModel } = toRulesModel(snapshot, now)
  const agents = snapshot.agents.map(toAgent)
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
    ...goalsModel,
    focusAreas,
    otherAsks,
    ...rulesModel,
    buildStory: toBuildStory(snapshot.story?.story ?? null, now),
    lastRuns: { goals: goalsRun, progress: progressRun },
    refresh: toAutoRefresh(snapshot.refresh ?? null),
  }
}
