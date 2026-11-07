// The shared page keeps to its area (R17.3) and carries display text only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sampleSource } from './sample-source.ts'
import { canShareArea, titleQuotesPrompt, toSharedFocusPage } from './to-shared-focus.ts'

const NOW = Date.parse('2026-10-29T20:00:00Z')

test('only requests placed in the area: none from other areas, Other or Sorting…', async () => {
  const model = await sampleSource.loadWorkModel()
  const page = toSharedFocusPage(model, 'fa-viewer', NOW)!
  assert.deepEqual(page.requests.map((request) => request.id).sort(), ['r1', 'r4'])
  assert.equal(page.area.name, model.focusAreas.find((area) => area.id === 'fa-viewer')!.name)
  assert.equal(page.area.shipped, 1)
  assert.equal(page.generatedAt, '2026-10-29T20:00:00.000Z')
})

test('a request that lands in the area later shows up, and one moved out leaves', async () => {
  const model = await sampleSource.loadWorkModel()
  const landed = { ...model, requests: model.requests.map((request) => request.id === 'r5' ? { ...request, focusAreaId: 'fa-viewer' } : request) }
  assert.ok(toSharedFocusPage(landed, 'fa-viewer', NOW)!.requests.some((request) => request.id === 'r5'))
  const movedOut = { ...model, requests: model.requests.map((request) => request.id === 'r1' ? { ...request, focusAreaId: 'fa-sync' } : request) }
  assert.ok(!toSharedFocusPage(movedOut, 'fa-viewer', NOW)!.requests.some((request) => request.id === 'r1'))
})

test('requests in an area merged into this one count as its own, as My Work shows them', async () => {
  const model = await sampleSource.loadWorkModel()
  const merged = { ...model, focusAreas: model.focusAreas.map((area) => area.id === 'fa-sync' ? { ...area, mergedInto: 'fa-viewer' } : area) }
  assert.deepEqual(toSharedFocusPage(merged, 'fa-viewer', NOW)!.requests.map((request) => request.id).sort(), ['r1', 'r3', 'r4'])
  assert.equal(toSharedFocusPage(merged, 'fa-sync', NOW), null, 'a merged-away area is not shared')
})

test('closed requests stay off the page but still count in the rollup, like the area header', async () => {
  const model = await sampleSource.loadWorkModel()
  const closed = { ...model, requests: model.requests.map((request) => request.id === 'r4' ? { ...request, closed: true } : request) }
  const page = toSharedFocusPage(closed, 'fa-viewer', NOW)!
  assert.deepEqual(page.requests.map((request) => request.id), ['r1'])
  assert.equal(page.area.progress.total, 2)
})

test("the owner's own words and private detail never leave", async () => {
  const model = await sampleSource.loadWorkModel()
  const page = toSharedFocusPage(model, 'fa-viewer', NOW)!
  const text = JSON.stringify(page)
  const area = model.focusAreas.find((entry) => entry.id === 'fa-viewer')!
  for (const quote of [...area.quotes, ...area.asks.flatMap((ask) => ask.quotes)]) assert.ok(!text.includes(quote.quote), `quote left: ${quote.quote}`)
  for (const request of model.requests) {
    for (const prompt of request.prompts) assert.ok(!text.includes(prompt.quote), `prompt left: ${prompt.quote}`)
    for (const line of request.terminal) assert.ok(!text.includes(line), `terminal line left: ${line}`)
  }
  for (const device of model.devices) assert.ok(!text.includes(device.name), `machine name left: ${device.name}`)
  assert.deepEqual(Object.keys(page.requests[0]).sort(), ['agent', 'completedAt', 'id', 'next', 'percent', 'runningFor', 'stage', 'startedAt', 'state', 'summary', 'title'])
  assert.deepEqual(Object.keys(page.notStarted[0]).sort(), ['id', 'latestAt', 'timesAsked', 'title'])
})

test('Other, suggestions and unknown areas cannot be shared', async () => {
  const model = await sampleSource.loadWorkModel()
  assert.equal(toSharedFocusPage(model, 'other', NOW), null)
  assert.equal(toSharedFocusPage(model, 'fa-team', NOW), null)
  assert.equal(toSharedFocusPage(model, 'nope', NOW), null)
  assert.ok(canShareArea(model.focusAreas.find((area) => area.id === 'fa-fixes')), 'a done area can still be shared')
})

test('a title that repeats the owner\'s prompt stays home; a written title goes out', async () => {
  const model = await sampleSource.loadWorkModel()
  const prompt = 'Fix the **login** redirect loop. It breaks on Safari for everyone at work.'
  const copied = { ...model, requests: model.requests.map((request) => request.id === 'r1' ? { ...request, title: 'Fix the login redirect loop.', prompts: [{ at: 'now', quote: prompt }] } : request) }
  const page = toSharedFocusPage(copied, 'fa-viewer', NOW)!
  assert.equal(page.requests.find((request) => request.id === 'r1')!.title, 'Untitled request')
  assert.ok(!JSON.stringify(page).includes('redirect loop'))
  assert.ok(titleQuotesPrompt('Fix the login redirect…', [{ quote: prompt }]), 'a cut title still counts as the prompt')
  const written = { ...model, requests: model.requests.map((request) => request.id === 'r1' ? { ...request, title: 'Safari sign-in fixed', prompts: [{ at: 'now', quote: prompt }] } : request) }
  assert.equal(toSharedFocusPage(written, 'fa-viewer', NOW)!.requests.find((request) => request.id === 'r1')!.title, 'Safari sign-in fixed')
})

test('a title that repeats a prompt past the quoted part, an echoing ask or an echoing goal stays home', async () => {
  const model = await sampleSource.loadWorkModel()
  const flagged = { ...model, requests: model.requests.map((request) => request.id === 'r1' ? { ...request, title: 'Ship the private beta to Acme', titleRepeatsPrompt: true } : request) }
  assert.equal(toSharedFocusPage(flagged, 'fa-viewer', NOW)!.requests.find((request) => request.id === 'r1')!.title, 'Untitled request')
  const quote = { at: 'now', quote: 'Get the board deck to Acme by Friday, please.' }
  const echoing = { ...model, focusAreas: model.focusAreas.map((area) => area.id === 'fa-viewer'
    ? { ...area, goal: 'Get the board deck to Acme by Friday', quotes: [quote], asks: [{ id: 'ask-x', title: 'board deck to Acme', timesAsked: 2, latestAt: '', quotes: [quote] }] }
    : area) }
  const page = toSharedFocusPage(echoing, 'fa-viewer', NOW)!
  assert.equal(page.area.goal, null)
  assert.deepEqual(page.notStarted.map((ask) => ask.title), ['Untitled ask'])
  assert.ok(!JSON.stringify(page).includes('Acme'))
})
