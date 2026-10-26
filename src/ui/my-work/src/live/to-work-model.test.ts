// Run with `npm test` (node --test; Node strips the types). Checks the mapper against real worker snapshots:
// the tracked trimmed fixture always, plus the full .scratch/work-view-sample.json when it exists on this machine.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { assertConsistentRequest } from '../data.ts'
import { toWorkModel } from './to-work-model.ts'
import type { WorkViewHumanRequest, WorkViewSnapshot } from './work-view-api-types.ts'

const appRoot = new URL('../../', import.meta.url)
const SNAPSHOT_FILES = ['test-fixtures/work-view-snapshot.trimmed.json', '.scratch/work-view-sample.json']
  .map((path) => new URL(path, appRoot))
  .filter((url) => existsSync(url))

const readSnapshot = (url: URL) => JSON.parse(readFileSync(url, 'utf8')) as WorkViewSnapshot
const snapshotTime = (snapshot: WorkViewSnapshot) => Date.parse(snapshot.generatedAt)

for (const url of SNAPSHOT_FILES) {
  const name = url.pathname.split('/').slice(-2).join('/')
  const snapshot = readSnapshot(url)
  const model = toWorkModel(snapshot, snapshotTime(snapshot))
  const rawById = new Map(snapshot.humanRequests.map((raw) => [raw.id, raw]))

  test(`${name}: every request maps, and every mapped request passes assertConsistentRequest`, () => {
    assert.ok(snapshot.humanRequests.length > 0)
    assert.equal(model.requests.length + model.requestReadErrors.length, snapshot.humanRequests.length)
    assert.deepEqual(model.requestReadErrors, [], 'real records read without errors')
    for (const request of model.requests) assert.doesNotThrow(() => assertConsistentRequest(request))
  })

  test(`${name}: percent, estimate and asked-by are never invented`, () => {
    for (const request of model.requests) {
      const raw = rawById.get(request.id)!
      const readings = raw.progress?.readings ?? []
      if (readings.length < 2) assert.equal(request.estimate, null, 'no measured-pace ETA without two readings')
      assert.deepEqual(request.progress.history, readings.map((reading) => reading.percent))
      assert.equal(request.progress.percent, request.state === 'shipped' ? 100 : raw.progress?.percent ?? null, 'percent only from a review, or 100 for an explicit ship')
      assert.equal(request.askedBy, raw.requestedBy ?? 'You')
      if (!raw.goals) assert.equal(request.goalId, undefined, 'goal reads "Goal not linked yet" until request-progress links it')
    }
  })

  test(`${name}: titles come from human copy, never from raw prompts`, () => {
    for (const request of model.requests) {
      const copy = rawById.get(request.id)!.humanCopy
      const ready = !!copy && ['current', 'outdated'].includes(copy.state)
      assert.equal(request.title, ready && copy.title?.trim() ? copy.title.trim() : null)
    }
  })

  test(`${name}: a needs-review lifecycle reads "Done, not checked"`, () => {
    const needsReview = snapshot.humanRequests.filter((raw) => raw.lifecycle?.explicit && raw.lifecycle.status === 'needs-review')
    assert.ok(needsReview.length > 0, 'the real data has a needs-review request')
    for (const raw of needsReview) {
      const request = model.requests.find((entry) => entry.id === raw.id)!
      assert.equal(request.state, 'needs-check')
      assert.equal(request.stage, 'Reviewing')
      assert.equal(request.next.who, 'human')
    }
  })

  test(`${name}: agents, devices and the unlinked count come from the snapshot`, () => {
    assert.deepEqual(model.devices.map((device) => device.id), ['this-computer'])
    for (const request of model.requests) assert.ok(model.agents.some((agent) => agent.id === request.agentId))
    for (const agent of model.agents) assert.ok(['claude', 'codex', 'gemini', 'other'].includes(agent.tool))
    assert.equal(model.unlinkedWorkCount, snapshot.unlinkedWork.length)
  })
}

// Status rows the real data does not have today, built from a real record so only the status fields differ.
const baseSnapshot = readSnapshot(SNAPSHOT_FILES[0])
const baseRequest = baseSnapshot.humanRequests.find((raw) => raw.lifecycle?.status === 'needs-review')!
const mapOne = (change: Partial<WorkViewHumanRequest>) => {
  const model = toWorkModel({ ...baseSnapshot, humanRequests: [{ ...baseRequest, ...change }] }, snapshotTime(baseSnapshot))
  return { request: model.requests[0], readError: model.requestReadErrors[0] }
}

