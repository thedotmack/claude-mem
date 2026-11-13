// Status rules ported from claude-mem v15.0.1 tests/ui/work-view-presentation.test.ts (bun:test → node:test),
// now asserted against the typed status normalization instead of the vanilla viewer's presentWork.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TURN_REASONS, type TurnState } from '../../../../services/work-view/turn-state.mjs'
import { WAITING_FOR, type WaitingFor } from '../../../../services/work-view/waiting-for.mjs'
import { isDoneState } from '../data.ts'
import { awaitsCheck, normalizeRequestStatus, OWNER_TURN_STALE_AFTER_MS, presentStatus, STALE_AFTER_MS, STATUS, turnStatus, type NormalizedStatus } from './status-normalization.ts'

const now = Date.parse('2026-10-20T12:00:00Z')
const item = (status: string, kind = 'work-state') => ({ kind, status, lastUpdateEpoch: now })
const statusOf = (items: Array<ReturnType<typeof item> & { judgedStatus?: string | null }>, lifecycle: { status: string; explicit: boolean; complete?: boolean | null } | null = null, checked = false) =>
  normalizeRequestStatus({ items, lifecycle, checked }, now)

describe('request status normalization', () => {
  it('never promotes completed child work into parent completion', () => {
    assert.equal(statusOf([item('done'), item('completed')]), 'unknown')
  })

  for (const status of ['needs-you', 'needs-input', 'waiting-on-user', 'Needs_Input']) {
    it(`reads explicit request_status=${status} as your move, waiting on an answer`, () => {
      const normalized = statusOf([item('doing')], { explicit: true, status })
      assert.equal(normalized, 'needs-you')
      assert.deepEqual(presentStatus(normalized, true), { state: 'your-move', stage: 'Building', who: 'human', need: 'answer' })
    })
  }

  for (const status of ['awaiting-approval', 'needs-approval', 'Needs_Approval']) {
    it(`reads explicit request_status=${status} as your move, waiting on an approval`, () => {
      const normalized = statusOf([item('doing')], { explicit: true, status })
      assert.equal(normalized, 'needs-approval')
      assert.deepEqual(presentStatus(normalized, true), { state: 'your-move', stage: 'Building', who: 'human', need: 'approval' })
    })
  }

  it('files a request under its review\'s question, except when it shipped or closed', () => {
    const asked = (question: 'answer' | 'approval', items = [item('doing')], progressState: string | null = null) =>
      normalizeRequestStatus({ items, lifecycle: null, checked: false, progressState, question }, now)
    assert.equal(asked('answer'), 'needs-you')
    assert.equal(asked('approval'), 'needs-approval')
    assert.equal(asked('answer', [item('doing')], 'shipped'), 'shipped')
    assert.equal(asked('answer', [item('dropped')]), 'closed')
    assert.equal(normalizeRequestStatus({ items: [item('doing')], lifecycle: null, checked: false, question: null }, now), 'in-progress')
  })

  it('reads an item waiting on approval as the request waiting on approval', () => {
    assert.equal(statusOf([item('doing'), item('awaiting-approval')]), 'needs-approval')
  })

  it('says what a person\'s move needs from them, and gives an agent\'s move no need', () => {
    const need = (status: Parameters<typeof presentStatus>[0]) => { const next = presentStatus(status, true); return next.who === 'human' ? next.need : null }
    assert.deepEqual(
      (['needs-you', 'blocked', 'needs-approval', 'needs-review', 'done', 'checked', 'shipped', 'closed', 'quiet', 'in-progress', 'todo', 'unknown'] as const).map(need),
      ['answer', 'answer', 'approval', 'review', 'review', null, null, null, null, null, null, null],
    )
  })

  it('a checked, closed or shipped request rests: it names no person, and each keeps its own state', () => {
    assert.deepEqual(presentStatus('checked', true), { state: 'checked', stage: 'Reviewing', who: 'bot' })
    assert.deepEqual(presentStatus('closed', true), { state: 'closed', stage: 'Building', who: 'bot' })
    assert.deepEqual(presentStatus('shipped', true), { state: 'shipped', stage: 'Shipped', who: 'bot' })
    for (const status of (Object.keys(STATUS) as NormalizedStatus[]).filter((entry) => !['checked', 'closed', 'shipped'].includes(entry))) {
      assert.ok(!isDoneState(presentStatus(status, true).state), status)
    }
  })

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
    const ended = (ago = MINUTE): TurnState => ({ state: 'owner-turn', reason: 'turn-ended', atEpoch: now - ago })
    const asked = (ago = MINUTE): TurnState => ({ state: 'owner-turn', reason: 'question-pending', atEpoch: now - ago })
    const running = (ago = MINUTE): TurnState => ({ state: 'agent-turn', reason: 'tool-running', atEpoch: now - ago })
    const spoke = (ago = MINUTE): TurnState => ({ state: 'agent-turn', reason: 'owner-spoke', atEpoch: now - ago })
    const prompt = (ago = MINUTE) => [{ kind: 'prompt', status: '', lastUpdateEpoch: now - ago }]
    const withTurn = (turn: TurnState | null, extra: Partial<Parameters<typeof normalizeRequestStatus>[0]> = {}) =>
      normalizeRequestStatus({ items: prompt(), lifecycle: null, checked: false, turn, ...extra }, now)

    it('an ended turn is the owner\'s review, and a pending question the owner\'s answer', () => {
      assert.equal(withTurn(ended()), 'needs-review')
      assert.deepEqual(presentStatus(withTurn(ended()), true), { state: 'needs-check', stage: 'Reviewing', who: 'human', need: 'review' })
      assert.equal(withTurn(asked()), 'needs-you')
      assert.deepEqual(presentStatus(withTurn(asked()), true), { state: 'your-move', stage: 'Building', who: 'human', need: 'answer' })
    })

    it('reaches a request that had gone quiet: it was waiting, not idle', () => {
      assert.equal(withTurn(null, { items: prompt(3 * 24 * 60 * MINUTE) }), 'quiet')
      assert.equal(withTurn(ended(3 * 24 * 60 * MINUTE), { items: prompt(3 * 24 * 60 * MINUTE) }), 'needs-review')
    })

    it('an agent mid-turn is working, even when its last database record is old', () => {
      assert.equal(withTurn(running(), { items: prompt(8 * 60 * MINUTE) }), 'in-progress')
      assert.equal(withTurn(spoke(), { items: prompt(8 * 60 * MINUTE) }), 'in-progress')
      assert.equal(presentStatus(withTurn(running()), false).who, 'bot')
    })

    it('a turn too old to count changes nothing: an abandoned chat is idle and a stopped session is not working', () => {
      const old = prompt(30 * 24 * 60 * MINUTE)
      assert.equal(withTurn(ended(OWNER_TURN_STALE_AFTER_MS + MINUTE), { items: old }), 'quiet')
      assert.equal(withTurn(asked(OWNER_TURN_STALE_AFTER_MS + MINUTE), { items: old }), 'quiet')
      assert.equal(withTurn(ended(OWNER_TURN_STALE_AFTER_MS - MINUTE), { items: old }), 'needs-review')
      assert.equal(withTurn(running(STALE_AFTER_MS + MINUTE), { items: old }), 'quiet')
      assert.equal(withTurn({ state: 'owner-turn', reason: 'turn-ended', atEpoch: null }), 'unknown')
    })

    it('anything recorded explicitly still wins', () => {
      assert.equal(withTurn(ended(), { items: [item('doing')] }), 'in-progress')
      assert.equal(withTurn(ended(), { items: [item('todo')] }), 'todo')
      assert.equal(withTurn(running(), { items: [item('needs-input')] }), 'needs-you')
      assert.equal(withTurn(ended(), { items: [item('dropped')] }), 'closed')
      assert.equal(withTurn(asked(), { lifecycle: { explicit: true, status: 'shipped' } }), 'shipped')
      assert.equal(withTurn(asked(), { lifecycle: { explicit: true, status: 'done' } }), 'done')
      assert.equal(withTurn(asked(), { progressState: 'shipped' }), 'shipped')
      assert.equal(withTurn(running(), { progressPercent: 100 }), 'needs-review')
    })

    it('a current review question names the need; a checked result rests until the agent needs the owner again', () => {
      assert.equal(withTurn(ended(), { question: 'approval' }), 'needs-approval')
      assert.equal(withTurn(ended(), { question: 'answer' }), 'needs-you')
      assert.equal(withTurn(ended(), { checked: true }), 'checked')
      // The same version, still checked, and the agent then stopped on something only the owner can give.
      assert.equal(withTurn(asked(), { checked: true }), 'needs-you')
      assert.equal(withTurn({ ...ended(), waitingFor: 'answer' } as TurnState, { checked: true }), 'needs-you')
      assert.equal(withTurn({ ...ended(), waitingFor: 'approval' } as TurnState, { checked: true }), 'needs-approval')
      assert.equal(withTurn(ended(), { checked: true, question: 'approval' }), 'needs-approval')
      // A newer version of the request is not the one that was checked: the worker stops reporting the check.
      assert.equal(withTurn(ended(), { checked: false }), 'needs-review')
    })

    describe('a latest chat that was archived', () => {
      const archived = (ago = MINUTE): TurnState => ({ state: 'closed', reason: 'archived', atEpoch: now - ago })

      it('closes the request whatever it waited for, however long ago, and names no person', () => {
        assert.equal(withTurn(archived()), 'closed')
        assert.equal(withTurn(archived(400 * 24 * 60 * MINUTE), { items: prompt(400 * 24 * 60 * MINUTE) }), 'closed')
        assert.equal(withTurn({ state: 'closed', reason: 'archived', atEpoch: null }), 'closed')
        assert.deepEqual(presentStatus(withTurn(archived()), true), { state: 'closed', stage: 'Building', who: 'bot' })
        for (const recorded of [{ items: [item('needs-input')] }, { items: [item('awaiting-approval')] }, { items: [item('doing')] }, { items: [item('blocked')] },
          { lifecycle: { explicit: true, status: 'needs-review' } }, { lifecycle: { explicit: true, status: 'done' } }, { progressPercent: 100 },
          { question: 'answer' as const }, { question: 'approval' as const }]) {
          assert.equal(withTurn(archived(), recorded), 'closed', JSON.stringify(recorded))
        }
      })

      it('leaves a shipped request shipped and a checked one checked', () => {
        assert.equal(withTurn(archived(), { progressState: 'shipped' }), 'shipped')
        assert.equal(withTurn(archived(), { lifecycle: { explicit: true, status: 'shipped' } }), 'shipped')
        assert.equal(withTurn(archived(), { lifecycle: { explicit: true, status: 'done' }, checked: true }), 'checked')
      })

      it('is open again as soon as the chat is read un-archived', () => {
        assert.equal(withTurn(ended()), 'needs-review')
        assert.equal(withTurn(running()), 'in-progress')
      })
    })

    describe('what the ended turn\'s summary says it waits for', () => {
      const waiting = (waitingFor: WaitingFor, ago = MINUTE): TurnState => ({ state: 'owner-turn', reason: 'turn-ended', atEpoch: now - ago, waitingFor })
      const move = (status: ReturnType<typeof withTurn>) => { const next = presentStatus(status, true); return [next.state, next.who, next.who === 'human' ? next.need : null] }

      it('names the owner\'s move, and nothing owed is the agent\'s idle chat', () => {
        const moves: Record<WaitingFor, unknown[]> = {
          answer: ['your-move', 'human', 'answer'],
          review: ['needs-check', 'human', 'review'],
          approval: ['your-move', 'human', 'approval'],
          nothing: ['idle', 'bot', null],
        }
        for (const waitingFor of WAITING_FOR) assert.deepEqual(move(withTurn(waiting(waitingFor))), moves[waitingFor], waitingFor)
        assert.deepEqual(move(withTurn(ended())), moves.review)
      })

      it('takes a finished chat out of review even when its last record is recent', () => {
        assert.deepEqual(presentStatus(withTurn(waiting('nothing')), true), { state: 'idle', stage: 'Building', who: 'bot' })
      })

      it('comes after everything more explicit', () => {
        const order: [Partial<Parameters<typeof normalizeRequestStatus>[0]>, TurnState, string][] = [
          [{ lifecycle: { explicit: true, status: 'shipped' } }, waiting('answer'), 'shipped'],
          [{ lifecycle: { explicit: true, status: 'done' } }, waiting('nothing'), 'done'],
          [{ items: [item('needs-input')] }, waiting('nothing'), 'needs-you'],
          [{ items: [item('doing')] }, waiting('approval'), 'in-progress'],
          [{ items: [item('dropped')] }, waiting('review'), 'closed'],
          [{ progressState: 'shipped' }, waiting('approval'), 'shipped'],
          [{ progressPercent: 100 }, waiting('nothing'), 'needs-review'],
          [{ question: 'answer' }, waiting('nothing'), 'needs-you'],
          [{ question: 'approval' }, waiting('review'), 'needs-approval'],
          [{ checked: true }, waiting('review'), 'checked'],
          [{ checked: true }, waiting('nothing'), 'quiet'],
          [{}, waiting('approval'), 'needs-approval'],
          [{}, waiting('nothing'), 'quiet'],
          [{}, ended(), 'needs-review'],
        ]
        for (const [recorded, turn, status] of order) assert.equal(withTurn(turn, recorded), status, JSON.stringify([recorded, turn]))
      })

      it('a question asked through a tool is an answer whatever an older summary said', () => {
        assert.equal(withTurn({ ...asked(), waitingFor: 'nothing' } as TurnState), 'needs-you')
      })

      it('says nothing once the turn is too old to count', () => {
        const old = prompt(30 * 24 * 60 * MINUTE)
        assert.equal(withTurn(waiting('approval', OWNER_TURN_STALE_AFTER_MS + MINUTE), { items: old }), 'quiet')
        assert.equal(withTurn(waiting('approval', OWNER_TURN_STALE_AFTER_MS - MINUTE), { items: old }), 'needs-approval')
      })
    })

    it('every reason has a status', () => {
      for (const reason of TURN_REASONS) {
        const turn = { state: reason === 'archived' ? 'closed' : reason === 'turn-ended' || reason === 'question-pending' ? 'owner-turn' : 'agent-turn', reason, atEpoch: now } as TurnState
        assert.notEqual(turnStatus(turn, now), null)
      }
    })
  })
})

it('a request shows as waiting for a check exactly when its status can be marked checked', () => {
  for (const status of Object.keys(STATUS) as NormalizedStatus[]) {
    assert.equal(presentStatus(status, true).state === 'needs-check', awaitsCheck(status), status)
  }
})
