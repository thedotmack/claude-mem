// The wireframe fixtures as a data source, for design review (`?source=sample`). Nothing here is real.
import { assertConsistentRequest, OTHER_FOCUS_AREA_ID, SAMPLE_AGENTS, SAMPLE_DEVICES, SAMPLE_PEOPLE, SAMPLE_REQUESTS, SAMPLE_RUNS, type Agent, type FocusArea, type FocusChange, type Request } from '../data.ts'
import { SAMPLE_CURRENT_PERIOD, SAMPLE_FOCUS_AREAS, SAMPLE_OTHER_ASKS, SAMPLE_PAST_PERIODS } from '../data-goals.ts'
import { SAMPLE_OWNER_RULES, SAMPLE_RULE_SCOPES, SAMPLE_RULES_LEARNING, type OwnerRule, type RuleChange, type RuleScope } from '../data-rules.ts'
import { getConnectionStatus } from './connection-status.ts'
import { answerFocusShareCallsInPage, type FocusShare, type FocusShareAnswerInPage, type FocusShareComment } from './focus-shares.ts'
import { byFocusPriority, resolveFocusAreaId } from './to-focus-model.ts'
import { WORK_VIEW_FOCUS_ACTIONS } from '../../../../shared/work-view-focus-actions.ts'
import { TIME_NOT_RECORDED } from './to-work-model.ts'
import { navWordIn } from '../../../../services/work-view/nav-words.mjs'
import { doneAtAfterChange } from '../../../../services/work-view/focus-done-date.mjs'
import type { ConversationContinuationRead, ConversationContinuationSource, RequestReadError, WorkDataSource, WorkModel } from './work-data-source.ts'

/** Each checked sample request as it was before its check, so Undo restores it exactly. In memory only. */
const sampleRequestsBeforeCheck = new Map<string, Request>()

/** The sample rules as changed this session. In memory only, like the sample checks. */
let sampleRules: OwnerRule[] = [...SAMPLE_OWNER_RULES]
let sampleRuleScopes: RuleScope[] = [...SAMPLE_RULE_SCOPES]
let addedSampleRules = 0
const sampleDeviceName = (deviceId: string) => SAMPLE_DEVICES.find((device) => device.id === deviceId)!.name

/** The same change the worker saves, applied to the sample rules (see WorkViewRoutes `saveRule`). */
function applySampleRuleChange({ action, ruleId, rule }: RuleChange) {
  const index = sampleRules.findIndex((entry) => entry.id === ruleId)
  const current = sampleRules[index]
  if (action !== 'add' && !current) throw new Error(`No sample rule ${ruleId}`)
  let scopeId = current?.scopeId ?? 'everywhere'
  if (rule) {
    const name = rule.scopeTier === 'everywhere' ? 'Everywhere' : rule.scopeName.trim()
    const scope = sampleRuleScopes.find((entry) => entry.tier === rule.scopeTier && entry.name === name)
    scopeId = scope?.id ?? `${rule.scopeTier}:${name}`
    if (!scope) sampleRuleScopes = [...sampleRuleScopes, { id: scopeId, tier: rule.scopeTier, name }]
  }
  const written = rule ? { scopeId, when: rule.when.trim(), then: rule.then.trim() } : {}
  const ownRule = (): OwnerRule => ({ id: `added-${addedSampleRules++}`, scopeId, setBy: 'owner', when: '', then: '', ...written, quotes: [], timesSeen: 1, latestAt: 'today', latestDaysAgo: 0, source: 'you', status: 'on', records: [{ kind: 'Instructions', label: 'Written in My Rules', at: 'today' }] })
  const replaceAt = (next: OwnerRule) => { sampleRules = sampleRules.map((entry, at) => at === index ? next : entry) }
  if (action === 'add') sampleRules = [...sampleRules, ownRule()]
  else if (action === 'replace') {
    const replacement = ownRule()
    replaceAt({ ...current, status: 'replaced', replacedBy: { ruleId: replacement.id, at: 'today' } })
    sampleRules = [...sampleRules, replacement]
  } else if (action === 'approve') replaceAt({ ...current, ...written, setBy: current.setBy === 'learned' ? 'approved' : current.setBy, status: 'on' })
  else if (action === 'edit') replaceAt({ ...current, ...written })
  else if (action === 'turn-on' || action === 'turn-off') replaceAt({ ...current, status: action === 'turn-on' ? 'on' : 'off' })
  else if (action === 'dismiss') {
    if (current.source === 'you') sampleRules = sampleRules.filter((entry) => entry.id !== ruleId)
    else replaceAt({ ...current, status: 'dismissed' })
  } else replaceAt(SAMPLE_OWNER_RULES.find((entry) => entry.id === ruleId) ?? (() => { throw new Error(`Sample rule ${ruleId} was never a suggestion`) })())
}

