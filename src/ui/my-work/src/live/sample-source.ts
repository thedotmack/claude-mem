// The wireframe fixtures as a data source, for design review (`?source=sample`). Nothing here is real.
import { assertConsistentRequest, SAMPLE_AGENTS, SAMPLE_DEVICES, SAMPLE_PEOPLE, SAMPLE_REQUESTS, SAMPLE_RUNS, type Request } from '../data.ts'
import { SAMPLE_CURRENT_PERIOD, SAMPLE_GOAL_ONLY_REQUESTS, SAMPLE_OPEN_ASKS, SAMPLE_PAST_PERIODS, SAMPLE_PRIORITIES } from '../data-goals.ts'
import { SAMPLE_OWNER_RULES, SAMPLE_RULE_SCOPES, SAMPLE_RULES_LEARNING, type OwnerRule, type RuleChange, type RuleScope } from '../data-rules.ts'
import { getConnectionStatus } from './connection-status.ts'
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

const loadSampleWorkModel = async (): Promise<WorkModel> => ({
  sourceKind: 'sample',
  requests: [...SAMPLE_REQUESTS],
  requestReadErrors: [],
  agents: SAMPLE_AGENTS,
  devices: SAMPLE_DEVICES,
  people: SAMPLE_PEOPLE,
  unlinkedWorkCount: 0,
  priorities: SAMPLE_PRIORITIES,
  openAsks: SAMPLE_OPEN_ASKS,
  currentPeriod: SAMPLE_CURRENT_PERIOD,
  pastPeriods: SAMPLE_PAST_PERIODS,
  goalsReadError: null,
  goalOnlyRequests: SAMPLE_GOAL_ONLY_REQUESTS,
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
    // Mutated in place so My Goals, which reads the same fixture objects, sees the change too.
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
