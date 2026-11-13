// The wireframe fixtures as a data source, for design review (`?source=sample`). Nothing here is real.
import { assertConsistentRequest, OTHER_FOCUS_AREA_ID, SAMPLE_AGENTS, SAMPLE_DEVICES, SAMPLE_PEOPLE, SAMPLE_REQUESTS, SAMPLE_RUNS, type FocusArea, type FocusChange, type FocusPlan, type PlanProposal, type Request, type RequestStage, type StageFormatInfo } from '../data.ts'
import { SAMPLE_CURRENT_PERIOD, SAMPLE_FOCUS_AREAS, SAMPLE_OTHER_ASKS, SAMPLE_PAST_PERIODS } from '../data-goals.ts'
import { SAMPLE_OWNER_RULES, SAMPLE_RULE_SCOPES, SAMPLE_RULES_LEARNING, type OwnerRule, type RuleChange, type RuleScope } from '../data-rules.ts'
import { getConnectionStatus } from './connection-status.ts'
import { byFocusPriority } from './to-focus-model.ts'
import { requestChat } from './chat-links.ts'
import { focusPlanSummary } from './owner-runs-model.ts'
import { navWordIn } from '../../../../services/work-view/nav-words.mjs'
import { MAX_FOCUS_NOTES_CHARS } from '../../../../services/work-view/work-state-limits.mjs'
import { sampleStageHref } from './sample-stages.ts'
import { MAX_FOCUS_INITIATIVE_CHARS, initiativeKey } from '../../../../services/work-view/focus-initiative-names.mjs'
import type { OwnerRunStart, WorkDataSource, WorkModel } from './work-data-source.ts'

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
function applySampleFocusChange({ action, focusAreaId, name, goal, notes, initiative, noInitiative, intoFocusAreaId, focusAreaIds, requestId }: FocusChange) {
  const trimmedName = name?.trim(), trimmedGoal = goal?.trim()
  if (trimmedName !== undefined && (!trimmedName || trimmedName.length > MAX_AREA_NAME_CHARS)) throw new Error('ValidationError')
  if (trimmedGoal !== undefined && (!trimmedGoal || trimmedGoal.length > MAX_AREA_GOAL_CHARS)) throw new Error('ValidationError')
  if (notes !== undefined && notes.trim().length > MAX_FOCUS_NOTES_CHARS) throw new Error('ValidationError')
  if (initiative !== undefined && initiative.trim().length > MAX_FOCUS_INITIATIVE_CHARS) throw new Error('ValidationError')
  const byId = new Map(sampleFocusAreas.map((area) => [area.id, area]))
  const replace = (id: string, change: Partial<FocusArea>) => { sampleFocusAreas = sampleFocusAreas.map((area) => area.id === id ? { ...area, ...change } : area).sort(byFocusPriority) }
  const stillInFocus = (area: FocusArea | undefined) => !!area && area.status !== 'dismissed' && !area.mergedInto
  if (action === 'reorder') {
    if (!focusAreaIds) throw new Error('List the focus areas in the order you want.')
    if (new Set(focusAreaIds).size !== focusAreaIds.length) throw new Error('Each focus area can appear once in the order.')
    if (focusAreaIds.some((id) => !byId.has(id))) throw new Error('That focus area is not in your focus areas.')
    // Every kept area, and any suggestion listed with them is kept at its place by the same change.
    const kept = sampleFocusAreas.filter((area) => area.status === 'kept' && !area.mergedInto).map((area) => area.id)
    const others = focusAreaIds.filter((id) => !kept.includes(id)).map((id) => byId.get(id)!)
    if (!kept.every((id) => focusAreaIds.includes(id)) || others.some((area) => area.status !== 'suggested' || area.mergedInto)) throw new Error('List every kept focus area, each once, in the order you want. A suggested area listed with them is kept.')
    focusAreaIds.forEach((id, index) => replace(id, { status: 'kept', ownerRank: index + 1 }))
    return
  }
  if (action === 'set-initiative') {
    if (!focusAreaIds || initiative === undefined) throw new Error('Send the focus areas and the initiative to file them under; an empty name clears it.')
    if (new Set(focusAreaIds).size !== focusAreaIds.length) throw new Error('Each focus area can be filed once.')
    if (focusAreaIds.some((id) => !byId.has(id))) throw new Error('That focus area is not in your focus areas.')
    if (noInitiative && initiative.trim()) throw new Error('An area filed under no initiative carries no name.')
    // As the worker reads it: a name that is already an initiative but for its case keeps the spelling filed first.
    const filed = sampleFocusAreas.find((area) => !focusAreaIds.includes(area.id) && !area.initiativeGuess && area.initiative && initiativeKey(area.initiative) === initiativeKey(initiative))?.initiative ?? initiative.trim()
    for (const id of focusAreaIds) {
      // Cleared: back to the guess the fixture started with.
      const guess = SAMPLE_FOCUS_AREAS.find((area) => area.id === id && area.initiativeGuess)?.initiative
      replace(id, filed ? { initiative: filed, initiativeGuess: undefined, initiativeNone: undefined }
        : noInitiative ? { initiative: undefined, initiativeGuess: undefined, initiativeNone: true }
          : { initiative: guess, initiativeGuess: guess ? true : undefined, initiativeNone: undefined })
    }
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
  } else if (action === 'edit-notes') {
    if (notes === undefined) throw new Error('Send the notes to save; empty notes clear them.')
    replace(area.id, { notes: notes.trim() || null })
  } else if (action === 'merge') {
    if (!intoFocusAreaId) throw new Error('Choose the area to merge it into.')
    if (intoFocusAreaId === area.id) throw new Error('An area cannot be merged into itself.')
    const target = byId.get(intoFocusAreaId)
    if (!target) throw new Error('That focus area is not in your focus areas.')
    if (!stillInFocus(target)) throw new Error('Merge it into an area that is still in your focus.')
    replace(area.id, { mergedInto: target.id })
  } else if (action === 'restore-suggestion') {
    if (area.source === 'owner') throw new Error('Only a suggested area can go back to being a suggestion.')
    replace(area.id, { status: 'suggested', ownerRank: null, mergedInto: null })
  } else {
    throw new Error(`Unknown focus change: ${String(action)}`)
  }
}