/** The sample areas as changed this session, in the worker's order from the start. In memory only, like the sample rules. */
let sampleFocusAreas: FocusArea[] = [...SAMPLE_FOCUS_AREAS].sort(byFocusPriority)

/** The worker's body bounds (WorkViewRoutes focusBody): a name is a nav label, a goal one sentence. */
const MAX_AREA_NAME_CHARS = 80
const MAX_AREA_GOAL_CHARS = 300

/**
 * The same change the worker saves, applied to the sample areas (WorkViewRoutes `saveFocus`), with the worker's
 * refusals word for word. A body the worker's schema would refuse answers its "ValidationError".
 */
function applySampleFocusChange({ action, focusAreaId, subFocusId, intoSubFocusId, name, goal, intoFocusAreaId, focusAreaIds, requestId }: FocusChange) {
  // Before any lookup, so an action the worker does not know is never answered as a missing area.
  if (!WORK_VIEW_FOCUS_ACTIONS.includes(action)) throw new Error(`Unknown focus change: ${String(action)}`)
  const trimmedName = name?.trim(), trimmedGoal = goal?.trim()
  if (trimmedName !== undefined && (!trimmedName || trimmedName.length > MAX_AREA_NAME_CHARS)) throw new Error('ValidationError')
  if (trimmedGoal !== undefined && (!trimmedGoal || trimmedGoal.length > MAX_AREA_GOAL_CHARS)) throw new Error('ValidationError')
  const byId = new Map(sampleFocusAreas.map((area) => [area.id, area]))
  // When it was marked done, by the worker's own rule (focus-done-date.mjs, which its reducer dates every area with).
  const replace = (id: string, change: Partial<FocusArea>) => {
    sampleFocusAreas = sampleFocusAreas.map((area) => {
      if (area.id !== id) return area
      const next = { ...area, ...change }
      return { ...next, doneAt: doneAtAfterChange({ statusBefore: area.status, doneAtBefore: area.doneAt ?? null, statusAfter: next.status, changedAt: new Date().toISOString() }) }
    }).sort(byFocusPriority)
  }
  const stillInFocus = (area: FocusArea | undefined) => !!area && area.status !== 'dismissed' && !area.mergedInto
  if (action === 'reorder') {
    if (!focusAreaIds) throw new Error('List the focus areas in the order you want.')
    if (new Set(focusAreaIds).size !== focusAreaIds.length) throw new Error('Each focus area can appear once in the order.')
    if (focusAreaIds.some((id) => !byId.has(id))) throw new Error('That focus area is not in your focus areas.')
    // Kept areas only: an owner order on a suggestion would freeze it against later refreshes.
    const kept = sampleFocusAreas.filter((area) => area.status === 'kept' && !area.mergedInto).map((area) => area.id)
    if (focusAreaIds.length !== kept.length || !kept.every((id) => focusAreaIds.includes(id))) throw new Error('List every kept focus area, each once, in the order you want.')
    focusAreaIds.forEach((id, index) => replace(id, { ownerRank: index + 1 }))
    return
  }
  if (action === 'move-request') {
    if (!requestId || !focusAreaId) throw new Error('Choose the request and the focus area to move it to.')
    const index = SAMPLE_REQUESTS.findIndex((request) => request.id === requestId)
    if (index < 0) throw new Error('That request is not in your work.')
    if (focusAreaId !== OTHER_FOCUS_AREA_ID) {
      if (!byId.has(focusAreaId)) throw new Error('That focus area is not in your focus areas.')
      if (!stillInFocus(byId.get(focusAreaId))) throw new Error('Move it to an area that is still in your focus.')
    }
    SAMPLE_REQUESTS[index] = { ...SAMPLE_REQUESTS[index], focusAreaId }
    return
  }
  if (action === 'rename-sub-focus' || action === 'merge-sub-focus') {
    // A live sub focus of a live area, as the worker looks it up.
    const owning = sampleFocusAreas.find((entry) => stillInFocus(entry) && entry.subFocuses?.some((subFocus) => subFocus.id === subFocusId))
    const subFocus = owning?.subFocuses?.find((entry) => entry.id === subFocusId)
    if (!owning?.subFocuses || !subFocus) throw new Error('That sub focus is not in your focus areas.')
    if (action === 'rename-sub-focus') {
      if (!trimmedName) throw new Error('Write the new name before saving it.')
      replace(owning.id, { subFocuses: owning.subFocuses.map((entry) => entry.id === subFocus.id ? { ...entry, name: trimmedName, decidedBy: 'owner' } : entry) })
      return
    }
    if (!intoSubFocusId) throw new Error('Choose the sub focus to merge it into.')
    if (intoSubFocusId === subFocus.id) throw new Error('A sub focus cannot be merged into itself.')
    if (!owning.subFocuses.some((entry) => entry.id === intoSubFocusId)) throw new Error('Merge it into a sub focus of the same focus area.')
    // A merged sub focus is no longer one of the area's, and its requests show the one it was merged into.
    replace(owning.id, { subFocuses: owning.subFocuses.filter((entry) => entry.id !== subFocus.id) })
    SAMPLE_REQUESTS.forEach((request, index) => { if (request.subFocusId === subFocus.id) SAMPLE_REQUESTS[index] = { ...request, subFocusId: intoSubFocusId } })
    return
  }
  if (action === 'move-to-sub-focus') {
    if (!requestId || subFocusId === undefined) throw new Error('Choose the request and the sub focus to move it to.')
    const index = SAMPLE_REQUESTS.findIndex((request) => request.id === requestId)
    if (index < 0) throw new Error('That request is not in your work.')
    // The request's own area, merges followed; Other and a request not sorted yet have no sub focuses.
    const placedIn = resolveFocusAreaId(SAMPLE_REQUESTS[index].focusAreaId, sampleFocusAreas)
    const placedArea = placedIn && placedIn !== OTHER_FOCUS_AREA_ID ? byId.get(placedIn) : undefined
    if (!placedArea) throw new Error('Put this request in a focus area before choosing its sub focus.')
    if (subFocusId !== null && !placedArea.subFocuses?.some((entry) => entry.id === subFocusId)) throw new Error('Move it to a sub focus of the area it is in.')
    const { subFocusId: _before, ...request } = SAMPLE_REQUESTS[index]
    SAMPLE_REQUESTS[index] = subFocusId === null ? request : { ...request, subFocusId }
    return
  }
  const area = focusAreaId ? byId.get(focusAreaId) : undefined
  if (!area) throw new Error('That focus area is not in your focus areas.')
  if (area.mergedInto && action !== 'restore-suggestion') throw new Error('This area was merged into another. Undo the merge first.')
  if (action === 'keep') replace(area.id, { status: 'kept' })
  else if (action === 'dismiss') replace(area.id, { status: 'dismissed' })
  else if (action === 'done') replace(area.id, { status: 'done' })
  else if (action === 'rename') {
    if (!trimmedName) throw new Error('Write the new name before saving it.')
    const navWord = navWordIn(trimmedName)
    if (navWord) throw new Error(`"${trimmedName}" reuses the nav word "${navWord}". Pick a name that means only this area.`)
    replace(area.id, { name: trimmedName })
  } else if (action === 'edit-goal') {
    if (!trimmedGoal) throw new Error('Write the goal before saving it.')
    replace(area.id, { goal: trimmedGoal })
  } else if (action === 'merge') {
    if (!intoFocusAreaId) throw new Error('Choose the area to merge it into.')
    if (intoFocusAreaId === area.id) throw new Error('An area cannot be merged into itself.')
    const target = byId.get(intoFocusAreaId)
    if (!target) throw new Error('That focus area is not in your focus areas.')
    if (!stillInFocus(target)) throw new Error('Merge it into an area that is still in your focus.')
    replace(area.id, { mergedInto: target.id })
  } else if (action === 'restore-suggestion') {
    if (area.source === 'owner') throw new Error('Only a suggested area can go back to being a suggestion.')
    replace(area.id, { status: 'suggested', mergedInto: null })
  } else {
    throw new Error(`Unknown focus change: ${String(action)}`)
  }
}

