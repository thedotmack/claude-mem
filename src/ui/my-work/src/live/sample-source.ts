// The wireframe fixtures as a data source, for design review (`?source=sample`). Nothing here is real.
import { assertConsistentRequest, SAMPLE_AGENTS, SAMPLE_DEVICES, SAMPLE_PEOPLE, SAMPLE_REQUESTS, SAMPLE_RUNS, type Request } from '../data.ts'
import { SAMPLE_CURRENT_PERIOD, SAMPLE_GOAL_ONLY_REQUESTS, SAMPLE_OPEN_ASKS, SAMPLE_PAST_PERIODS, SAMPLE_PRIORITIES } from '../data-goals.ts'
import { getConnectionStatus } from './connection-status.ts'
import type { WorkDataSource, WorkModel } from './work-data-source.ts'

/** Each checked sample request as it was before its check, so Undo restores it exactly. In memory only. */
const sampleRequestsBeforeCheck = new Map<string, Request>()

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
  lastRuns: { goals: { label: SAMPLE_RUNS.goals.label, lastRunAt: SAMPLE_RUNS.goals.lastRunAt, deviceName: SAMPLE_DEVICES.find((device) => device.id === SAMPLE_RUNS.goals.deviceId)!.name } },
  sourceHealth: { connected: true, error: null },
  // Sample mode demonstrates the indicator (LiveIndicator labels it a demonstration); nothing streams.
  connection: getConnectionStatus({ now: 0 }),
})

export const sampleSource: WorkDataSource = {
  sourceKind: 'sample',
  loadWorkModel: loadSampleWorkModel,
  // The sample demo flip (playDemoUpdates) stands in for live updates; there is no feed to subscribe to.
  subscribeToLiveUpdates: () => () => {},

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
