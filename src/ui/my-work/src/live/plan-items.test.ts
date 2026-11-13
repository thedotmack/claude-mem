import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planItems } from './plan-items.ts'
import type { PlanProposal } from '../data.ts'

const AREAS = [{ id: 'a', name: 'Viewer' }, { id: 'b', name: 'Sync' }]
const PROPOSALS: PlanProposal[] = [
  { kind: 'next-asks', focusAreaId: 'a', asks: [{ text: 'List what is open.', reason: 'Two have no next step.' }, { text: 'Ship the list.', reason: 'It is reviewed.' }] },
  { kind: 'notes', focusAreaId: 'b', notes: 'Why: writes stall.', draft: true, quotes: ['sync keeps stalling'] },
  { kind: 'goal', focusAreaId: 'a', goal: 'Everything can be checked.', reason: 'The goal names the work.' },
  { kind: 'reorder', focusAreaIds: ['b', 'a'], moves: [{ focusAreaId: 'b', reason: 'A review waits there.' }] },
  { kind: 'initiative', initiative: 'Kite maps', focusAreaIds: ['a', 'b'], reason: 'One product, two folders.' },
]

test('proposals list by kind, each with its reasoning and the change Accept would save', () => {
  const items = planItems({ proposals: PROPOSALS }, AREAS)
  assert.deepEqual(items.map((item) => item.kind), ['reorder', 'initiative', 'goal', 'notes', 'next-asks', 'next-asks'])
  assert.deepEqual(items[0], { key: 'reorder:3', kind: 'reorder', areaName: null, text: 'Sync → Viewer', reasons: ['Sync: A review waits there.'], change: { action: 'reorder', focusAreaIds: ['b', 'a'] } })
  assert.deepEqual(items[1], { key: 'initiative:4', kind: 'initiative', areaName: 'Kite maps', text: 'Viewer, Sync', reasons: ['One product, two folders.'], change: { action: 'set-initiative', focusAreaIds: ['a', 'b'], initiative: 'Kite maps' } })
  assert.deepEqual(items[2].change, { action: 'edit-goal', focusAreaId: 'a', goal: 'Everything can be checked.' })
  assert.deepEqual([items[3].areaName, items[3].reasons, items[3].change], ['Sync', ['“sync keeps stalling”'], { action: 'edit-notes', focusAreaId: 'b', notes: 'Why: writes stall.' }])
})

test('each next ask is its own line that nothing applies', () => {
  const asks = planItems({ proposals: PROPOSALS }, AREAS).filter((item) => item.kind === 'next-asks')
  assert.deepEqual(asks.map((item) => [item.key, item.text, item.change]), [['next-asks:0:0', 'List what is open.', null], ['next-asks:0:1', 'Ship the list.', null]])
})

test('an area the model no longer holds shows by its id', () => {
  assert.equal(planItems({ proposals: [PROPOSALS[2]] }, [])[0].areaName, 'a')
})
