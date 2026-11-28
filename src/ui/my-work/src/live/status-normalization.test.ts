// Status rules ported from claude-mem v15.0.1 tests/ui/work-view-presentation.test.ts (bun:test → node:test),
// now asserted against the typed status normalization instead of the vanilla viewer's presentWork.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeRequestStatus, presentStatus } from './status-normalization.ts'

const now = Date.parse('2026-10-20T12:00:00Z')
const item = (status: string, kind = 'work-state') => ({ kind, status, lastUpdateEpoch: now })
type StatusItem = Parameters<typeof normalizeRequestStatus>[0]['items'][number]
const statusOf = (items: Array<ReturnType<typeof item> & { judgedStatus?: string | null }>, lifecycle: { status: string; explicit: boolean; complete?: boolean | null } | null = null, checked = false) =>
  normalizeRequestStatus({ items, lifecycle, checked }, now)

describe('request status normalization', () => {
  it('never promotes completed child work into parent completion', () => {
    assert.equal(statusOf([item('done'), item('completed')]), 'unknown')
  })

  for (const status of ['needs-you', 'needs-input', 'waiting-on-user', 'awaiting-approval', 'needs-approval', 'Needs_Input']) {
    it(`reads explicit request_status=${status} as your move`, () => {
      const normalized = statusOf([item('doing')], { explicit: true, status })
      assert.equal(normalized, 'needs-you')
      assert.deepEqual(presentStatus(normalized, true), { state: 'your-move', stage: 'Building', who: 'human' })
    })
  }

  for (const status of ['needs-review', 'needs_review', 'Ready for review', 'in-review']) {
    it(`reads explicit request_status=${status} as done, not checked`, () => {
      assert.equal(statusOf([item('doing')], { explicit: true, status }), 'needs-review')
      assert.equal(statusOf([item('doing')], { explicit: true, status }, true), 'checked')
    })
  }

  it("shows Jev's judged status instead of a quiet agent's recorded one", () => {
    const old = now - 3 * 86400000
    assert.equal(statusOf([{ kind: 'work-state', status: 'doing', judgedStatus: 'needs-review', lastUpdateEpoch: old }]), 'needs-review')
    assert.equal(statusOf([{ kind: 'work-state', status: 'doing', judgedStatus: 'needs-you', lastUpdateEpoch: old }]), 'needs-you')
    assert.equal(statusOf([{ kind: 'work-state', status: 'doing', judgedStatus: 'dropped', lastUpdateEpoch: old }]), 'closed')
    assert.equal(statusOf([{ kind: 'work-state', status: 'doing', judgedStatus: null, lastUpdateEpoch: old }]), 'quiet')
  })

  it("reads a review's recorded owner move as your move, over open item statuses only", () => {
    const old = now - 3 * 86400000
    const withMove = (items: StatusItem[], extra: Partial<Parameters<typeof normalizeRequestStatus>[0]> = {}) =>
      normalizeRequestStatus({ items, lifecycle: null, checked: false, ownerMoveRecorded: true, ...extra }, now)
    const open: Array<[StatusItem[], string]> = [[[item('doing')], 'in-progress'], [[item('todo')], 'todo'], [[item('')], 'unknown'], [[{ kind: 'work-state', status: 'doing', lastUpdateEpoch: old }], 'quiet']]
    for (const [items, withoutMove] of open) {
      assert.equal(normalizeRequestStatus({ items, lifecycle: null, checked: false }, now), withoutMove)
      const normalized = withMove(items)
      assert.equal(normalized, 'needs-you')
      assert.deepEqual(presentStatus(normalized, true), { state: 'your-move', stage: 'Building', who: 'human' })
    }
    // A shipped review, a 100% review, a blocked item, a recorded done and closed work keep their own status.
    assert.equal(withMove([item('doing')], { progressState: 'shipped' }), 'shipped')
    assert.equal(withMove([item('doing')], { progressPercent: 100 }), 'needs-review')
    assert.equal(withMove([item('blocked')]), 'blocked')
    assert.equal(withMove([item('doing')], { lifecycle: { explicit: true, status: 'done' } }), 'done')
    assert.equal(withMove([item('dropped')]), 'closed')
  })

  it('does not turn an unknown explicit lifecycle label into a human handoff', () => {
    const normalized = statusOf([item('doing')], { explicit: true, status: 'awaiting-something-else' })
    assert.equal(normalized, 'in-progress')
    assert.equal(presentStatus(normalized, true).who, 'bot')
  })

  it('separates explicit reported complete from human checked', () => {
    assert.equal(statusOf([item('doing')], { explicit: true, status: 'done' }), 'done')
    assert.equal(statusOf([item('doing')], { explicit: true, status: 'open', complete: true }), 'done')
    assert.equal(statusOf([item('doing')], { explicit: true, status: 'done' }, true), 'checked')
  })

  it('closes a request whose work-state items were all dropped', () => {
    assert.equal(statusOf([item('dropped'), item('dropped')]), 'closed')
    assert.equal(statusOf([item('dropped'), item('doing')]), 'in-progress')
  })

  it('ages old recorded activity to quiet without inventing presence', () => {
    assert.equal(normalizeRequestStatus({ items: [{ kind: 'work-state', status: 'doing', lastUpdateEpoch: now - 7 * 60 * 60 * 1000 }], lifecycle: null, checked: false }, now), 'quiet')
  })
})