/**
 * Sample states the fixtures never reach on their own, chosen with `&sample-state=` on a `?source=sample` address, so
 * every state a page draws can be seen and shot (plan rule 10). The one definition of them:
 * - `rules-unreadable`: My Rules cannot read the saved rules (NoRulesYet's read failure, with Try again);
 * - `refresh-failed`: the last learning run failed, as refresh.json reports it (My Rules' learning-run box);
 * - `rule-saves-fail`: every rule save and "Load my rules into Claude Code" fails, as a refusing worker answers (the
 *   failure lines on My Rules, and where focus stays after a failed decision);
 * - `months-unreadable`: Past focus cannot read the saved months (its read failure, with Try again);
 * - `read-errors`: two requests whose saved records break the lifecycle rules (the board's read-error card, with Try
 *   again and Dismiss); the real data had none when the review looked;
 * - `subagents`: the Claude Code agent's subagents, linked to it as a 16.0.0 worker links them (Agent.parentId), plus
 *   one whose parent is not recorded (By agent's nesting, its "Subagent" label, and Mark finished with its confirm);
 * - `reply-card`: the sample page can continue conversations, as a demonstration that runs no CLI and writes nothing:
 *   the your-move request's reply card answers a running turn with Stop and the exchange before it, a conversation that
 *   cannot be continued, a read that fails, and one ready for a reply whose folder is gone (sampleConversationCalls);
 * - `check-save-waits`: Mark checked (and its Undo) is on its way and stays so: "Saving…", nothing written;
 * - `check-save-fails`: Mark checked (and its Undo) is refused as the worker refuses it: "Not saved", nothing written.
 * - `focus-saves-fail`: every focus area change (Rename, Edit goal, Merge, Mark done, Move up/down, Keep, Dismiss, and
 *   their Undo) is refused as a busy worker refuses it: the change bar's failed row and the dialog's failure line;
 * - `area-shared`: the first kept area is shared by link, with comments on its page, as a demonstration answered in the
 *   page (sampleShareAnswer: nothing is posted, no worker or cmem.ai is asked): the shared mark with its count, the
 *   header's Sharing row and the sharing dialog with its comments;
 * - `share-comments-unreadable`: the same shared area, whose comments read fails (the dialog's plain words and Try again).
 * Reply card to check-save-fails are the drawer's states real data does not reach without writing (plan Phase 5 fix
 * round V5); the last three are the focus area page's (plan Phase 6: the change bar, the share dialog, the shared mark).
 */