/** The worker's built-in stage formats (stage-formats.ts), restated for the fixtures; the live list is the worker's. */
const SAMPLE_STAGE_FORMATS: StageFormatInfo[] = [
  { id: 'brief', label: 'Brief', output: 'markdown', builtIn: true }, { id: 'one-pager', label: 'One-pager', output: 'markdown', builtIn: true },
  { id: 'deck', label: 'Deck', output: 'html', builtIn: true }, { id: 'technical', label: 'Technical walkthrough', output: 'markdown', builtIn: true },
]
/** The tools the worker can send an answer to (answer-delivery.ts). */
const SAMPLE_ANSWER_TOOLS = ['claude', 'codex']

/** One-click runs as played this session: what the sample "worker" has started, in memory only. Nothing here calls an agent. */
let sampleAutoStageFormat: string | null = null
let samplePlan: FocusPlan | null = null
/** Clicks the sample has seen: one starts nothing again, as the worker's token check does. */
const sampleClicks = new Set<string>()
const sampleIcon = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`
/** What the sample "draws" when the owner typed a direction: another motif and colour, as a real run aims for. */
const SAMPLE_DIRECTED_ICON = sampleIcon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 11.5 21 3l-5.5 18-3.6-7.2Z" fill="#e0803a"/><path d="M11.9 13.8 21 3 3 11.5Z" fill="#f2b27a"/></svg>')
const SAMPLE_GENERATED_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5" fill="#6d5ae6"/><circle cx="12" cy="12" r="4.5" fill="#f3f1ff"/></svg>')}`
function setSampleIcon(focusAreaId: string, change: Pick<FocusArea, 'icon' | 'iconRun'>) {
  sampleFocusAreas = sampleFocusAreas.map((area) => {
    if (area.id !== focusAreaId) return area
    const { icon, iconRun, ...rest } = { ...area, ...change }
    return { ...rest, ...(icon ? { icon } : {}), ...(iconRun ? { iconRun } : {}) }
  })
}
let sampleRunMs = 1500
/** How long a sample run "takes" before its result shows. Tests shorten it. */
export const setSampleRunDelay = (ms: number) => { sampleRunMs = ms }
let publishSampleModel: ((model: WorkModel) => void) | null = null
const publishSample = async () => publishSampleModel?.(await loadSampleWorkModel())
const sampleNow = () => new Date().toISOString()

function changeSampleRequest(requestId: string, change: (request: Request) => Request) {
  const index = SAMPLE_REQUESTS.findIndex((request) => request.id === requestId)
  if (index < 0) throw new Error('That request is not in your work.')
  SAMPLE_REQUESTS[index] = change(SAMPLE_REQUESTS[index])
}

function withSampleStage(request: Request, stage: RequestStage): Request {
  const stages = [stage, ...(request.stages ?? []).filter((entry) => entry.formatId !== stage.formatId)]
  const readyStages = stages.filter((entry) => entry.state === 'ready').map((entry) => entry.formatId)
  const { readyStages: _ready, ...rest } = request
  return { ...rest, stages, ...(readyStages.length ? { readyStages } : {}) }
}

