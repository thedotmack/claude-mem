// The wireframe fixtures as a data source, for design review (`?source=sample`). Nothing here is real.
import { assertConsistentRequest, OTHER_FOCUS_AREA_ID, SAMPLE_AGENTS, SAMPLE_DEVICES, SAMPLE_PEOPLE, SAMPLE_REQUESTS, SAMPLE_RUNS, type FocusArea, type FocusChange, type Request } from '../data.ts'
import { SAMPLE_CURRENT_PERIOD, SAMPLE_FOCUS_AREAS, SAMPLE_OTHER_ASKS, SAMPLE_PAST_PERIODS } from '../data-goals.ts'
import { SAMPLE_OWNER_RULES, SAMPLE_RULE_SCOPES, SAMPLE_RULES_LEARNING, type OwnerRule, type RuleChange, type RuleScope } from '../data-rules.ts'
import { getConnectionStatus } from './connection-status.ts'
import { byFocusPriority } from './to-focus-model.ts'
import { navWordIn } from '../../../../services/work-view/nav-words.mjs'
import type { WorkDataSource, WorkModel } from './work-data-source.ts'

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

const loadSampleWorkModel = async (): Promise<WorkModel> => ({
  sourceKind: 'sample',
  requests: [...SAMPLE_REQUESTS],
  requestReadErrors: [],
  agents: SAMPLE_AGENTS,
  devices: SAMPLE_DEVICES,
  people: SAMPLE_PEOPLE,
  unlinkedWorkCount: 0,
  focusAreas: sampleFocusAreas,
  otherAsks: SAMPLE_OTHER_ASKS,
  currentPeriod: SAMPLE_CURRENT_PERIOD,
  pastPeriods: SAMPLE_PAST_PERIODS,
  goalsReadError: null,
  rules: sampleRules,
  ruleScopes: sampleRuleScopes,
  rulesLearning: SAMPLE_RULES_LEARNING,
  buildStory: {
    recap: 'The spec moved to a wireframe, embeddings moved to their own table, and cloud sync shipped.',
    paragraphs: ['Monday started with the work viewer: cards came back, live updates landed, and the list gained sorting. Midweek went to cloud sync, after write stalls traced back to vector indexes…'],
    writtenAt: SAMPLE_RUNS.progress.lastRunAt,
  },
  rulesFile: { path: '~/.claude-mem/MY-RULES.md', approvedCount: sampleRules.filter((rule) => rule.status === 'on').length, loadedInClaudeCode: true },
  rulesReadError: null,
  lastRuns: {
    goals: { label: SAMPLE_RUNS.goals.label, lastRunAt: SAMPLE_RUNS.goals.lastRunAt, deviceName: sampleDeviceName(SAMPLE_RUNS.goals.deviceId) },
    progress: { label: SAMPLE_RUNS.progress.label, lastRunAt: SAMPLE_RUNS.progress.lastRunAt, deviceName: sampleDeviceName(SAMPLE_RUNS.progress.deviceId) },
  },
  refresh: null,
  sourceHealth: { connected: true, error: null },
  // Sample mode demonstrates the indicator (LiveIndicator labels it a demonstration); nothing streams.
  connection: getConnectionStatus({ now: 0 }),
})

export const sampleSource: WorkDataSource = {
  sourceKind: 'sample',
  loadWorkModel: loadSampleWorkModel,
  // The sample demo flip (playDemoUpdates) stands in for live updates; there is no feed to subscribe to.
  subscribeToLiveUpdates: () => () => {},

  async saveRuleChange(change) {
    applySampleRuleChange(change)
    return { model: await loadSampleWorkModel(), savedRuleId: null }
  },
  async saveFocusChange(change) {
    applySampleFocusChange(change)
    return loadSampleWorkModel()
  },
  // The sample file is always loaded; there is no CLAUDE.md to change.
  loadRulesInClaudeCode: loadSampleWorkModel,
  // Sample agents are fixtures with no recorded state to change.
  markAgentFinished: () => Promise.reject(new Error('Sample agents have no recorded state to change.')),

  /** Checking hands the request back to you to ship; it never marks it shipped. Fixtures have no fingerprint to guard. */
  async setRequestChecked(requestId, _expectedFingerprint, checked) {
    const index = SAMPLE_REQUESTS.findIndex((request) => request.id === requestId)
    if (index < 0) throw new Error(`No sample request ${requestId}`)
    // Mutated in place, so every page reading the fixture objects sees the change.
    if (checked) {
      const request = SAMPLE_REQUESTS[index]
      sampleRequestsBeforeCheck.set(requestId, request)
      SAMPLE_REQUESTS[index] = assertConsistentRequest({ ...request, state: 'your-move', checkedAt: 'just now', next: { who: 'human', text: 'Ship it' } })
    } else {
      const requestBeforeCheck = sampleRequestsBeforeCheck.get(requestId)
      if (!requestBeforeCheck) throw new Error(`Sample request ${requestId} has no check to undo`)
      SAMPLE_REQUESTS[index] = requestBeforeCheck
      sampleRequestsBeforeCheck.delete(requestId)
    }
    return { outcome: 'saved', model: await loadSampleWorkModel() }
  },
}