test('a checked result hands the next move back to you, and never ships it', () => {
  const { request } = mapOne({ review: { checked: true, checkedAtEpoch: snapshotTime(baseSnapshot), available: true } })
  assert.equal(request.state, 'your-move')
  assert.deepEqual(request.next, { who: 'human', text: 'Ship it' })
  assert.ok(request.checkedAt)
})

test('a blocked item puts an Unblock step on you', () => {
  const { request } = mapOne({ lifecycle: null, items: baseRequest.items.map((item, index) => index === 0 ? { ...item, status: 'blocked' } : item) })
  assert.equal(request.state, 'your-move')
  assert.match(request.next.text, /^Unblock: /)
})

test('a shipped lifecycle without a completion time becomes a read-error card, not a crash', () => {
  const { request, readError } = mapOne({ lifecycle: { status: 'shipped', explicit: true }, completedAtEpoch: null })
  assert.equal(request, undefined)
  assert.match(readError.reason, /shipped requests are 100% with a completion date/)
})

test('missing human copy shows the terminal view, with no invented title', () => {
  const { request } = mapOne({ humanCopy: null })
  assert.equal(request.title, null)
  assert.equal(request.activityWord, 'Translating')
  assert.ok(request.terminal.length > 0)
})

test('a request whose work-state items were all dropped is closed, with no lifecycle needed', () => {
  const dropped = baseRequest.items.map((item) => ({ ...item, kind: 'work-state' as const, status: 'dropped' }))
  const { request, readError } = mapOne({ lifecycle: null, items: dropped })
  assert.equal(readError, undefined)
  assert.equal(request.state, 'idle')
  assert.equal(request.closed, true)
})

const syntheticRequest = (): WorkViewHumanRequest => ({
  id: '["overall-request","g_000000000001"]', contentFingerprint: 'f', title: 'Cards', original: { text: 'Build the release cards', atEpoch: Date.UTC(2026, 9, 18) },
  scopeUpdates: [], humanCopy: null, lifecycle: null, items: [], workstreams: [], activity: [], agentIds: [], conversationKeys: [],
  requestedBy: null, startedAtEpoch: Date.UTC(2026, 9, 18), completedAtEpoch: null, updatedAtEpoch: Date.UTC(2026, 9, 21), review: null,
})
const snapshotWith = (humanRequests: WorkViewHumanRequest[], extra: Partial<WorkViewSnapshot> = {}): WorkViewSnapshot => ({
  version: 1, generatedAt: '2026-10-22T12:00:00Z', agents: [], humanRequests, unlinkedWork: [], revision: '1',
  source: { kind: 'test', connected: true, error: null, lastCheckedAt: null }, ...extra,
})

test('a reviewed request shows the review percent, its readings, the measured ETA and its milestones', () => {
  const raw = { ...syntheticRequest(), progress: {
    state: 'in-progress' as const, percent: 60, summary: 'Under way.', narrative: 'Cards built first, then spacing.', checkedAt: '2026-10-21T12:00:00Z',
    milestones: [{ at: '2026-10-21T09:00:00Z', text: 'Spacing fixed' }, { at: '2026-10-19T09:00:00Z', text: 'Cards built' }],
    readings: [{ at: '2026-10-20T12:00:00Z', percent: 40 }, { at: '2026-10-21T12:00:00Z', percent: 60 }],
  } }
  const [request] = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z')).requests
  assert.equal(request.progress.percent, 60)
  assert.equal(request.progress.readings, 2)
  assert.deepEqual(request.progress.history, [40, 60])
  assert.equal(request.estimate, 'at this pace, about Oct 23')
  assert.deepEqual(request.story.map((step) => step.label), ['Cards built', 'Spacing fixed'])
  assert.equal(request.storyNarrative, 'Cards built first, then spacing.')
  const single = toWorkModel(snapshotWith([{ ...raw, progress: { ...raw.progress, readings: [raw.progress.readings[1]] } }]), Date.parse('2026-10-22T12:00:00Z')).requests[0]
  assert.equal(single.estimate, null, 'one reading has no pace')
  assert.equal(single.progress.readings, 1)
})

