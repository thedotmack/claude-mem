// A malformed work-view frame is skipped with a warning, never thrown:
// EventSource listeners run outside React's error boundaries, so a throw
// escapes the handler. The warning names the event type but never the body.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { applySseFrame, parseSseFrame } from './parse-sse-frame.ts'
import { revealFromSnapshot, type SnapshotWithSetup } from '../setup/setup-reveal.ts'

describe('parseSseFrame', () => {
  const originalWarn = console.warn
  let warnings: string[]

  beforeEach(() => {
    warnings = []
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  })

  afterEach(() => {
    console.warn = originalWarn
  })

  it('parses a JSON object frame without warning', () => {
    assert.deepEqual(parseSseFrame('setup-scan', '{"phase":"idle","percent":40}'), { phase: 'idle', percent: 40 })
    assert.deepEqual(warnings, [])
  })

  it('skips a frame that is not JSON and warns with the event type only', () => {
    assert.equal(parseSseFrame('setup-scan', '<html>502 Bad Gateway secret-prompt</html>'), null)
    assert.equal(parseSseFrame('work-view', ''), null)
    assert.equal(warnings.length, 2)
    assert.match(warnings[0], /setup-scan/)
    assert.match(warnings[1], /work-view/)
    assert.ok(!warnings.some((line) => line.includes('secret-prompt')))
  })

  it('skips JSON that is not an object, with a warning', () => {
    for (const raw of ['null', '[]', '42', '"text"']) {
      assert.equal(parseSseFrame('setup-state', raw), null)
    }
    assert.equal(warnings.length, 4)
    assert.ok(warnings.every((line) => line.includes('setup-state')))
  })

  it('an unreadable setup work projection preserves landed results and a later valid frame still applies', () => {
    let shown = 'previously landed areas'
    const apply = (snapshot: SnapshotWithSetup) => {
      revealFromSnapshot(snapshot)
      shown = 'new areas'
    }
    assert.doesNotThrow(() => applySseFrame('work-view', '{"secret-prompt":"private"}', apply))
    assert.equal(shown, 'previously landed areas')
    applySseFrame('work-view', JSON.stringify({
      version: 1, generatedAt: '2026-10-22T00:00:00Z', revision: '1', agents: [], humanRequests: [],
      source: { connected: true, error: null },
    }), apply)
    assert.equal(shown, 'new areas')
    assert.deepEqual(warnings, ['[work-view] Ignoring an unreadable work-view frame'])
    assert.ok(!warnings.some((line) => line.includes('private') || line.includes('secret-prompt')))
  })

  it('a frame rejected by its shape guard never reaches its consumer', () => {
    let called = false
    applySseFrame('work-view', '{}', () => { called = true }, (frame) => Array.isArray(frame.humanRequests))
    assert.equal(called, false)
    assert.deepEqual(warnings, ['[work-view] Ignoring a work-view frame with an unexpected shape'])
  })
})
