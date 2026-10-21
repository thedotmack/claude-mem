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
      assert.equal(request.estimate, null, 'no measured-pace ETA without readings')
      assert.equal(request.progress.readings, 0)
      assert.deepEqual(request.progress.history, [])
      assert.equal(request.progress.percent, request.state === 'shipped' ? 100 : null, 'percent only from a review, or 100 for an explicit ship')
      assert.equal(request.askedBy, raw.requestedBy ?? 'You')
      assert.equal(request.goalId, undefined, 'goal reads "Goal not linked yet" until request-progress links it')
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
