// Run with `npm test`. Risk is the row's leading dot and nothing else on the row.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { RISK_LEVELS } from '../data.ts'
import { RISK, riskDot, riskLabel, UNRATED } from './risk.ts'

describe('the risk dot', () => {
  it('is green, amber or red by the review\'s level', () => {
    assert.deepEqual(RISK_LEVELS.map((level) => riskDot({ level, reason: '' })), ['bg-risk-low', 'bg-risk-medium', 'bg-risk-high'])
  })

  it('is a hollow muted ring, never a level\'s colour, when no review rated the request', () => {
    assert.equal(riskDot(undefined), UNRATED.dot)
    assert.match(riskDot(undefined), /bg-transparent/)
    assert.doesNotMatch(riskDot(undefined), /risk-/)
  })

  it('says the level and the review\'s reason, or that it is not rated', () => {
    assert.equal(riskLabel({ level: 'high', reason: 'Touches billing.' }), 'Risk: high. Touches billing.')
    assert.equal(riskLabel({ level: 'low', reason: '' }), 'Risk: low')
    assert.equal(riskLabel(undefined), 'Not rated yet')
    const words: Record<string, string> = { 'Risk: medium': 'Risiko: mittel', 'Not rated yet': 'Noch nicht bewertet' }
    const translate = (text: string) => words[text] ?? text
    assert.equal(riskLabel({ level: 'medium', reason: 'Neu.' }, translate), 'Risiko: mittel. Neu.')
    assert.equal(riskLabel(undefined, translate), 'Noch nicht bewertet')
  })
})

describe('no row is tinted by risk', () => {
  it('colours risk as a solid dot only: the table has no row tint and no translucent risk colour', () => {
    for (const level of RISK_LEVELS) {
      assert.deepEqual(Object.keys(RISK[level]).sort(), ['dot', 'label'])
      assert.doesNotMatch(RISK[level].dot, /\//)
    }
  })

  for (const file of ['thread-list.tsx', 'thread-board.tsx']) {
    it(`${file} names no risk colour of its own, so a row or card can only get one through the dot`, () => {
      const source = readFileSync(new URL(`../components/${file}`, import.meta.url), 'utf8')
      assert.doesNotMatch(source, /risk-(low|medium|high)/)
      assert.match(source, /riskDot\(|RiskDot/)
    })
  }
})
