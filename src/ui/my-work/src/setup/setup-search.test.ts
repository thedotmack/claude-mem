// Run with `npm test`. "What's next?" results from the worker's search (install-funnel plan Phase 10).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { noteFor, searchUrl, toMemoryResults } from './setup-search.ts'

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
  it('asks the worker for JSON, and a kept note is a new memory under the same project', () => {
    assert.equal(searchUrl('ship it'), '/api/search?query=ship+it&format=json&limit=10')
    assert.deepEqual(noteFor({ id: 'prompt-9', title: 'Ship it', body: 'x', project: 'alpha', agent: 'Codex', session: 's', date: '2026-10-22' }, 'edited'), { title: 'Note: Ship it', text: 'edited', project: 'alpha' })
  })
})