export const SAMPLE_STATES = ['rules-unreadable', 'refresh-failed', 'rule-saves-fail', 'months-unreadable', 'read-errors', 'subagents', 'reply-card', 'check-save-waits', 'check-save-fails', 'focus-saves-fail', 'area-shared', 'share-comments-unreadable'] as const
export type SampleState = (typeof SAMPLE_STATES)[number]
/**
 * Read on every load, so a test can switch states with history.replaceState. Node tests have no address (and this file
 * also compiles without the DOM types), so there it is none.
 */
function sampleStateFromAddress(): SampleState | null {
  const search = (globalThis as { location?: { search?: string } }).location?.search
  if (search === undefined) return null
  const asked = new URLSearchParams(search).get('sample-state')
  return SAMPLE_STATES.find((state) => state === asked) ?? null
}
// Shaped like the real failures (to-work-model's unreadable rule, auto-refresh-worker's failed run); neutral words.
const SAMPLE_RULES_READ_ERROR = 'Rule "Keep scratch files inside the project." is in a scope the worker did not list: project:retired-repo'
const SAMPLE_FAILED_REFRESH = {
  state: 'failed' as const,
  finishedAt: 'Oct 20 at 2:11 pm',
  error: 'Claude Code: story (raw answer: ~/.claude-mem/failed-answers/2026-10-20T21-11-12.521Z-story-claude-code.txt): preferences[3].preference is 229 characters; it must be 1–200.',
}
// Shaped like local-source's refused save (postForWorkModel) and a failed CLAUDE.md write; neutral words.
const SAMPLE_RULE_SAVE_REFUSAL = 'The rule change was not saved: SQLITE_BUSY: database is locked (work_state.write rules/autonomy)'
const SAMPLE_RULES_LOAD_REFUSAL = 'Loading the rules was not saved: EACCES: permission denied, open \'~/.claude/CLAUDE.md\''
const SAMPLE_GOALS_READ_ERROR = 'owner-goals/2026-10-18 is unreadable: Unexpected token \'}\' in JSON at position 2214'
// Shaped like the mapper's read errors (to-work-model toWorkModel, data.ts assertConsistentRequest); neutral words. No
// evidence link: in sample mode it would open a record from the person's own worker.
const SAMPLE_READ_ERRORS: RequestReadError[] = [
  { requestId: 'r-unreadable-1', title: 'Move the release notes into the docs site', reason: 'Request r-unreadable-1 is inconsistent: a working request has an agent next step and is not finished', evidenceHref: null },
  { requestId: 'r-unreadable-2', title: null, reason: 'Request r-unreadable-2 is inconsistent: shipped requests are 100% with a completion date', evidenceHref: null },
]

/**
 * The `subagents` state's agents: three subagents of the work viewer's Claude Code, linked to it (one working, one
 * finished, one quiet), and one of the sync agent's whose parent is not recorded. Each has the task title its launch
 * would record, except the quiet linked one, which shows its state only, as a launch recorded without one does. A
 * stop's time is an ISO time worded by the shared formatter, as the mapper's is (live/to-work-model.ts toAgent). Each
 * subagent's recorded stop, as this session's Mark finished saved it, is kept in memory only, like the sample checks.
 */
