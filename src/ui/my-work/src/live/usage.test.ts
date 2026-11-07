// Run with `npm test`. The body the viewer sends to POST /api/work-view/usage (WorkViewRoutes.ts) for each page it shows.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resetDocumentUsageForTests, usageReport, usageRequestBody } from './usage.ts'

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

test('one document sends a single open, and the hosted viewer sends the pageview with it', () => {
  resetDocumentUsageForTests()
  const open = { event: 'opened' as const, view: 'work' as const }
  assert.deepEqual(usageRequestBody(open, false), [open])
  assert.equal(usageRequestBody(open, false), null)
  assert.deepEqual(usageRequestBody({ event: 'switched', view: 'rules', previousView: 'work' }, false), [
    { event: 'switched', view: 'rules', previousView: 'work' },
  ])
  resetDocumentUsageForTests()
  assert.deepEqual(usageRequestBody(open, true), [{ event: 'pageview' }, open])
  assert.equal(usageRequestBody({ event: 'opened', view: 'setup' }, true), null)
})
