import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SAMPLE_REQUESTS, type Agent, type LiveState, type Request } from '../data.ts'
import { agentBoard } from './agent-board.ts'
import { UNRECORDED_AGENT } from './to-work-model.ts'

const agent = (id: string, fields: Partial<Agent> = {}): Agent => ({ id, tool: 'claude', name: 'Claude Code', role: `repo-${id}`, deviceId: 'this-computer', ...fields })
const subagent = (id: string, fields: Partial<Agent> = {}): Agent => agent(id, { status: 'quiet', canMarkFinished: true, ...fields })
/** A request in `state` for `agentId`, from the sample request in that state where there is one (only state is read here). */
const request = (id: string, agentId: string, state: LiveState): Request => ({ ...SAMPLE_REQUESTS[0], id, agentId, state })
const ids = (entries: { agent: Agent }[]) => entries.map((entry) => entry.agent.id)

test('By agent puts the agents with work first: the most urgent request, then how many, then the model order for ties', () => {
  // In the model's order the agent with one working request comes before the one with two, so only the count puts the
  // second first.
  const agents = [agent('quiet-one'), agent('one-working'), agent('two-working'), agent('your-move'), agent('also-one-working'), agent('idle-only')]
  const board = agentBoard(agents, [
    request('r1', 'two-working', 'working'), request('r2', 'two-working', 'working'),
    request('r3', 'one-working', 'working'),
    request('r4', 'your-move', 'your-move'),
    request('r5', 'also-one-working', 'working'),
    request('r6', 'idle-only', 'idle'),
  ])
  // your-move beats working; two working beat one; the two with one working keep the model's order; idle comes last.
  assert.deepEqual(ids(board.withWork), ['your-move', 'two-working', 'one-working', 'also-one-working', 'idle-only'])
  assert.deepEqual(ids(board.idle), ['quiet-one'])
  assert.equal(board.idleAgents, 1)
  // The same input in another order is ordered by the model's order, never by the request order it came in.
  const again = agentBoard(agents, [request('r5', 'also-one-working', 'working'), request('r3', 'one-working', 'working')])
  assert.deepEqual(ids(again.withWork), ['one-working', 'also-one-working'])
})

test('requests with no agent, or an agent the model does not hold, fold together; none is dropped', () => {
  const board = agentBoard([agent('a'), UNRECORDED_AGENT], [
    request('r1', 'a', 'working'), request('r2', UNRECORDED_AGENT.id, 'idle'), request('r3', 'gone-agent', 'shipped'),
  ])
  assert.deepEqual(board.unrecorded.map((entry) => entry.id), ['r2', 'r3'])
  // The stand-in is never a card of its own.
  assert.deepEqual([...ids(board.withWork), ...ids(board.idle)], ['a'])
})

test('a subagent nests only under a linked parent that stands on its own; a self-link or a chain leaves it a card', () => {
  const board = agentBoard([
    agent('main'), subagent('sub', { parentId: 'main' }), subagent('sub-of-sub', { parentId: 'sub' }),
    subagent('self', { parentId: 'self' }), subagent('to-nobody', { parentId: 'not-in-the-model' }), subagent('alone'),
  ], [request('r1', 'sub', 'working')])
  // The parent counts its subagent's request, so it has work.
  assert.deepEqual(ids(board.withWork), ['main'])
  assert.deepEqual(board.withWork[0].subagents.map((entry) => entry.agent.id), ['sub'])
  assert.equal(board.withWork[0].total, 1)
  // A link to a nested agent, a link to itself and a link to no agent are not followed: each is a card.
  assert.deepEqual(ids(board.idle), ['sub-of-sub', 'self', 'to-nobody', 'alone'])
  assert.equal(board.idleAgents, 4)
})

test('the idle count counts the subagents folded under an idle parent', () => {
  const board = agentBoard([agent('main'), subagent('s1', { parentId: 'main' }), subagent('s2', { parentId: 'main' })], [])
  assert.deepEqual(ids(board.idle), ['main'])
  assert.equal(board.idleAgents, 3)
})