test('a review newer than its items wins: shipped ships, and 100% is done, never an error card', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  const doing = [{ ...baseRequest.items[0], kind: 'work-state' as const, status: 'doing', lastUpdateEpoch: now - 60000 }]
  const review = { summary: 'Done.', narrative: '', milestones: [], checkedAt: '2026-10-22T11:00:00Z', readings: [{ at: '2026-10-22T11:00:00Z', percent: 100 }] }
  const shipped = { ...syntheticRequest(), id: 'shipped', items: doing, progress: { ...review, state: 'shipped' as const, percent: 100, shippedAt: '2026-10-22T10:00:00Z' } }
  const finished = { ...syntheticRequest(), id: 'finished', items: doing, progress: { ...review, state: 'in-progress' as const, percent: 100 } }
  const model = toWorkModel(snapshotWith([shipped, finished]), now)
  assert.deepEqual(model.requestReadErrors, [])
  const [shippedCard, finishedCard] = model.requests
  assert.equal(shippedCard.state, 'shipped')
  assert.equal(shippedCard.stage, 'Shipped')
  assert.equal(shippedCard.progress.percent, 100)
  assert.ok(shippedCard.progress.completedAt, 'the review\'s shippedAt is the completion date')
  assert.equal(finishedCard.state, 'needs-check')
  assert.equal(finishedCard.next.who, 'human')
  assert.equal(finishedCard.progress.percent, 100)
})

test('an explicit status recorded after a review wins over it: a reopened request is not shipped or done', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  const doing = [{ ...baseRequest.items[0], kind: 'work-state' as const, status: 'doing', lastUpdateEpoch: now - 60000 }]
  const reopened = { status: 'in-progress', explicit: true, complete: false, atEpoch: Date.parse('2026-10-22T11:30:00Z') }
  const review = { summary: 'Done.', narrative: '', milestones: [], checkedAt: '2026-10-22T11:00:00Z', readings: [{ at: '2026-10-22T11:00:00Z', percent: 100 }] }
  const wasShipped = { ...syntheticRequest(), id: 'was-shipped', items: doing, lifecycle: reopened, progress: { ...review, state: 'shipped' as const, percent: 100, shippedAt: '2026-10-22T10:00:00Z' } }
  const wasDone = { ...syntheticRequest(), id: 'was-done', items: doing, lifecycle: reopened, progress: { ...review, state: 'in-progress' as const, percent: 100 } }
  const partway = { ...syntheticRequest(), id: 'partway', items: doing, lifecycle: reopened, progress: { ...review, state: 'in-progress' as const, percent: 60, readings: [{ at: '2026-10-22T11:00:00Z', percent: 60 }] } }
  const model = toWorkModel(snapshotWith([wasShipped, wasDone, partway]), now)
  assert.deepEqual(model.requestReadErrors, [])
  for (const request of model.requests.slice(0, 2)) {
    assert.equal(request.state, 'working')
    assert.equal(request.progress.percent, null, 'an older 100% is not shown on a reopened request')
  }
  assert.equal(model.requests[2].progress.percent, 60, 'an older partial review still shows')
})

test('a request shipped after a partial review is a shipped card at 100%, not a read-error card', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  const partial = { summary: 'Under way.', narrative: '', milestones: [], checkedAt: '2026-10-22T09:00:00Z', state: 'in-progress' as const, percent: 60, readings: [{ at: '2026-10-22T08:00:00Z', percent: 30 }, { at: '2026-10-22T09:00:00Z', percent: 60 }] }
  const shippedLater = { status: 'shipped', explicit: true, complete: true, atEpoch: Date.parse('2026-10-22T11:00:00Z') }
  // Shipped after the review, and shipped before a newer partial review.
  const after = { ...syntheticRequest(), id: 'shipped-after', lifecycle: shippedLater, completedAtEpoch: shippedLater.atEpoch, progress: partial }
  const before = { ...syntheticRequest(), id: 'shipped-before', lifecycle: { ...shippedLater, atEpoch: Date.parse('2026-10-22T08:30:00Z') }, completedAtEpoch: Date.parse('2026-10-22T08:30:00Z'), progress: partial }
  const model = toWorkModel(snapshotWith([after, before]), now)
  assert.deepEqual(model.requestReadErrors, [])
  for (const card of model.requests) {
    assert.equal(card.state, 'shipped')
    assert.equal(card.progress.percent, 100, 'the recorded ship completes it')
    assert.ok(card.progress.completedAt)
    assert.equal(card.progress.readings, 2, 'the reviews still count')
  }
})

test('a request with only asks maps cleanly: its asks show, no activity, and a fresh ask reads as working', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  const asked = { ...syntheticRequest(), updatedAtEpoch: now - 60000, scopeUpdates: [{ text: 'Keep the existing design.', atEpoch: now - 60000 }] }
  const model = toWorkModel(snapshotWith([asked, { ...asked, id: 'old-ask', updatedAtEpoch: now - 3 * 86400000 }]), now)
  assert.deepEqual(model.requestReadErrors, [])
  const [fresh, old] = model.requests
  assert.deepEqual(fresh.terminal, ['ask Build the release cards', 'ask Keep the existing design.'])
  assert.deepEqual(fresh.granular, [])
  assert.deepEqual(fresh.workstreams, [])
  assert.equal(fresh.next.text, 'No agent work recorded yet')
  assert.equal(fresh.state, 'working')
  assert.deepEqual(fresh.prompts.map((prompt) => prompt.quote), ['Build the release cards', 'Keep the existing design.'])
  assert.equal(old.state, 'idle')
})

