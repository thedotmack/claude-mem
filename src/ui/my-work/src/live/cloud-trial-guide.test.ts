import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextTrialGuideStepAt, trialGuideStep } from './cloud-trial-guide.ts'

test('the guide follows elapsed trial days, including the instant each new step starts', () => {
  const start = '2026-04-20T18:31:59.000Z'
  const at = (day: number) => Date.parse(start) + (day - 1) * 86_400_000
  for (const [today, step, next] of [[1, 1, 3], [2, 1, 3], [3, 3, 6], [5, 3, 6], [6, 6, 7], [7, 7, 10], [9, 7, 10], [10, 10, 14], [13, 10, 14], [14, 14, 0], [30, 14, 0]]) {
    assert.equal(trialGuideStep(start, at(today)).day, step)
    assert.equal(nextTrialGuideStepAt(start, at(today)), next ? at(next) : undefined)
  }
  assert.equal(trialGuideStep(start, at(3) - 1).day, 1)
})
