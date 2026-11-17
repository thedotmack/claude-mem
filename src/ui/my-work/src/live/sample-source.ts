// The wireframe fixtures as a data source, for design review (`?source=sample`). Nothing here is real.
import { assertConsistentRequest, OTHER_FOCUS_AREA_ID, SAMPLE_AGENTS, SAMPLE_DEVICES, SAMPLE_PEOPLE, SAMPLE_REQUESTS, SAMPLE_RUNS, type Agent, type FocusArea, type FocusChange, type Request } from '../data.ts'
import { SAMPLE_CURRENT_PERIOD, SAMPLE_FOCUS_AREAS, SAMPLE_OTHER_ASKS, SAMPLE_PAST_PERIODS } from '../data-goals.ts'
import { SAMPLE_OWNER_RULES, SAMPLE_RULE_SCOPES, SAMPLE_RULES_LEARNING, type OwnerRule, type RuleChange, type RuleScope } from '../data-rules.ts'
import { getConnectionStatus } from './connection-status.ts'
import { byFocusPriority } from './to-focus-model.ts'
import { navWordIn } from '../../../../services/work-view/nav-words.mjs'
import type { RequestReadError, WorkDataSource, WorkModel } from './work-data-source.ts'

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
function applySampleFocusChange({ action, focusAreaId, name, goal, intoFocusAreaId, focusAreaIds, requestId }: FocusChange) {
  const trimmedName = name?.trim(), trimmedGoal = goal?.trim()
  if (trimmedName !== undefined && (!trimmedName || trimmedName.length > MAX_AREA_NAME_CHARS)) throw new Error('ValidationError')
  if (trimmedGoal !== undefined && (!trimmedGoal || trimmedGoal.length > MAX_AREA_GOAL_CHARS)) throw new Error('ValidationError')
  const byId = new Map(sampleFocusAreas.map((area) => [area.id, area]))
  const replace = (id: string, change: Partial<FocusArea>) => { sampleFocusAreas = sampleFocusAreas.map((area) => area.id === id ? { ...area, ...change } : area).sort(byFocusPriority) }
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
 *   one whose parent is not recorded (By agent's nesting, its "Subagent" label, and Mark finished with its confirm).
 */
export const SAMPLE_STATES = ['rules-unreadable', 'refresh-failed', 'rule-saves-fail', 'months-unreadable', 'read-errors', 'subagents'] as const
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

const sampleModel = (sampleState: SampleState | null): WorkModel => ({
  sourceKind: 'sample',
  requests: [...SAMPLE_REQUESTS],
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
