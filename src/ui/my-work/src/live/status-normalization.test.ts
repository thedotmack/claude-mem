// Status rules ported from claude-mem v15.0.1 tests/ui/work-view-presentation.test.ts (bun:test → node:test),
// now asserted against the typed status normalization instead of the vanilla viewer's presentWork.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TURN_REASONS, type TurnState } from '../../../../services/work-view/turn-state.mjs'
import { normalizeRequestStatus, OWNER_TURN_STALE_AFTER_MS, presentStatus, STALE_AFTER_MS, turnStatus } from './status-normalization.ts'

const now = Date.parse('2026-10-20T12:00:00Z')
const item = (status: string, kind = 'work-state') => ({ kind, status, lastUpdateEpoch: now })
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

  describe('the transcript\'s turn, when nothing more explicit is recorded', () => {
    const MINUTE = 60 * 1000
    const DAY = 24 * 60 * MINUTE
    const ended = (ago = MINUTE): TurnState => ({ state: 'owner-turn', reason: 'turn-ended', atEpoch: now - ago })
    const asked = (ago = MINUTE): TurnState => ({ state: 'owner-turn', reason: 'question-pending', atEpoch: now - ago })
    const running = (ago = MINUTE): TurnState => ({ state: 'agent-turn', reason: 'tool-running', atEpoch: now - ago })
    const spoke = (ago = MINUTE): TurnState => ({ state: 'agent-turn', reason: 'owner-spoke', atEpoch: now - ago })
    const prompt = (ago = MINUTE) => [{ kind: 'prompt', status: '', lastUpdateEpoch: now - ago }]
    const withTurn = (turn: TurnState | null, extra: Partial<Parameters<typeof normalizeRequestStatus>[0]> = {}) =>
      normalizeRequestStatus({ items: prompt(), lifecycle: null, checked: false, turn, ...extra }, now)

    it('a finished turn and a pending question are both the owner\'s move, never reported as done', () => {
      for (const turn of [ended(), asked()]) {
        assert.equal(withTurn(turn), 'needs-you')
        assert.deepEqual(presentStatus(withTurn(turn), true), { state: 'your-move', stage: 'Building', who: 'human' })
      }
    })

    it('reaches a request that had gone quiet: it was waiting, not idle', () => {
      assert.equal(withTurn(null, { items: prompt(3 * DAY) }), 'quiet')
      assert.equal(withTurn(ended(3 * DAY), { items: prompt(3 * DAY) }), 'needs-you')
    })

    it('an agent mid-turn is working, even when its last database record is old', () => {
      assert.equal(withTurn(running(), { items: prompt(8 * 60 * MINUTE) }), 'in-progress')
      assert.equal(withTurn(spoke(), { items: prompt(8 * 60 * MINUTE) }), 'in-progress')
      assert.equal(presentStatus(withTurn(running()), false).who, 'bot')
    })

    it('a turn too old to count changes nothing: an abandoned chat is idle and a stopped session is not working', () => {
      const old = prompt(30 * DAY)
      assert.equal(withTurn(ended(OWNER_TURN_STALE_AFTER_MS + MINUTE), { items: old }), 'quiet')
      assert.equal(withTurn(asked(OWNER_TURN_STALE_AFTER_MS + MINUTE), { items: old }), 'quiet')
      assert.equal(withTurn(ended(OWNER_TURN_STALE_AFTER_MS - MINUTE), { items: old }), 'needs-you')
      assert.equal(withTurn(running(STALE_AFTER_MS + MINUTE), { items: old }), 'quiet')
      assert.equal(withTurn({ state: 'owner-turn', reason: 'turn-ended', atEpoch: null }), 'unknown')
    })

    it('anything recorded explicitly still wins, and shipped work stays shipped', () => {
      assert.equal(withTurn(ended(), { items: [item('doing')] }), 'in-progress')
      assert.equal(withTurn(ended(), { items: [item('todo')] }), 'todo')
      assert.equal(withTurn(running(), { items: [item('needs-review')] }), 'needs-review')
      assert.equal(withTurn(ended(), { items: [item('dropped')] }), 'closed')
      assert.equal(withTurn(ended(), { lifecycle: { explicit: true, status: 'shipped' } }), 'shipped')
      assert.equal(withTurn(asked(), { lifecycle: { explicit: true, status: 'done' } }), 'done')
      assert.equal(withTurn(ended(), { progressState: 'shipped' }), 'shipped')
      assert.equal(withTurn(running(), { progressPercent: 100 }), 'needs-review')
      assert.equal(withTurn(ended(), { progressPercent: 100, checked: true }), 'checked')
    })

    it('every reason has a status', () => {
      for (const reason of TURN_REASONS) {
        const turn = { state: reason === 'turn-ended' || reason === 'question-pending' ? 'owner-turn' : 'agent-turn', reason, atEpoch: now } as TurnState
        assert.notEqual(turnStatus(turn, now), null)
      }
    })
  })
})