/** The proposals a plan would hold for the sample areas: each one something an existing focus action could save. */
function samplePlanProposals(focusAreaId: string | null): PlanProposal[] {
  const kept = sampleFocusAreas.filter((area) => area.status === 'kept' && !area.mergedInto)
  const planned = focusAreaId === null ? kept : kept.filter((area) => area.id === focusAreaId)
  const proposals: PlanProposal[] = []
  if (focusAreaId === null && kept.length > 1) {
    proposals.push({ kind: 'reorder', focusAreaIds: [kept[1].id, kept[0].id, ...kept.slice(2).map((area) => area.id)], moves: [{ focusAreaId: kept[1].id, reason: 'A finished request there waits for your review.' }] })
  }
  // Two folders of one product: what the owner would merge by hand.
  const viewer = planned.filter((area) => area.initiativeGuess && area.initiative?.startsWith('viewer'))
  if (new Set(viewer.map((area) => area.initiative)).size > 1) {
    proposals.push({ kind: 'initiative', initiative: 'Viewer', focusAreaIds: viewer.map((area) => area.id), reason: 'Both are the viewer, built in two folders.' })
  }
  for (const area of planned.slice(0, 2)) {
    proposals.push({ kind: 'goal', focusAreaId: area.id, goal: `Everything in ${area.name} can be checked from My Work.`, reason: 'The current goal names the work, not what done looks like.' })
    if (!area.notes && area.quotes[0]) proposals.push({ kind: 'notes', focusAreaId: area.id, notes: `Why it matters: you keep coming back to ${area.name}.`, draft: true, quotes: [area.quotes[0].quote] })
    proposals.push({ kind: 'next-asks', focusAreaId: area.id, asks: [{ text: `List what is still open in ${area.name}.`, reason: 'Two requests have no recorded next step.' }] })
  }
  return proposals
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
  stageFormats: SAMPLE_STAGE_FORMATS,
  autoStageFormat: sampleAutoStageFormat,
  focusPlan: samplePlan ? focusPlanSummary(samplePlan) : null,
  sourceHealth: { connected: true, error: null },
  // Sample mode demonstrates the indicator (LiveIndicator labels it a demonstration); nothing streams.
  connection: getConnectionStatus({ now: 0 }),
})