const sampleSubagent = (id: string, parent: Agent, status: NonNullable<Agent['status']>, linked: boolean, launchDescription?: string): Agent => ({
  id, tool: parent.tool, name: parent.name, role: parent.role, deviceId: parent.deviceId, status,
  canMarkFinished: status !== 'finished', ...(status === 'finished' ? { finishedAtIso: '2026-10-20T13:40:00-07:00' } : {}),
  ...(linked ? { parentId: parent.id } : {}), ...(launchDescription ? { launchDescription } : {}),
})
const SAMPLE_SUBAGENTS: Agent[] = [
  sampleSubagent('claude-subagent-1', SAMPLE_AGENTS[0], 'working', true, 'Check the List rows at 768px'),
  sampleSubagent('claude-subagent-2', SAMPLE_AGENTS[0], 'finished', true, 'Measure the By agent folds'),
  sampleSubagent('claude-subagent-3', SAMPLE_AGENTS[0], 'quiet', true),
  sampleSubagent('claude-sync-subagent-1', SAMPLE_AGENTS[1], 'quiet', false, 'Read the sync queue'),
]
/** Each stop this session's Mark finished saved: the subagent, and when it was saved (an ISO time). */
const sampleAgentStops = new Map<string, string>()
const sampleAgents = (sampleState: SampleState | null): Agent[] => sampleState !== 'subagents' ? SAMPLE_AGENTS
  : [...SAMPLE_AGENTS, ...SAMPLE_SUBAGENTS.map((agent) => {
    const stoppedAtIso = sampleAgentStops.get(agent.id)
    return stoppedAtIso ? { ...agent, status: 'finished' as const, finishedAtIso: stoppedAtIso, canMarkFinished: false } : agent
  })]

// The worker's own words for a check it refuses as it is (WorkViewRoutes review, 409).
const SAMPLE_CHECK_REFUSAL = 'This request has not been reported complete.'

/** The your-move sample request: under `reply-card` its drawer's reply card shows each of the card's states. */
const SAMPLE_REPLY_REQUEST_ID = 'r5'
/** Session ids that are UUIDs, so the card offers to continue each (isContinuableConversation). Fixtures, never real. */
const SAMPLE_REPLY_SESSION = {
  running: 'a17c0001-5e2d-4c3b-9a10-5f6e7d8c9b01',
  cannotContinue: 'b28d0002-6f3e-4d4c-8b21-6a7f8e9dac02',
  readFails: 'c39e0003-7a4f-4e5d-9c32-7b8a9faebd03',
  ready: 'd4af0004-8b5a-4f6e-8d43-8c9bafbfce04',
}
/** In this order, so the card opens on the running turn: the first listed that it can continue (defaultReplyConversation). */
const SAMPLE_REPLY_CONVERSATIONS: Request['conversations'] = [
  { tool: 'Claude Code', at: 'Oct 20, 12:40 pm', title: 'Price page: usage table first', platform: 'claude', conversationSessionId: SAMPLE_REPLY_SESSION.running },
  { tool: 'Codex', at: TIME_NOT_RECORDED, title: null, platform: 'codex', conversationSessionId: SAMPLE_REPLY_SESSION.cannotContinue },
  { tool: 'Claude Code', at: 'Oct 20, 1:05 pm', title: 'Forecast drafts', platform: 'claude', conversationSessionId: SAMPLE_REPLY_SESSION.readFails },
  { tool: 'Claude Code', at: 'Oct 20, 1:22 pm', title: 'Scaling estimates below', platform: 'claude', conversationSessionId: SAMPLE_REPLY_SESSION.ready },
]
const SAMPLE_REPLY_FOLDER = '~/work/admin-pricing'
/** Each demonstration conversation's record, as the worker's guarded read answers it; the read that fails has none. */
const SAMPLE_CONVERSATION_READS: Record<string, ConversationContinuationRead> = {
  [SAMPLE_REPLY_SESSION.running]: {
    target: { canContinue: true, recordedFolder: SAMPLE_REPLY_FOLDER, runsInFolder: SAMPLE_REPLY_FOLDER, recordedFolderIsGone: false, opensInAppNamed: null },
    exchanges: [
      { exchangeId: 1, platform: 'claude', conversationSessionId: SAMPLE_REPLY_SESSION.running, state: 'replied', ownerMessage: 'Which forecast reads better at a glance?',
        replyText: 'The usage-based one: it starts from what you spend today.', startedAtEpochMs: 1_000, endedAtEpochMs: 2_000, ranInFolder: SAMPLE_REPLY_FOLDER },
      { exchangeId: 2, platform: 'claude', conversationSessionId: SAMPLE_REPLY_SESSION.running, state: 'running', ownerMessage: 'Keep the usage-based forecast and remove the other draft.',
        startedAtEpochMs: 3_000, ranInFolder: SAMPLE_REPLY_FOLDER },
    ],
  },
  // Shaped like the worker's refusal for a conversation with no recorded folder (ConversationContinuationRunner).
  [SAMPLE_REPLY_SESSION.cannotContinue]: {
    target: { canContinue: false, refusalText: 'No folder was recorded for this Codex conversation, so it can’t be continued from here.', recordedFolder: null }, exchanges: [],
  },
  [SAMPLE_REPLY_SESSION.ready]: {
    target: { canContinue: true, recordedFolder: '~/work/admin-pricing-scaling', runsInFolder: '~/work', recordedFolderIsGone: true, opensInAppNamed: null }, exchanges: [],
  },
}
// Shaped like local-source's sentence for a read the worker could not answer (conversationRouteFailureSentence).
const SAMPLE_CONVERSATION_READ_FAILURE = 'Could not read this conversation: the worker answered 503 Service Unavailable.'