test('goal links: absent is not linked yet, empty is no goal, and an open ask lists the requests that serve it', () => {
  const goalItem = (id: string, kind: 'priority' | 'open-ask') => ({ id, task: id, kind, rank: 1, title: id, product: null, latestAt: null, timesAsked: 1, status: 'todo', evidence: [] })
  const goals = { listId: 'l', listName: 'owner-goals', history: false, project: 'p', updatedAt: '2026-10-22T00:00:00Z', periodStart: null, periodEnd: null, summary: null, generatedAt: '2026-10-22T00:00:00Z', windowDays: 30, sourcePromptCount: 10, mapPath: null, priorities: [goalItem('ship', 'priority'), goalItem('docs', 'priority')], openAsks: [goalItem('ask', 'open-ask')] }
  const linked = { ...syntheticRequest(), id: 'r1', goals: [{ goalId: 'ask', goal: 'ask', title: 'ask', kind: 'open-ask' as const, evidence: 'x' }, { goalId: 'ship', goal: 'ship', title: 'ship', kind: 'priority' as const, evidence: 'y' }, { goalId: 'docs', goal: 'docs', title: 'docs', kind: 'priority' as const, evidence: 'z' }] }
  const none = { ...syntheticRequest(), id: 'r2', goals: [] }
  const notYet = { ...syntheticRequest(), id: 'r3' }
  const model = toWorkModel(snapshotWith([linked, none, notYet], { goals }), Date.parse('2026-10-22T12:00:00Z'))
  assert.deepEqual(model.requests.map((request) => request.goalId), ['ship', null, undefined])
  assert.deepEqual(model.openAsks[0].servedBy, ['r1'])
  // A request linked to two priorities counts for both, not only the one request.goalId names.
  assert.deepEqual(model.priorities.map((goal) => goal.servedBy), [['r1'], ['r1']])
})

test('the build story recap is its first paragraph; no story hides it', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  const model = toWorkModel(snapshotWith([], { story: { story: { narrative: '## Velocity\n\nFirst **part**.\n\nSecond part.', writtenAt: '2026-10-22T10:00:00Z' } } }), now)
  assert.equal(model.buildStory?.recap, 'First part.')
  assert.deepEqual(model.buildStory?.paragraphs, ['Velocity', 'First part.', 'Second part.'])
  assert.equal(toWorkModel(snapshotWith([]), now).buildStory, null)
})

test('the automatic refresh maps running, last refreshed and failure text, with nothing else from refresh.json', () => {
  const base = JSON.parse(readFileSync(new URL('test-fixtures/work-view-snapshot.trimmed.json', new URL('../../', import.meta.url)), 'utf8')) as WorkViewSnapshot
  const at = Date.parse('2026-10-21T12:00:00Z')
  assert.equal(toWorkModel(base, at).refresh, null)
  assert.deepEqual(toWorkModel({ ...base, refresh: { state: 'running', startedAt: '2026-10-21T11:00:00Z' } }, at).refresh, { state: 'running', finishedAt: null, error: null })
  const ok = toWorkModel({ ...base, refresh: { state: 'ok', startedAt: '2026-10-21T11:00:00Z', finishedAt: '2026-10-21T11:40:00Z', error: null } }, at).refresh
  assert.equal(ok?.state, 'ok')
  assert.match(ok!.finishedAt!, /^Oct 21(,| at) \d{1,2}:40 [ap]m$/)
  assert.deepEqual(toWorkModel({ ...base, refresh: { state: 'failed', finishedAt: '2026-10-21T11:40:00Z', error: 'codex exec exited 1' } }, at).refresh?.error, 'codex exec exited 1')
  assert.deepEqual(toWorkModel({ ...base, refresh: { state: 'waiting-for-agent', error: 'No logged-in Claude Code, Codex or Gemini on this computer yet.' } }, at).refresh, { state: 'waiting-for-agent', finishedAt: null, error: 'No logged-in Claude Code, Codex or Gemini on this computer yet.' })
})

