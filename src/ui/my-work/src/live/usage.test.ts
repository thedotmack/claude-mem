// Run with `npm test`. The body the viewer sends to POST /api/work-view/usage (WorkViewRoutes.ts) for each page it shows.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { usageReport } from './usage.ts'

test('the first page shown is an open, with only the page id', () => {
  assert.deepEqual(usageReport('work', null), { event: 'opened', view: 'work' })
  assert.deepEqual(usageReport('setup', null), { event: 'opened', view: 'setup' })
})

test('a later page is a switch that names the page it left', () => {
  assert.deepEqual(usageReport('suggested', 'work'), { event: 'switched', view: 'suggested', previousView: 'work' })
  assert.deepEqual(usageReport('work', 'setup'), { event: 'switched', view: 'work', previousView: 'setup' })
})

test('showing the page already on screen is nothing to count', () => {
  assert.equal(usageReport('rules', 'rules'), null)
})
