// Run with `npm test`. "What's next?" results from the worker's search (install-funnel plan Phase 10).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { jsonTextBytes, keptNoteText, keptNoteTextMaxBytes, noteFor, searchUrl, toMemoryResults, type MemoryResult } from './setup-search.ts'
import { CONTENT_BODY_MAX_BYTES } from '../../../../shared/cloud-sync-limits.ts'

describe('What\'s next? search', () => {
  it('maps memory and imported prompts into result cards, observations first', () => {
    const results = toMemoryResults({
      observations: [{ id: 7, title: 'Scan reads every agent', narrative: 'The setup scan reads five agents.', project: 'claude-mem', memory_session_id: 'abcdef123456', created_at: '2026-10-20T10:00:00.000Z' }],
      sessions: [{ id: 3, request: 'Ship the funnel', learned: 'Checkout rides the pairing.', project: 'claude-mem', created_at: '2026-10-21T10:00:00.000Z' }],
      prompts: [{ id: 9, prompt_text: 'make the scan screen show each agent\nand the counts', project: 'alpha', content_session_id: '11111111-aaaa', platform_source: 'codex', created_at: '2026-10-22T10:00:00.000Z' }, { id: 10, prompt_text: '   ' }],
    })
    assert.deepEqual(results.map((result) => [result.id, result.title, result.agent, result.session, result.date]), [
      ['observation-7', 'Scan reads every agent', 'Claude-Mem', 'abcdef12', '2026-10-20'],
      ['summary-3', 'Ship the funnel', 'Claude-Mem', 'session', '2026-10-21'],
      ['prompt-9', 'make the scan screen show each agent', 'Codex', '11111111', '2026-10-22'],
    ])
    assert.equal(results[2].body, 'make the scan screen show each agent\nand the counts')
  })
  it('attributes imported prompts to their stored platform, including integrations outside the display table', () => {
    const platforms = ['cursor', 'hermes', 'local-agent', 'constructor', null]
    const rows = toMemoryResults({ prompts: platforms.map((platform_source, id) => ({ id, prompt_text: 'search me', platform_source })) })
    assert.deepEqual(rows.map(row => row.agent), ['Cursor', 'Hermes', 'local-agent', 'constructor', 'Claude-Mem'])
  })
  it('asks the worker for JSON, and a kept note is a new memory under the same project', () => {
    assert.equal(searchUrl('ship it'), '/api/search?query=ship+it&format=json&limit=10')
    assert.deepEqual(noteFor({ id: 'prompt-9', title: 'Ship it', body: 'x', project: 'alpha', agent: 'Codex', session: 's', date: '2026-10-22' }, 'edited'), { title: 'Note: Ship it', text: 'edited', project: 'alpha' })
  })
})

describe('a kept note stays one synced record', () => {
  const record = (changes: Partial<MemoryResult> = {}): MemoryResult => ({ id: 'observation-1', title: 'Signup screens', body: 'b', project: 'onboarding', agent: 'Codex', session: 'abc', date: '2026-10-21', ...changes })
  /** Text past every limit, in characters that take 3 (CJK), 4 (an emoji: two UTF-16 units), 2 (a newline) and 6 (a control character) bytes. */
  const paste = '日本語の記録😀\n\u0001'.repeat(40_000)

  it('keeps a note that fits as it is', () => {
    assert.deepEqual(keptNoteText(record(), 'Ship the signup screens.'), { text: 'Ship the signup screens.', cut: false })
  })

  it('cuts multi-byte text between characters to the most that fits, and says so', () => {
    const max = keptNoteTextMaxBytes(record())
    assert.ok(max < CONTENT_BODY_MAX_BYTES)
    for (const text of [paste, '日'.repeat(100_000), '😀'.repeat(70_000), 'x'.repeat(300_000)]) {
      const kept = keptNoteText(record(), text)
      assert.equal(kept.cut, true)
      assert.ok(text.startsWith(kept.text))
      assert.ok(jsonTextBytes(kept.text) <= max, `${jsonTextBytes(kept.text)} > ${max}`)
      // The next character would not fit, so the cut keeps all it can.
      const next = String.fromCodePoint(text.codePointAt(kept.text.length)!)
      assert.ok(jsonTextBytes(kept.text + next) > max)
      // Never half an emoji.
      assert.doesNotMatch(kept.text.slice(-1), /[\uD800-\uDBFF]/)
    }
  })

  it('leaves room for the note\'s own title and its project, which the record holds twice', () => {
    const short = keptNoteTextMaxBytes(record())
    const longProject = keptNoteTextMaxBytes(record({ project: 'onboarding-é'.repeat(10) }))
    assert.equal(short - longProject, 2 * (jsonTextBytes('onboarding-é'.repeat(10)) - jsonTextBytes('onboarding')))
    const longTitle = keptNoteTextMaxBytes(record({ title: '"引用"'.repeat(80) }))
    assert.equal(short - longTitle, jsonTextBytes(noteFor(record({ title: '"引用"'.repeat(80) }), '').title) - jsonTextBytes('Note: Signup screens'))
  })
})