test('recorded work product maps onto the drawer kinds; a missing local file is dropped and a commit without a GitHub remote has no link', () => {
  const { request } = mapOne({ workProduct: [
    { kind: 'commit', title: 'bc8cd09 feat(work-view): progress readings', url: 'https://github.com/thedotmack/claude-mem/commit/bc8cd096b', sha: 'bc8cd096b', branch: 'feat/my-work-react-viewer' },
    { kind: 'commit', title: '1e89284 fix(agent-runner): wait for each agent CLI', sha: '1e8928441', branch: null },
    { kind: 'branch', title: 'feat/my-work-react-viewer', url: 'https://github.com/thedotmack/claude-mem/tree/feat/my-work-react-viewer', branch: 'feat/my-work-react-viewer' },
    { kind: 'pull-request', title: 'Add work product', url: 'https://github.com/o/r/pull/42' },
    { kind: 'image', title: 'shot.png', fileUrl: '/api/work-view/file/observation/3/0', available: true },
    { kind: 'image', title: 'gone.png', fileUrl: '/api/work-view/file/observation/4/0', available: false },
    { kind: 'something-new', title: 'Release notes', url: 'https://example.com/notes' },
  ] })
  assert.deepEqual(request.workProduct, [
    { kind: 'Commit', label: 'bc8cd09 feat(work-view): progress readings', href: 'https://github.com/thedotmack/claude-mem/commit/bc8cd096b' },
    { kind: 'Commit', label: '1e89284 fix(agent-runner): wait for each agent CLI', href: undefined },
    { kind: 'Branch', label: 'feat/my-work-react-viewer', href: 'https://github.com/thedotmack/claude-mem/tree/feat/my-work-react-viewer' },
    { kind: 'PR', label: 'Add work product', href: 'https://github.com/o/r/pull/42' },
    { kind: 'File', label: 'shot.png', href: '/api/work-view/file/observation/3/0' },
    { kind: 'Link', label: 'Release notes', href: 'https://example.com/notes' },
  ])
  assert.deepEqual(mapOne({ workProduct: undefined }).request.workProduct, [])
})

test('a subagent shows Finished only on a recorded stop, and quiet otherwise; main agents carry no status', async () => {
  const { toAgent } = await import('./to-work-model.ts')
  const base = { id: 'g', label: 'Claude Code', platformSource: 'claude', sessionTitle: null, project: 'repo', contentSessionId: 's' }
  assert.equal(toAgent(base).status, undefined)
  const finished = toAgent({ ...base, isSubagent: true, canMarkFinished: false, presence: { status: 'finished', finishedAt: '2026-10-23T18:12:50Z', evidence: 'subagent-stop-hook' } })
  assert.equal(finished.status, 'finished')
  assert.equal(finished.canMarkFinished, false)
  assert.ok(finished.finishedAt)
  const quiet = toAgent({ ...base, isSubagent: true, canMarkFinished: true, presence: { status: 'quiet' } })
  assert.equal(quiet.status, 'quiet')
  assert.equal(quiet.canMarkFinished, true)
  assert.equal(toAgent({ ...base, isSubagent: true, canMarkFinished: true, presence: { status: 'recent' } }).status, 'working')
})

test('a bucket copy keeps its deliverable mark for the front of the card; other products carry none, and a gone copy is left out', async () => {
  const { isCardDeliverable } = await import('../lib/deliverables.ts')
  const { request } = mapOne({ workProduct: [
    { kind: 'page', title: 'Launch report', url: '/api/deliverables/21/report-3f9a1c2b.html', available: true, deliverable: true, sourcePath: '/w/.scratch/report.html' },
    { kind: 'file', title: 'notes.txt', url: '/api/deliverables/22/notes-ab12cd34.txt', available: true, deliverable: true },
    { kind: 'page', title: 'Gone', url: '/api/deliverables/23/gone-00000000.html', available: false, deliverable: true },
    { kind: 'commit', title: 'bc8cd09 feat: progress readings', sha: 'bc8cd096b', branch: 'main' },
    { kind: 'pull-request', title: 'Add work product', url: 'https://github.com/o/r/pull/42' },
  ] })
  assert.deepEqual(request.workProduct, [
    { kind: 'Page', label: 'Launch report', href: '/api/deliverables/21/report-3f9a1c2b.html', deliverable: true },
    { kind: 'File', label: 'notes.txt', href: '/api/deliverables/22/notes-ab12cd34.txt', deliverable: true },
    { kind: 'Commit', label: 'bc8cd09 feat: progress readings', href: undefined },
    { kind: 'PR', label: 'Add work product', href: 'https://github.com/o/r/pull/42' },
  ])
  // The card's front links deliverables and PRs; commits and branches stay in the drawer.
  assert.deepEqual(request.workProduct.filter(isCardDeliverable).map((product) => product.label), ['Launch report', 'notes.txt', 'Add work product'])
})
