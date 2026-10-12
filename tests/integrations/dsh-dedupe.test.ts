// Adapted from Bleed00/dsh-claude-mem, Apache-2.0; see dsh/LICENSE.
import { describe, expect, it } from 'bun:test'
import { dedupeObservations, dedupeRenderedTable, observationFingerprint } from '../../src/integrations/dsh-plugin/dedupe.js'
import type { MemObservation } from '../../src/integrations/dsh-plugin/types.js'

function obs(id: number, over: Partial<MemObservation> = {}): MemObservation {
  return {
    id,
    title: 'Media prompt processing session initiated',
    narrative: 'Initialized observation session…',
    facts: ['Session type: media prompt observation'],
    ...over,
  }
}

describe('observationFingerprint', () => {
  it('is identical for same content regardless of id', () => {
    expect(observationFingerprint(obs(627))).toBe(observationFingerprint(obs(671)))
  })

  it('differs when narrative differs', () => {
    expect(observationFingerprint(obs(627))).not.toBe(observationFingerprint(obs(628, { narrative: 'Something else' })))
  })

  it('normalizes case and whitespace', () => {
    const a = obs(1, { title: '  Media Prompt Processing   Session Initiated ' })
    const b = obs(2, { title: 'media prompt processing session initiated' })
    expect(observationFingerprint(a)).toBe(observationFingerprint(b))
  })
})

describe('dedupeObservations', () => {
  it('keeps the first copy and drops identical later ones', () => {
    const items = [obs(627), obs(671), obs(715, { narrative: 'different work' })]
    const out = dedupeObservations(items)
    expect(out.map(i => i.id)).toEqual([627, 715])
  })

  it('preserves order', () => {
    const items = [obs(10), obs(20, { narrative: 'b' }), obs(11), obs(30, { narrative: 'c' })]
    expect(dedupeObservations(items).map(i => i.id)).toEqual([10, 20, 30])
  })

  it('never drops observations with empty content fingerprint', () => {
    const blank = { id: 1, title: '', narrative: '' } as MemObservation
    expect(dedupeObservations([blank, blank, blank]).length).toBe(3)
  })
})

describe('dedupeRenderedTable', () => {
  it('collapses index rows that differ only by id', () => {
    const text = [
      '| #627 | 12:22 PM | ◆ | Media prompt processing session initiated | ~144 |',
      '| #671 | ″ | ◆ | Media prompt processing session initiated | ~144 |',
      '| #715 | ″ | ◆ | Something real | ~144 |',
    ].join('\n')
    const out = dedupeRenderedTable(text)
    expect(out).toContain('#627')
    expect(out).not.toContain('#671')
    expect(out).toContain('#715')
  })

  it('leaves non-row lines untouched', () => {
    const text = 'Found 3 result(s)\n\n### Aug 11, 2026\n\n| #1 | x |'
    expect(dedupeRenderedTable(text)).toBe(text)
  })

  it('passes through empty/plain text unchanged', () => {
    expect(dedupeRenderedTable('No results found.')).toBe('No results found.')
  })
})
