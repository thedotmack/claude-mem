// Status rules ported from claude-mem v15.0.1 tests/ui/work-view-presentation.test.ts (bun:test → node:test),
// now asserted against the typed status normalization instead of the vanilla viewer's presentWork.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeRequestStatus, presentStatus } from './status-normalization.ts'

const now = Date.parse('2026-10-20T12:00:00Z')
const item = (status: string, kind = 'work-state') => ({ kind, status, lastUpdateEpoch: now })
const statusOf = (items: ReturnType<typeof item>[], lifecycle: { status: string; explicit: boolean; complete?: boolean | null } | null = null, checked = false) =>
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
