import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planItems } from './plan-items.ts'
import type { PlanProposal } from '../data.ts'

const AREAS = [{ id: 'a', name: 'Viewer' }, { id: 'b', name: 'Sync' }]
const PROPOSALS: PlanProposal[] = [
  { kind: 'next-asks', focusAreaId: 'a', asks: [{ text: 'List what is open.', reason: 'Two have no next step.' }, { text: 'Ship the list.', reason: 'It is reviewed.' }] },
  { kind: 'goal', focusAreaId: 'a', goal: 'Everything can be checked.', reason: 'The goal names the work.' },
  { kind: 'reorder', focusAreaIds: ['b', 'a'], moves: [{ focusAreaId: 'b', reason: 'A review waits there.' }] },
]

test('proposals list by kind, each with its reasoning and the change Accept would save', () => {
  const items = planItems({ proposals: PROPOSALS }, AREAS)
  assert.deepEqual(items.map((item) => item.kind), ['reorder', 'goal', 'next-asks', 'next-asks'])
  assert.deepEqual(items[0], { key: 'reorder:2', kind: 'reorder', areaName: null, text: 'Sync → Viewer', reasons: ['Sync: A review waits there.'], change: { action: 'reorder', focusAreaIds: ['b', 'a'] } })
  assert.deepEqual(items[1], { key: 'goal:1', kind: 'goal', areaName: 'Viewer', text: 'Everything can be checked.', reasons: ['The goal names the work.'], change: { action: 'edit-goal', focusAreaId: 'a', goal: 'Everything can be checked.' } })
})

test('each next ask is its own line that nothing applies', () => {
  const asks = planItems({ proposals: PROPOSALS }, AREAS).filter((item) => item.kind === 'next-asks')
  assert.deepEqual(asks.map((item) => [item.key, item.text, item.change]), [['next-asks:0:0', 'List what is open.', null], ['next-asks:0:1', 'Ship the list.', null]])
})

test('an area the model no longer holds shows by its id', () => {
  assert.equal(planItems({ proposals: [PROPOSALS[1]] }, [])[0].areaName, 'a')
})