/**
 * The conversation calls of the `reply-card` sample state: a demonstration that never runs a CLI and writes nothing. A
 * read answers from SAMPLE_CONVERSATION_READS (one fails, as an unavailable worker's does); a Send is refused, saying
 * nothing was sent; a Stop is taken and changes nothing, so the demonstration turn runs on and its Stop waits, as a sent
 * Stop does until the turn ends. No notice ever comes.
 */
const sampleConversationCalls: Pick<ConversationContinuationSource, 'loadConversationContinuation' | 'continueConversation' | 'stopConversationContinuation' | 'subscribeToConversationContinuations'> = {
  async loadConversationContinuation(_platform, conversationSessionId) {
    const read = SAMPLE_CONVERSATION_READS[conversationSessionId]
    if (!read) throw new Error(SAMPLE_CONVERSATION_READ_FAILURE)
    return structuredClone(read)
  },
  async continueConversation() {
    throw new Error('Sample conversations are a demonstration: nothing was sent.')
  },
  async stopConversationContinuation(_platform, conversationSessionId) {
    const running = SAMPLE_CONVERSATION_READS[conversationSessionId]?.exchanges.find((exchange) => exchange.state === 'running')
    if (!running) throw new Error('Nothing sent from here is running in this conversation.')
    return structuredClone(running)
  },
  subscribeToConversationContinuations: () => () => {},
}

// Shaped like local-source's refused save (postForWorkModel) for a focus change; neutral words.
const SAMPLE_FOCUS_SAVE_REFUSAL = 'The focus change was not saved: SQLITE_BUSY: database is locked (work_state.write my-focus)'

/** The area the `area-shared` states share: the sample's first kept area. Its link is a placeholder, never cmem.ai. */
const SAMPLE_SHARED_AREA_ID = 'fa-viewer'
const sampleShareEntry = (focusAreaId: string): FocusShare => ({
  url: `https://example.com/focus/sample-${focusAreaId}`, sharedAt: '2026-10-19T09:00:00-07:00', publishedAt: '2026-10-20T13:50:00-07:00', publishError: null,
})
/** The shares as this session's Share and Stop sharing left them. In memory only, like the sample's other changes. */
const sampleShares = new Map<string, FocusShare>([[SAMPLE_SHARED_AREA_ID, sampleShareEntry(SAMPLE_SHARED_AREA_ID)]])
/** Two comments on the shared page: a person's and an agent's (neutral words). */
const SAMPLE_SHARE_COMMENTS: FocusShareComment[] = [
  { id: 'sample-comment-1', authorKind: 'person', authorName: 'Sam', agentName: null, isOwner: false, body: 'Is the live indicator next, after the list sorting?', createdAt: '2026-10-20T11:05:00-07:00' },
  { id: 'sample-comment-2', authorKind: 'agent', authorName: 'Priya', agentName: 'Claude', isOwner: false, body: 'The list sorting shipped in the live monitor request; the live indicator is still an ask.', createdAt: '2026-10-20T12:40:00-07:00' },
]
// Shaped like the worker's answer when cmem.ai cannot be read (focus-share.ts FocusShareError); neutral words.
const SAMPLE_COMMENTS_READ_FAILURE = 'cmem.ai answered 503 Service Unavailable while reading the comments.'

