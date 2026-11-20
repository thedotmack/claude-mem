// Run with `npm test`. The savings screen's view of the scan's token usage (install-funnel plan Phase 7).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { toSetupUsage, type SetupScanUsage } from './setup-usage.ts'

const agents = [
  { id: 'claude-code', label: 'Claude Code', detected: true, recordsTokens: true, tokens: 61_200_000 },
  { id: 'codex', label: 'Codex', detected: true, recordsTokens: true, tokens: 0 },
  { id: 'antigravity-cli', label: 'Antigravity CLI', detected: true, recordsTokens: false, tokens: 0 },
]
const usage = (changes: Partial<SetupScanUsage>): SetupScanUsage => ({ windowDays: 30, agents, totalTokens: 61_200_000, coverage: 'complete', persona: 'Heavy AI User', efficiencyPercent: null, ...changes })

describe('token usage on the savings screen', () => {
  it('complete history: period names the agents that used tokens, with the persona', () => {
    assert.deepEqual(toSetupUsage(usage({ efficiencyPercent: 42 })), { coverage: 'complete', periodLabel: 'Last 30 days · Claude Code', tokens: 61_200_000, persona: 'Heavy AI User', efficiencyPercent: 42 })
  })
  it('partial history: no persona and no period', () => {
    assert.deepEqual(toSetupUsage(usage({ coverage: 'partial', persona: 'Heavy AI User' })), { coverage: 'partial', periodLabel: 'Usage history is incomplete.', tokens: 61_200_000, persona: null, efficiencyPercent: null })
  })
  it('no history: no persona, no percent', () => {
    assert.deepEqual(toSetupUsage(usage({ coverage: 'none', totalTokens: 0, persona: null, efficiencyPercent: 0 })), { coverage: 'none', periodLabel: 'No usage history found.', tokens: 0, persona: null, efficiencyPercent: null })
  })
})
