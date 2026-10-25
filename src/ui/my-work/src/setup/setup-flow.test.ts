// Run with `npm test`. The funnel step machine (install-funnel plan Phase 3, item 1).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { choiceLocked, guardStep, initialFlowState, nextAfterSavings, type SetupFlowState } from './setup-flow.ts'

const state = (changes: Partial<SetupFlowState> = {}): SetupFlowState => ({ ...initialFlowState(false), ...changes })
const decided = (changes: Partial<SetupFlowState> = {}) => state({ scanComplete: true, revealContinued: true, choiceContinued: true, savingsComplete: true, ...changes })

describe('nextAfterSavings', () => {
  it('sends On The Go to checkout and At Home straight to Finish Setup', () => {
    assert.equal(nextAfterSavings({ branch: 'go', alreadyPro: false }), 'checkout')
    assert.equal(nextAfterSavings({ branch: 'home', alreadyPro: false }), 'finish-setup')
  })
  it('skips checkout for people already on Pro', () => {
    assert.equal(nextAfterSavings({ branch: 'go', alreadyPro: true }), 'finish-setup')
  })
})

describe('guardStep', () => {
  it('holds every step behind a finished scan', () => {
    assert.equal(guardStep('reveal', state()), 'scan')
    assert.equal(guardStep('workspace', state()), 'scan')
    assert.equal(guardStep('reveal', state({ scanComplete: true })), 'reveal')
  })
  it('walks back to the first decision still open', () => {
    assert.equal(guardStep('choice', state({ scanComplete: true })), 'reveal')
    assert.equal(guardStep('savings', state({ scanComplete: true, revealContinued: true })), 'choice')
    assert.equal(guardStep('finish-setup', state({ scanComplete: true, revealContinued: true, choiceContinued: true })), 'savings')
  })
  it('shows checkout only on On The Go, and requires it there before Finish Setup', () => {
    assert.equal(guardStep('checkout', decided({ branch: 'home' })), 'finish-setup')
    assert.equal(guardStep('finish-setup', decided({ branch: 'go' })), 'checkout')
    assert.equal(guardStep('finish-setup', decided({ branch: 'go', checkoutReviewed: true })), 'finish-setup')
    assert.equal(guardStep('finish-setup', decided({ branch: 'go', alreadyPro: true })), 'finish-setup')
    assert.equal(guardStep('checkout', decided({ branch: 'go', alreadyPro: true })), 'finish-setup')
  })
  it('shows the import step only while an On The Go import runs', () => {
    assert.equal(guardStep('import', decided({ branch: 'home', importStatus: 'running' })), 'finish-setup')
    assert.equal(guardStep('import', decided({ branch: 'go', checkoutReviewed: true, importStatus: 'available' })), 'finish-setup')
    assert.equal(guardStep('import', decided({ branch: 'go', checkoutReviewed: true, importStatus: 'running' })), 'import')
  })
  it('opens the launch and workspace only after setup completes with a tool picked', () => {
    assert.equal(guardStep('workspace', decided({ branch: 'home', setupComplete: true })), 'finish-setup')
    assert.equal(guardStep('workspace', decided({ branch: 'home', finishTools: ['claude-code'] })), 'finish-setup')
    assert.equal(guardStep('launch', decided({ branch: 'home', setupComplete: true, finishTools: ['claude-code'] })), 'launch')
    assert.equal(guardStep('workspace', decided({ branch: 'home', setupComplete: true, finishTools: ['claude-code'] })), 'workspace')
  })
})

describe('choiceLocked', () => {
  it('locks the choice once the installer applied it, and not while it waits or after it failed', () => {
    assert.equal(choiceLocked(null), false)
    assert.equal(choiceLocked('waiting-for-choice'), false)
    assert.equal(choiceLocked('failed'), false)
    for (const stage of ['home-ready', 'go-kept-existing-pro', 'go-awaiting-checkout'] as const) assert.equal(choiceLocked(stage), true)
  })
})
