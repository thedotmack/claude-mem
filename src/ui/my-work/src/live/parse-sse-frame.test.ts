// A malformed work-view frame must be dropped, never thrown: EventSource
// listeners run outside React's error boundaries, so a throw escapes the handler.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSseFrame } from './parse-sse-frame.ts'

describe('parseSseFrame', () => {
  it('parses a JSON frame', () => {
    assert.deepEqual(parseSseFrame('{"phase":"idle","percent":40}'), { phase: 'idle', percent: 40 })
  })

  it('drops a frame that is not JSON instead of throwing', () => {
    assert.equal(parseSseFrame('<html>502 Bad Gateway</html>'), null)
    assert.equal(parseSseFrame(''), null)
  })
})
