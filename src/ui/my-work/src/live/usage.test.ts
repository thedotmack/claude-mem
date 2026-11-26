// Run with `npm test`. The body the viewer sends to POST /api/work-view/usage (WorkViewRoutes.ts) for each page it shows.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hostedPlansReport, resetDocumentUsageForTests, usageRequestBody } from './usage.ts'

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

test('the hosted offer\'s plans click names the kept Cloud Sync plan and nothing else', () => {
  assert.deepEqual(hostedPlansReport('cloud_sync_annual'), { event: 'view_hosted_plans', cloudSyncOffer: 'cloud_sync_annual' })
  assert.deepEqual(hostedPlansReport(undefined), { event: 'view_hosted_plans' })
  assert.equal('cloudSyncOffer' in hostedPlansReport(undefined), false)
})