/**
 * The sharing calls of the `area-shared` and `share-comments-unreadable` states, answered in the page
 * (live/focus-shares.ts answerFocusShareCallsInPage): the shares list and the comments read from the fixtures above, a
 * comment is refused (nothing is posted), and Share and Stop sharing change this session's shares only. No worker or
 * cmem.ai is asked. The comments read fails while the address names `share-comments-unreadable`, read on every call, so
 * a test can switch it with history.replaceState (as sampleStateFromAddress is read on every load).
 */
function sampleShareAnswer(): FocusShareAnswerInPage {
  return async (url, init) => {
    const path = url.split('?')[0]
    const focusAreaId = init ? (init.body as { focusAreaId: string }).focusAreaId : new URLSearchParams(url.split('?')[1] ?? '').get('focusAreaId') ?? ''
    if (!init && path === '/api/work-view/focus/shares') return { connected: true, shares: Object.fromEntries(sampleShares) }
    if (!init && path === '/api/work-view/focus/share/comments') {
      if (sampleStateFromAddress() === 'share-comments-unreadable') throw new Error(SAMPLE_COMMENTS_READ_FAILURE)
      return { comments: sampleShares.has(focusAreaId) ? structuredClone(SAMPLE_SHARE_COMMENTS) : [] }
    }
    if (init && path === '/api/work-view/focus/share/comments') throw new Error('Sample comments are a demonstration: nothing was posted.')
    if (init && path === '/api/work-view/focus/share') {
      const entry = sampleShareEntry(focusAreaId)
      sampleShares.set(focusAreaId, entry)
      return { url: entry.url, sharedAt: entry.sharedAt, publishedAt: entry.publishedAt, sent: false }
    }
    if (init && path === '/api/work-view/focus/share/stop') { sampleShares.delete(focusAreaId); return { stopped: true } }
    throw new Error(`The sample has no answer for ${init ? 'POST' : 'GET'} ${path}`)
  }
}


const sampleModel = (sampleState: SampleState | null): WorkModel => ({
  sourceKind: 'sample',
  requests: sampleState === 'reply-card'
    ? SAMPLE_REQUESTS.map((request) => request.id === SAMPLE_REPLY_REQUEST_ID ? { ...request, conversations: SAMPLE_REPLY_CONVERSATIONS } : request)
    : [...SAMPLE_REQUESTS],
  requestReadErrors: sampleState === 'read-errors' ? SAMPLE_READ_ERRORS : [],
  agents: sampleAgents(sampleState),
  devices: SAMPLE_DEVICES,
  people: SAMPLE_PEOPLE,
  unlinkedWorkCount: 0,
  focusAreas: sampleFocusAreas,
  otherAsks: SAMPLE_OTHER_ASKS,
  currentPeriod: sampleState === 'months-unreadable' ? null : SAMPLE_CURRENT_PERIOD,
  pastPeriods: sampleState === 'months-unreadable' ? [] : SAMPLE_PAST_PERIODS,
  goalsReadError: sampleState === 'months-unreadable' ? SAMPLE_GOALS_READ_ERROR : null,
  rules: sampleState === 'rules-unreadable' ? [] : sampleRules,
  ruleScopes: sampleRuleScopes,
  rulesLearning: SAMPLE_RULES_LEARNING,
  buildStory: {
    recap: 'The spec moved to a wireframe, embeddings moved to their own table, and cloud sync shipped.',
    paragraphs: ['Monday started with the work viewer: cards came back, live updates landed, and the list gained sorting. Midweek went to cloud sync, after write stalls traced back to vector indexes…'],
    writtenAt: SAMPLE_RUNS.progress.lastRunAt,
  },
  // With failing saves, the rules are not loaded yet, so "Load my rules into Claude Code" shows (and fails).
  rulesFile: { path: '~/.claude-mem/MY-RULES.md', approvedCount: sampleRules.filter((rule) => rule.status === 'on').length, loadedInClaudeCode: sampleState !== 'rule-saves-fail' },
  rulesReadError: sampleState === 'rules-unreadable' ? SAMPLE_RULES_READ_ERROR : null,
  lastRuns: {
    goals: { label: SAMPLE_RUNS.goals.label, lastRunAt: SAMPLE_RUNS.goals.lastRunAt, deviceName: sampleDeviceName(SAMPLE_RUNS.goals.deviceId) },
    progress: { label: SAMPLE_RUNS.progress.label, lastRunAt: SAMPLE_RUNS.progress.lastRunAt, deviceName: sampleDeviceName(SAMPLE_RUNS.progress.deviceId) },
  },
  refresh: sampleState === 'refresh-failed' ? SAMPLE_FAILED_REFRESH : null,
  sourceHealth: { connected: true, error: null },
  // Sample mode demonstrates the indicator (LiveIndicator labels it a demonstration); nothing streams.
  connection: getConnectionStatus({ now: 0 }),
})

