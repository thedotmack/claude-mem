// Run with `npm test` (node --test; Node strips the types). Checks the mapper against real worker snapshots:
// the tracked trimmed fixture always, plus the full .scratch/work-view-sample.json when it exists on this machine.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { assertConsistentRequest, needsYou } from '../data.ts'
import { chatLinks, requestChat } from './chat-links.ts'
import { isAwaitingCheck, isReadyForCheck, toWorkModel } from './to-work-model.ts'
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
      if (!raw.focusAreaId) assert.equal(request.focusAreaId, undefined, 'a request reads "Sorting…" until the focus step places it')
    }
  })

  test(`${name}: titles come from generated records or human copy, never raw prompts`, () => {
    for (const request of model.requests) {
      const raw = rawById.get(request.id)!
      const copy = raw.humanCopy
      const ready = !!copy && ['current', 'outdated'].includes(copy.state)
      const generated = raw.titleSource === 'request-group' || raw.titleSource === 'title-cache'
      assert.equal(request.title, generated ? raw.title.trim() || null : ready && copy.title?.trim() ? copy.title.trim() : null)
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

test('a closed request with a start and no completion does not count up as running', () => {
  const dropped = baseRequest.items.map((item) => ({ ...item, kind: 'work-state' as const, status: 'dropped' }))
  const { request } = mapOne({ lifecycle: null, items: dropped, completedAtEpoch: null })
  assert.equal(request.closed, true)
  assert.ok(request.startedAtIso, 'the fixture has a recorded start')
  assert.equal(request.runningLive, undefined)
  const complete = mapOne({ lifecycle: { explicit: true, complete: true, status: 'done' }, completedAtEpoch: null }).request
  assert.equal(complete.runningLive, undefined, 'a lifecycle that says complete has finished, even without a time')
  const open = mapOne({ completedAtEpoch: null }).request
  assert.equal(open.runningLive, true, 'an open request with a start and no completion still counts up')
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

test('looks up conversation titles by platform and content-session identity', () => {
  const raw = syntheticRequest()
  raw.conversationKeys = ['claude', 'codex'].map(platform => JSON.stringify(['conversation', platform, 'same-id']))
  const agents = ['claude', 'codex'].map(platform => ({
    id: platform, label: platform, platformSource: platform, sessionTitle: platform + ' session',
    project: 'repo', contentSessionId: 'same-id',
  }))
  const [request] = toWorkModel(snapshotWith([raw], { agents }), Date.now()).requests
  assert.deepEqual(request.conversations.map(item => item.title), ['claude session', 'codex session'])
})

test('maps shared decision versions and keeps an origin-only file visible without a link', () => {
  const raw = syntheticRequest()
  raw.review = { checked: false, checkedAtEpoch: null, actor: 'shared-user', available: true, mode: 'shared', hash: 'review-hash', version: 2, conflict: true, pending: true, message: 'Choose the current review.' }
  raw.suggestion = { conversationKey: 'c', requestId: 'r', requestTitle: 'Related request', evidence: 'The same change', confidence: 0.8, judge: 'test', at: null, expectedSuggestionHash: 'suggestion-hash', sharedConflict: true }
  raw.workProduct = [
    { kind: 'document', title: 'report.pdf', availability: 'origin-only', available: false, fileUrl: '/wrong/download', url: 'https://example.com/wrong' },
    { kind: 'pull-request', title: 'Published PR', url: 'https://github.com/example/repo/pull/1' },
  ]
  const mapped = toWorkModel(snapshotWith([raw]), Date.now()).requests[0]
  assert.deepEqual(mapped.review, { mode: 'shared', hash: 'review-hash', available: true, version: 2, conflict: true, legacy: undefined, pending: true, message: 'Choose the current review.' })
  assert.equal(mapped.suggestion?.expectedSuggestionHash, 'suggestion-hash')
  assert.equal(mapped.suggestion?.sharedConflict, true)
  assert.equal(mapped.workProduct[0].availability, 'origin-only')
  assert.equal(mapped.workProduct[0].href, undefined)
  assert.equal(mapped.workProduct[1].href, 'https://github.com/example/repo/pull/1')
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

test('a chat whose agent finished its turn is the owner\'s move on its card, without any review or recorded status', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  const quiet = { ...syntheticRequest(), updatedAtEpoch: now - 2 * 86400000 }
  const withTurn = (id: string, turn: WorkViewHumanRequest['turn']) => ({ ...quiet, id, turn })
  const model = toWorkModel(snapshotWith([
    withTurn('ended', { state: 'owner-turn', reason: 'turn-ended', atEpoch: now - 86400000 }),
    withTurn('asked', { state: 'owner-turn', reason: 'question-pending', atEpoch: now - 86400000 }),
    withTurn('running', { state: 'agent-turn', reason: 'tool-running', atEpoch: now - 60000 }),
    withTurn('abandoned', { state: 'owner-turn', reason: 'turn-ended', atEpoch: now - 20 * 86400000 }),
    { ...quiet, id: 'no-transcript' },
    { ...withTurn('shipped', { state: 'owner-turn', reason: 'turn-ended', atEpoch: now - 60000 }), lifecycle: { status: 'shipped', explicit: true, complete: true, atEpoch: now - 60000 }, completedAtEpoch: now - 60000 },
  ]), now)
  assert.deepEqual(model.requestReadErrors, [])
  const row = (id: string) => model.requests.find((request) => request.id === id)!
  for (const id of ['ended', 'asked']) assert.deepEqual([row(id).state, row(id).next.who, needsYou(row(id))], ['your-move', 'human', true])
  assert.deepEqual([row('running').state, row('running').next.who], ['working', 'bot'])
  assert.deepEqual([row('abandoned').state, row('no-transcript').state, row('shipped').state], ['idle', 'idle', 'shipped'])
  assert.deepEqual(model.requests.filter(needsYou).map((request) => request.id), ['ended', 'asked'])
})

const chatOf = (raw: WorkViewHumanRequest) => toWorkModel(snapshotWith([raw]), Date.now()).requests[0].chat

const CLAUDE_SESSION = '11111111-2222-4333-8444-555555555555'
const CODEX_SESSION = '01a18a2e-1d34-7000-8000-000000000002'
const claudeKey = JSON.stringify(['conversation', 'claude', CLAUDE_SESSION]), codexKey = JSON.stringify(['conversation', 'codex', CODEX_SESSION])

test('the chat is the conversation the worker names as the latest, whatever its place among the keys', () => {
  const raw = syntheticRequest()
  raw.conversationKeys = [claudeKey, codexKey]
  raw.latestConversationKey = claudeKey
  assert.deepEqual(chatOf(raw), { platform: 'claude', sessionId: CLAUDE_SESSION })
  assert.deepEqual(chatLinks(chatOf(raw)), { tool: 'Claude Code', openHref: `claude://resume?session=${CLAUDE_SESSION}`, resumeCommand: `claude --resume ${CLAUDE_SESSION}` })
  raw.latestConversationKey = codexKey
  assert.deepEqual(chatLinks(chatOf(raw)), { tool: 'Codex', openHref: `codex://threads/${CODEX_SESSION}`, resumeCommand: `codex resume ${CODEX_SESSION}` })
})

test('a request with several conversations and none named the latest has no chat: the page never picks one', () => {
  const raw = syntheticRequest()
  raw.conversationKeys = [claudeKey, codexKey]
  raw.latestConversationKey = null
  assert.equal(chatOf(raw), undefined)
  delete raw.latestConversationKey
  const request = toWorkModel(snapshotWith([raw]), Date.now()).requests[0]
  assert.equal(request.chat, undefined)
  assert.equal(requestChat(request), undefined)
})

test('a request named by its one conversation carries no chat of its own: the page reads it from the id', () => {
  const raw = syntheticRequest()
  raw.id = claudeKey
  raw.conversationKeys = [raw.id]
  raw.latestConversationKey = raw.id
  const request = toWorkModel(snapshotWith([raw]), Date.now()).requests[0]
  assert.equal(request.chat, undefined)
  assert.equal(chatLinks(requestChat(request))?.openHref, `claude://resume?session=${CLAUDE_SESSION}`)
  // An older worker names no latest conversation; the id still says which chat it is.
  delete raw.latestConversationKey
  assert.equal(chatLinks(requestChat(toWorkModel(snapshotWith([raw]), Date.now()).requests[0]))?.resumeCommand, `claude --resume ${CLAUDE_SESSION}`)
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
  assert.match(ok!.finishedAt!, /^Oct 21(,| at) \d{1,2}:\d{2} [ap]m$/)
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

const reviewedGroup = (): WorkViewHumanRequest => ({
  ...syntheticRequest(), groupId: 'g_000000000001', titleSource: 'request-group', humanCopy: { state: 'unavailable' },
  progress: { state: 'in-progress', percent: 60, summary: 'Cards are built; review remains.', narrative: 'Cards built.',
    milestones: [], checkedAt: '2026-10-21T12:00:00Z', readings: [{ at: '2026-10-21T12:00:00Z', percent: 60 }] },
})

for (const state of ['in-progress', 'stalled', 'shipped'] as const) {
  test(`a reviewed ${state} group shows its recorded title and summary without a human-copy provider`, () => {
    const raw = reviewedGroup()
    raw.progress = { ...raw.progress!, state, percent: state === 'shipped' ? 100 : 60,
      shippedAt: state === 'shipped' ? '2026-10-21T12:00:00Z' : null,
      readings: [{ at: '2026-10-21T12:00:00Z', percent: state === 'shipped' ? 100 : 60 }] }
    const model = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z'))
    assert.deepEqual(model.requestReadErrors, [])
    const request = model.requests[0]
    assert.equal(request.title, 'Cards')
    assert.equal(request.summary, raw.progress.summary)
    assert.equal(request.next.text, 'Next step not recorded')
    assert.equal(request.progress.percent, raw.progress.percent)
    assert.equal(request.state, state === 'shipped' ? 'shipped' : 'idle')
  })
}

test('a group uses its recorded review even when human copy exists for the original ask', () => {
  const raw = { ...reviewedGroup(), humanCopy: { state: 'current', title: 'Old wording', summary: 'Work has not started.', next: '', workstreams: [] } }
  const model = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z'))
  assert.equal(model.requests[0].title, raw.title)
  assert.equal(model.requests[0].summary, raw.progress!.summary)
})

for (const state of ['current', 'outdated']) {
  test(`a group awaiting its first progress review preserves its ${state} human-copy summary`, () => {
    const raw: WorkViewHumanRequest = { ...reviewedGroup(), progress: null,
      humanCopy: { state, title: 'Cards', summary: 'The initial design is ready.', next: '', workstreams: [] } }
    const model = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z'))
    assert.deepEqual(model.requestReadErrors, [])
    assert.equal(model.requests[0].summary, 'The initial design is ready.')
    assert.equal(model.requests[0].progress.percent, null)
  })
}

test('a cached generated title is displayed without promoting a raw prompt title', () => {
  const requests: WorkViewHumanRequest[] = ['title-cache', 'original-human-request', 'explicit-work-state-request'].map((titleSource, i) => ({
    ...syntheticRequest(), id: `request-${i}`, titleSource: titleSource as WorkViewHumanRequest['titleSource'], humanCopy: null,
  }))
  const model = toWorkModel(snapshotWith(requests), Date.parse('2026-10-22T12:00:00Z'))
  assert.deepEqual(model.requests.map(request => request.title), ['Cards', null, null])
})

test('reopening a shipped group does not display its older completion summary', () => {
  const raw = reviewedGroup()
  raw.humanCopy = { state: 'current', title: 'Cards', summary: 'All shipped.', next: '', workstreams: [] }
  raw.progress = { ...raw.progress!, state: 'shipped', percent: 100, summary: 'All shipped.', shippedAt: '2026-10-21T12:00:00Z', readings: [{ at: '2026-10-21T12:00:00Z', percent: 100 }] }
  raw.lifecycle = { status: 'in-progress', explicit: true, atEpoch: Date.parse('2026-10-22T11:00:00Z') }
  raw.updatedAtEpoch = raw.lifecycle.atEpoch!
  const model = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z'))
  assert.deepEqual(model.requestReadErrors, [])
  assert.equal(model.requests[0].title, raw.title)
  assert.equal(model.requests[0].summary, null)
  assert.equal(model.requests[0].state, 'working')
  assert.equal(model.requests[0].progress.percent, null)
})

test('recorded observations without work-state items do not claim no agent work exists', () => {
  const raw: WorkViewHumanRequest = { ...syntheticRequest(), activity: [{ id: 'observation-42', kind: 'observation', title: 'Cards built', detail: 'Ready for review', atEpoch: Date.parse('2026-10-21T12:00:00Z'), url: '/api/work-view/evidence/observation/42' }] }
  const model = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z'))
  assert.equal(model.requests[0].next.text, 'Next step not recorded')
})

for (const status of ['shipped', 'blocked']) {
  test(`a newer ${status} lifecycle hides an older partial review summary while retaining its readings`, () => {
    const raw = reviewedGroup()
    raw.humanCopy = { state: 'current', title: 'Cards', summary: 'Cards are built; review remains.', next: '', workstreams: [] }
    raw.lifecycle = { status, explicit: true, atEpoch: Date.parse('2026-10-22T11:00:00Z') }
    if (status === 'shipped') raw.completedAtEpoch = raw.lifecycle.atEpoch!
    const model = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z'))
    assert.deepEqual(model.requestReadErrors, [])
    const request = model.requests[0]
    assert.equal(request.state, status === 'shipped' ? 'shipped' : 'your-move')
    assert.equal(request.summary, null)
    assert.equal(request.progress.percent, status === 'shipped' ? 100 : 60)
    assert.equal(request.progress.readings, 1)
  })
}

for (const state of ['unavailable', 'current']) {
  test(`a group with a cached title still displays its review summary when human copy is ${state}`, () => {
    const raw: WorkViewHumanRequest = { ...reviewedGroup(), titleSource: 'title-cache', title: 'Cached group title',
      humanCopy: { state, title: 'Old title', summary: 'Work has not started.', next: '', workstreams: [] } }
    const model = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z'))
    assert.equal(model.requests[0].title, 'Cached group title')
    assert.equal(model.requests[0].summary, raw.progress!.summary)
  })
}

test('a group title that repeats the prompt is marked, even past the part the card quotes', () => {
  const long = `${'Context. '.repeat(60)}\nGOAL: Move billing to the new processor`
  const raw: WorkViewHumanRequest = { ...syntheticRequest(), titleSource: 'request-group', title: 'Move billing to the new processor', original: { text: long, atEpoch: Date.UTC(2026, 9, 18) } }
  const [copied] = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z')).requests
  assert.equal(copied.titleRepeatsPrompt, true)
  assert.ok(!copied.prompts[0].quote.includes('billing'), 'the card quote alone would have missed it')
  const [written] = toWorkModel(snapshotWith([{ ...raw, title: 'Billing moves processors' }]), Date.parse('2026-10-22T12:00:00Z')).requests
  assert.equal(written.titleRepeatsPrompt, undefined)
})


test('canonical minimal shared progress stays visible without inventing a history or milestones', () => {
  const raw = { ...syntheticRequest(), groupId: 'g_000000000001', titleSource: 'request-group' as const,
    progress: { state: 'in-progress' as const, percent: 60 } }
  const model = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z'))
  assert.deepEqual(model.requestReadErrors, [])
  assert.equal(model.requests.length, 1)
  const request = model.requests[0]
  assert.equal(request.title, 'Cards')
  assert.equal(request.progress.percent, 60)
  assert.equal(request.progress.readings, 1, 'the current progress record is one assessment')
  assert.equal(request.progress.history, undefined, 'no historical readings were supplied')
  assert.deepEqual(request.story, [])
  assert.equal(request.summary, null)
  assert.equal(request.estimate, null)
})

test('minimal shipped progress retains its date and survives mapping without optional detail', () => {
  const raw = { ...syntheticRequest(), groupId: 'g_000000000001', titleSource: 'request-group' as const,
    progress: { state: 'shipped' as const, percent: 100, shippedAt: '2026-10-21T12:00:00Z' } }
  const model = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z'))
  assert.deepEqual(model.requestReadErrors, [])
  assert.equal(model.requests[0].progress.percent, 100)
  assert.ok(model.requests[0].progress.completedAt)
  assert.deepEqual(model.requests[0].story, [])
  assert.equal(model.requests[0].progress.history, undefined)
})

test('image refs ride through: the card summary to Request.media, each record\'s refs to its granular row', () => {
  const ref = (n: number) => ({ id: `00000000-0000-4000-8000-00000000000${n}`, label: `image-${n}`, inspection: 'uninspected' as const })
  const at = Date.UTC(2026, 9, 21)
  const raw: WorkViewHumanRequest = { ...syntheticRequest(),
    activity: [
      { id: 'observation:2', kind: 'observation', title: 'Read the screenshot', detail: null, atEpoch: at, url: '/api/work-view/evidence/observation/2', media: { version: 1, attachments: [ref(1), ref(2)], overflow: true } },
      { id: 'observation:1', kind: 'observation', title: 'Planned the layout', detail: null, atEpoch: at - 1000, url: '/api/work-view/evidence/observation/1' },
    ],
    media: { count: 2, preview: [ref(1), ref(2)] } }
  const [request] = toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z')).requests
  assert.deepEqual(request.media, { count: 2, preview: [ref(1), ref(2)] })
  assert.deepEqual(request.granular[0].media, { version: 1, attachments: [ref(1), ref(2)], overflow: true })
  assert.equal('media' in request.granular[1], false, 'an image-free record gains no key')
  const [plain] = toWorkModel(snapshotWith([syntheticRequest()]), Date.parse('2026-10-22T12:00:00Z')).requests
  assert.equal('media' in plain, false, 'an image-free request gains no key')
})

// ---------- Owner actions: the standing question, stages, the answer, and the one readiness rule ----------

const REVIEWED = '2026-10-21T10:00:00.000Z'
const askedReview = (change: Partial<NonNullable<WorkViewHumanRequest['progress']>> = {}): NonNullable<WorkViewHumanRequest['progress']> => ({
  state: 'in-progress', percent: 40, checkedAt: '2026-10-21T10:00:30.000Z', reviewedThrough: REVIEWED,
  question: { need: 'approval', text: 'Merge PR 93 now?', background: [{ text: 'CI is green.' }, { text: '   ' }] }, ...change,
})
const questionOf = (raw: WorkViewHumanRequest) => toWorkModel(snapshotWith([raw]), Date.parse('2026-10-22T12:00:00Z')).requests[0].question

test('a review\'s question shows with what was gathered for it, named by the review it came from', () => {
  assert.deepEqual(questionOf({ ...syntheticRequest(), progress: askedReview() }), { need: 'approval', text: 'Merge PR 93 now?', version: REVIEWED, background: ['CI is green.'] })
  // A review from before `need` was recorded asks for an answer; one with no question has none.
  assert.equal(questionOf({ ...syntheticRequest(), progress: askedReview({ question: { text: 'Which one?' } }) })!.need, 'answer')
  assert.equal(questionOf({ ...syntheticRequest(), progress: askedReview({ question: undefined }) }), undefined)
  assert.equal(questionOf(syntheticRequest()), undefined)
})

test('a question stands only while the owner has not written since the review read its evidence', () => {
  const wrote = (atEpoch: number) => ({ ...syntheticRequest(), progress: askedReview(), scopeUpdates: [{ text: 'Yes, merge it.', atEpoch }] }) as WorkViewHumanRequest
  assert.ok(questionOf(wrote(Date.parse(REVIEWED) - 1000)), 'written before the review read: the review saw it and still asked')
  // Written while the review ran: after what it read, though before it was saved (checkedAt).
  assert.equal(questionOf(wrote(Date.parse(REVIEWED) + 10_000)), undefined)
  assert.equal(questionOf(wrote(Date.parse(REVIEWED) + 3_600_000)), undefined)
  // A review from before the read time was recorded has only its save time.
  const older = { ...wrote(Date.parse(REVIEWED) + 10_000), progress: askedReview({ reviewedThrough: undefined }) }
  assert.ok(questionOf(older))
  // A status recorded after the review (a reopen) outranks the review, and its question with it.
  assert.equal(questionOf({ ...syntheticRequest(), progress: askedReview(), lifecycle: { status: 'doing', explicit: true, complete: false, atEpoch: Date.parse(REVIEWED) + 3_600_000 } } as WorkViewHumanRequest), undefined)
})

test('a request carries its stages and the last answer\'s delivery, and the model the formats, the setting and the plan', () => {
  const stage = { state: 'ready' as const, file: '/bucket/s.md', url: '/api/deliverables/3/s.md', startedAt: '2026-10-21T09:00:00.000Z', generatedAt: '2026-10-21T09:01:00.000Z', reviewedThrough: '2026-10-20T09:00:00.000Z', error: null, pid: 1, trigger: 'owner' as const }
  const raw: WorkViewHumanRequest = { ...syntheticRequest(), progress: askedReview({ question: undefined }), stages: { brief: stage },
    answer: { state: 'failed', token: 't', platform: 'claude', startedAt: 'a', finishedAt: 'b', error: 'The tool exited 1', pid: 1 } }
  const plan = { state: 'ready' as const, focusAreaId: null, token: 't', pid: 1, startedAt: 'a', generatedAt: 'b', error: null, skipped: [], proposals: [{ kind: 'goal' as const, focusAreaId: 'fa', goal: 'g', reason: 'r' }] }
  const model = toWorkModel(snapshotWith([raw], { stageFormats: [{ id: 'brief', label: 'Brief', builtIn: true }], autoStageFormat: null, focusPlan: plan }), Date.parse('2026-10-22T12:00:00Z'))
  assert.deepEqual(model.requests[0].stages, [{ formatId: 'brief', state: 'ready', href: '/api/deliverables/3/s.md', error: null, outdated: true }])
  assert.deepEqual(model.requests[0].answer, { state: 'failed', error: 'The tool exited 1' })
  assert.deepEqual(model.stageFormats, [{ id: 'brief', label: 'Brief', builtIn: true }])
  assert.equal(model.autoStageFormat, null)
  assert.deepEqual(model.focusPlan, { state: 'ready', focusAreaId: null, startedAt: 'a', generatedAt: 'b', error: null, proposals: 1 })
  // An older worker's snapshot adds none of it.
  const plain = toWorkModel(snapshotWith([syntheticRequest()]), Date.parse('2026-10-22T12:00:00Z'))
  assert.deepEqual([plain.stageFormats, plain.autoStageFormat, plain.focusPlan, plain.requests[0].stages, plain.requests[0].answer], [undefined, undefined, undefined, undefined, undefined])
})

test('ready for a check is exactly when the page offers Mark checked, and a saved check is not asked for again', () => {
  const now = Date.parse('2026-10-22T12:00:00Z')
  const cases: Array<[string, Partial<WorkViewHumanRequest>]> = [
    ['finished review', { progress: askedReview({ percent: 100, question: undefined }) }],
    ['half-done review', { progress: askedReview({ question: undefined }) }],
    ['shipped review', { progress: askedReview({ state: 'shipped', percent: 100, shippedAt: REVIEWED, question: undefined }) }],
    ['reported complete', { lifecycle: { status: 'done', explicit: true, complete: true, atEpoch: now - 1000 } as WorkViewHumanRequest['lifecycle'] }],
    ['nothing recorded', {}],
  ]
  for (const [name, change] of cases) {
    const raw = { ...syntheticRequest(), ...change }
    const offered = toWorkModel(snapshotWith([raw]), now).requests[0].state === 'needs-check'
    assert.equal(isReadyForCheck(raw, now), offered, name)
    assert.equal(isAwaitingCheck(raw, now), offered, name)
  }
  const checked = { ...syntheticRequest(), progress: askedReview({ percent: 100, question: undefined }), review: { checked: true, checkedAtEpoch: now, actor: 'local-user', available: true } as WorkViewHumanRequest['review'] }
  assert.equal(isReadyForCheck(checked, now), true)
  assert.equal(isAwaitingCheck(checked, now), false)
})