export const sampleSource: WorkDataSource = {
  sourceKind: 'sample',
  loadWorkModel: loadSampleWorkModel,
  // There is no feed. The sample's own one-click runs publish their result through this, as the worker's feed would.
  subscribeToLiveUpdates: (onWorkModel) => {
    publishSampleModel = onWorkModel
    return () => { if (publishSampleModel === onWorkModel) publishSampleModel = null }
  },

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
  refreshWork: async () => ({ state: 'idle' }),
  // Sample agents are fixtures with no recorded state to change.
  markAgentFinished: () => Promise.reject(new Error('Sample agents have no recorded state to change.')),

  /** Plays an answer's delivery: on its way, then taken by the session's tool. A tool the worker cannot resume refuses, as it does live. */
  async answerRequest(requestId, _text, token): Promise<OwnerRunStart> {
    const request = SAMPLE_REQUESTS.find((entry) => entry.id === requestId)
    if (!request) throw new Error('Sending your answer could not start: That request is not in your work.')
    if (sampleClicks.has(token)) return { outcome: 'duplicate' }
    const platform = requestChat(request)?.platform
    if (!platform || !SAMPLE_ANSWER_TOOLS.includes(platform)) return { outcome: 'refused', reason: 'Answers can be sent to Claude Code and Codex sessions only. Open the chat to answer this one.' }
    if (request.answer?.state === 'answering') throw new Error('Sending your answer could not start: Your last answer to this request is still being delivered.')
    sampleClicks.add(token)
    changeSampleRequest(requestId, (entry) => ({ ...entry, answer: { state: 'answering' } }))
    setTimeout(() => { changeSampleRequest(requestId, (entry) => ({ ...entry, answer: { state: 'delivered' } })); void publishSample() }, sampleRunMs)
    void publishSample()
    return { outcome: 'started' }
  },

  /** Plays one stage being made: generating, then ready with a sample document to read. */
  async generateStage(requestId, formatId, token): Promise<OwnerRunStart> {
    const request = SAMPLE_REQUESTS.find((entry) => entry.id === requestId)
    if (!request) throw new Error('The stage could not start: That request is not in your work.')
    if (sampleClicks.has(token)) return { outcome: 'duplicate' }
    if (!SAMPLE_STAGE_FORMATS.some((format) => format.id === formatId)) throw new Error('The stage could not start: That stage format does not exist.')
    if (request.stages?.some((stage) => stage.formatId === formatId && stage.state === 'generating')) throw new Error('The stage could not start: This stage is already being made.')
    sampleClicks.add(token)
    const stage: RequestStage = { formatId, state: 'generating', startedAt: sampleNow(), generatedAt: null, reviewedThrough: null, error: null, trigger: 'owner', outdated: false }
    changeSampleRequest(requestId, (entry) => withSampleStage(entry, stage))
    setTimeout(() => { changeSampleRequest(requestId, (entry) => withSampleStage(entry, { ...stage, state: 'ready', href: sampleStageHref(SAMPLE_STAGE_FORMATS.find((format) => format.id === formatId)!), generatedAt: sampleNow() })); void publishSample() }, sampleRunMs)
    void publishSample()
    return { outcome: 'started' }
  },

  /** Off until chosen; choosing a format makes nothing by itself. */
  async setAutoStageFormat(formatId) {
    if (formatId !== null && !SAMPLE_STAGE_FORMATS.some((format) => format.id === formatId)) throw new Error('The automatic stage setting was not saved: That stage format does not exist.')
    sampleAutoStageFormat = formatId
    return loadSampleWorkModel()
  },

  /** Plays planning help: planning, then ready with proposals for the sample areas. Nothing is applied. */
  async planFocus(focusAreaId, token): Promise<OwnerRunStart> {
    if (sampleClicks.has(token)) return { outcome: 'duplicate' }
    if (focusAreaId !== null && !sampleFocusAreas.some((area) => area.id === focusAreaId)) throw new Error('Planning help could not start: That focus area is not in your focus areas.')
    if (samplePlan?.state === 'planning') throw new Error('Planning help could not start: A plan is already being made.')
    sampleClicks.add(token)
    const planning: FocusPlan = { state: 'planning', focusAreaId, startedAt: sampleNow(), generatedAt: null, error: null, proposals: [], skipped: [] }
    samplePlan = planning
    setTimeout(() => { samplePlan = { ...planning, state: 'ready', generatedAt: sampleNow(), proposals: samplePlanProposals(focusAreaId) }; void publishSample() }, sampleRunMs)
    void publishSample()
    return { outcome: 'started' }
  },
  loadFocusPlan: async () => samplePlan,

  /** Kept on this page only: the image itself stands in for the worker's file. */
  async setFocusIcon(focusAreaId, upload) {
    if (!sampleFocusAreas.some((area) => area.id === focusAreaId)) throw new Error('The icon was not saved: That focus area is not in your focus areas.')
    setSampleIcon(focusAreaId, { icon: upload ? `data:image/${upload.format};base64,${upload.data}` : undefined, iconRun: undefined })
    return loadSampleWorkModel()
  },

  /** Plays one icon being drawn: generating, then a sample icon (another one when a direction was typed). No agent runs. */
  async generateFocusIcon(focusAreaId, token, direction): Promise<OwnerRunStart> {
    if (sampleClicks.has(token)) return { outcome: 'duplicate' }
    const area = sampleFocusAreas.find((entry) => entry.id === focusAreaId)
    if (!area) throw new Error('The icon could not start: That focus area is not in your focus areas.')
    if (area.iconRun?.state === 'generating') throw new Error('The icon could not start: This icon is already being generated.')
    sampleClicks.add(token)
    setSampleIcon(focusAreaId, { iconRun: { state: 'generating', error: null } })
    setTimeout(() => {
      // An upload or a removal made meanwhile stands, as on the worker.
      if (sampleFocusAreas.find((entry) => entry.id === focusAreaId)?.iconRun?.state !== 'generating') return
      setSampleIcon(focusAreaId, { icon: direction ? SAMPLE_DIRECTED_ICON : SAMPLE_GENERATED_ICON, iconRun: undefined })
      void publishSample()
    }, sampleRunMs)
    void publishSample()
    return { outcome: 'started' }
  },

  /** Checking rests the request: nothing is owed after it, and it is not marked shipped. Fixtures have no fingerprint to guard. */
  async setRequestChecked(requestId, _expectedFingerprint, checked) {
    const index = SAMPLE_REQUESTS.findIndex((request) => request.id === requestId)
    if (index < 0) throw new Error(`No sample request ${requestId}`)
    // Mutated in place, so every page reading the fixture objects sees the change.
    if (checked) {
      const request = SAMPLE_REQUESTS[index]
      sampleRequestsBeforeCheck.set(requestId, request)
      SAMPLE_REQUESTS[index] = assertConsistentRequest({ ...request, state: 'checked', checkedAt: 'just now', next: { who: 'bot', text: '' } })
    } else {
      const requestBeforeCheck = sampleRequestsBeforeCheck.get(requestId)
      if (!requestBeforeCheck) throw new Error(`Sample request ${requestId} has no check to undo`)
      SAMPLE_REQUESTS[index] = requestBeforeCheck
      sampleRequestsBeforeCheck.delete(requestId)
    }
    return { outcome: 'saved', model: await loadSampleWorkModel() }
  },
}