const loadSampleWorkModel = async (): Promise<WorkModel> => sampleModel(sampleStateFromAddress())

export const sampleSource: WorkDataSource = {
  sourceKind: 'sample',
  loadWorkModel: loadSampleWorkModel,
  // The sample demo flip (playDemoUpdates) stands in for live updates; there is no feed to subscribe to.
  subscribeToLiveUpdates: () => () => {},

  async saveRuleChange(change) {
    if (sampleStateFromAddress() === 'rule-saves-fail') throw new Error(SAMPLE_RULE_SAVE_REFUSAL)
    applySampleRuleChange(change)
    return { model: await loadSampleWorkModel(), savedRuleId: null }
  },
  async saveFocusChange(change) {
    if (sampleStateFromAddress() === 'focus-saves-fail') throw new Error(SAMPLE_FOCUS_SAVE_REFUSAL)
    applySampleFocusChange(change)
    return loadSampleWorkModel()
  },
  // The sample file is always loaded; there is no CLAUDE.md to change.
  async loadRulesInClaudeCode() {
    if (sampleStateFromAddress() === 'rule-saves-fail') throw new Error(SAMPLE_RULES_LOAD_REFUSAL)
    return loadSampleWorkModel()
  },
  refreshWork: async () => ({ state: 'idle' }),
  // Only the `subagents` state's subagents with no recorded stop have one to record; the other sample agents are
  // fixtures with no recorded state to change.
  async markAgentFinished(agentId) {
    const subagent = SAMPLE_SUBAGENTS.find((agent) => agent.id === agentId)
    if (sampleStateFromAddress() !== 'subagents' || !subagent?.canMarkFinished) throw new Error('Sample agents have no recorded state to change.')
    sampleAgentStops.set(agentId, new Date().toISOString())
    return loadSampleWorkModel()
  },

  /** Checking hands the request back to you to ship; it never marks it shipped. Fixtures have no fingerprint to guard. */
  async setRequestChecked(requestId, _expectedFingerprint, checked) {
    const sampleState = sampleStateFromAddress()
    // A save on its way, to be seen: no answer ever comes, so "Saving…" stays until the page is left. Nothing is written.
    if (sampleState === 'check-save-waits') return new Promise<never>(() => {})
    // A save the worker refuses as it is (409), nothing written: "Not saved", with the worker's words under Details.
    if (sampleState === 'check-save-fails') return { outcome: 'refused', serverMessage: SAMPLE_CHECK_REFUSAL, model: await loadSampleWorkModel() }
    const index = SAMPLE_REQUESTS.findIndex((request) => request.id === requestId)
    if (index < 0) throw new Error(`No sample request ${requestId}`)
    // Mutated in place, so every page reading the fixture objects sees the change.
    if (checked) {
      const request = SAMPLE_REQUESTS[index]
      sampleRequestsBeforeCheck.set(requestId, request)
      SAMPLE_REQUESTS[index] = assertConsistentRequest({ ...request, state: 'your-move', checkedAt: 'just now', next: { who: 'human', kind: 'ship' } })
    } else {
      const requestBeforeCheck = sampleRequestsBeforeCheck.get(requestId)
      if (!requestBeforeCheck) throw new Error(`Sample request ${requestId} has no check to undo`)
      SAMPLE_REQUESTS[index] = requestBeforeCheck
      sampleRequestsBeforeCheck.delete(requestId)
    }
    return { outcome: 'saved', model: await loadSampleWorkModel() }
  },
}

/**
 * The sample source the page's address asks for, chosen once as the page loads (store/index.ts ACTIVE_SOURCE): under
 * `?sample-state=reply-card`, the fixtures plus the conversation calls of a demonstration that runs no CLI and writes
 * nothing (sampleConversationCalls), so the reply card's states can be seen; otherwise sampleSource itself, which cannot
 * continue a conversation, as no page but the one this computer's worker serves can (canContinueConversations).
 */
export function sampleSourceAtThisAddress(): WorkDataSource {
  const sampleState = sampleStateFromAddress()
  // Sharing on the sample page: a demonstration answered in the page, chosen with the address like the reply card.
  if (sampleState === 'area-shared' || sampleState === 'share-comments-unreadable') answerFocusShareCallsInPage(sampleShareAnswer())
  return sampleState === 'reply-card' ? { ...sampleSource, ...sampleConversationCalls } : sampleSource
}
