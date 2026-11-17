// Run with `npm test`. The funnel step machine (install-funnel plan Phase 3, item 1).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PROGRESS_STEP_OF_SCREEN, PROGRESS_STEP_WORDS, SCAN_PHASE_RUNNING, SETUP_PROGRESS_STEPS, SETUP_STEPS, backWaitsFor, choiceLocked, guardStep,
  hydrateSetupChoice, initialFlowState, launchLengthMs, nextAfterSavings, previousStep, progressStepState, scanMovesOn, scanRunning, type SetupFlowState, type SetupStep,
} from './setup-flow.ts'
import type { SetupScanPhase } from '../../../../shared/setup-funnel.ts'

/** Every scan phase, from the one Record that decides which of them run (no list typed again here). */
const SCAN_PHASES = Object.keys(SCAN_PHASE_RUNNING) as SetupScanPhase[]

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
  it('holds every screen behind agent installation and opens the scan only when ready', () => {
    assert.equal(guardStep('scan', state({ installationComplete: false })), 'install')
    assert.equal(guardStep('workspace', decided({ installationComplete: false })), 'install')
    assert.equal(guardStep('install', state()), 'scan')
    assert.equal(guardStep('install', state({ scanComplete: true })), 'reveal')
  })
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

describe('saved storage choice', () => {
  const home = { branch: 'home' as const, memoryBilling: 'existing' as const }
  it('restores Home after a reload instead of submitting the default On The Go choice', () => {
    const restored = hydrateSetupChoice(state(), home, false, 'home-ready')
    assert.equal(restored.branch, 'home')
    assert.equal(restored.memoryBilling, 'existing')
    assert.equal(nextAfterSavings(restored), 'finish-setup')
  })
  it('preserves a choice being edited until the worker has locked its committed choice', () => {
    const edited = state({ branch: 'go', memoryBilling: 'hosted' })
    assert.equal(hydrateSetupChoice(edited, home, true, 'waiting-for-choice'), edited)
    assert.equal(hydrateSetupChoice(edited, home, true, 'failed'), edited)
    assert.equal(hydrateSetupChoice(edited, home, true, 'home-ready').branch, 'home')
  })
})

describe('step bar', () => {
  it('maps the ten screens onto its steps in order, every step reached by a screen and worded once', () => {
    assert.deepEqual(Object.keys(PROGRESS_STEP_WORDS), [...SETUP_PROGRESS_STEPS])
    // The order of the screens never runs backwards through the bar, and it starts and ends with the bar.
    const indexes = SETUP_STEPS.map((step) => SETUP_PROGRESS_STEPS.indexOf(PROGRESS_STEP_OF_SCREEN[step]))
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b))
    assert.equal(indexes[0], 0)
    assert.equal(indexes[indexes.length - 1], SETUP_PROGRESS_STEPS.length - 1)
    // No bar step is left without a screen.
    assert.deepEqual([...new Set(indexes)], SETUP_PROGRESS_STEPS.map((_, index) => index))
  })
  const states = (screen: SetupStep, flow: SetupFlowState) => SETUP_PROGRESS_STEPS.map((item) => progressStepState(item, screen, flow))
  it('ticks nothing on the first screen while installing', () => {
    assert.deepEqual(states('install', state({ installationComplete: false })), ['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming'])
  })
  it('ticks Tools only on the worker\'s word, never on a first load that could not reach it', () => {
    assert.deepEqual(states('scan', state({ installConfirmed: false })), ['upcoming', 'current', 'upcoming', 'upcoming', 'upcoming'])
  })
  it('ticks a step only after the person has done it', () => {
    assert.deepEqual(states('scan', state()), ['done', 'current', 'upcoming', 'upcoming', 'upcoming'])
    // Still on the Reveal: Memory is not ticked until its Continue.
    assert.deepEqual(states('reveal', state({ scanComplete: true })), ['done', 'current', 'upcoming', 'upcoming', 'upcoming'])
    assert.deepEqual(states('choice', state({ scanComplete: true, revealContinued: true })), ['done', 'done', 'current', 'upcoming', 'upcoming'])
    // On The Go: Plan stays open until checkout is done.
    assert.deepEqual(states('checkout', decided({ branch: 'go' })), ['done', 'done', 'current', 'upcoming', 'upcoming'])
    assert.deepEqual(states('finish-setup', decided({ branch: 'go', checkoutReviewed: true })), ['done', 'done', 'done', 'current', 'upcoming'])
    assert.deepEqual(states('finish-setup', decided({ branch: 'home' })), ['done', 'done', 'done', 'current', 'upcoming'])
    assert.deepEqual(states('workspace', decided({ branch: 'home', setupComplete: true, finishTools: ['claude-code'] })), ['done', 'done', 'done', 'done', 'current'])
  })
  it('shows a step current again when the person goes back to it', () => {
    assert.deepEqual(states('savings', decided({ branch: 'home' })), ['done', 'done', 'current', 'upcoming', 'upcoming'])
  })
})

describe('Back', () => {
  const facts = { hasInstallStep: true, choiceLocked: false }
  it('is hidden on the first screen and goes to the screen before on the person\'s path', () => {
    assert.equal(previousStep('install', state(), facts), null)
    assert.equal(previousStep('scan', state(), facts), 'install')
    assert.equal(previousStep('reveal', state({ scanComplete: true }), facts), 'scan')
    assert.equal(previousStep('choice', decided(), facts), 'reveal')
    assert.equal(previousStep('savings', decided(), facts), 'choice')
    assert.equal(previousStep('checkout', decided({ branch: 'go' }), facts), 'savings')
    assert.equal(previousStep('finish-setup', decided({ branch: 'go' }), facts), 'checkout')
    assert.equal(previousStep('finish-setup', decided({ branch: 'home' }), facts), 'savings')
    assert.equal(previousStep('finish-setup', decided({ branch: 'go', alreadyPro: true }), facts), 'savings')
    // Launch only plays forward, so Back from it or from the last screen returns to Finish Setup.
    for (const step of ['import', 'launch', 'workspace'] as const) assert.equal(previousStep(step, decided(), facts), 'finish-setup')
  })
  it('treats the scan as the first screen when this run had no install screen', () => {
    assert.equal(previousStep('scan', state(), { hasInstallStep: false, choiceLocked: false }), null)
  })
  it('does not offer Token Savings again once the installer applied the choice there', () => {
    assert.equal(previousStep('finish-setup', decided({ branch: 'home' }), { hasInstallStep: true, choiceLocked: true }), null)
    // On The Go still goes back to checkout, which can be opened again.
    assert.equal(previousStep('finish-setup', decided({ branch: 'go' }), { hasInstallStep: true, choiceLocked: true }), 'checkout')
  })
  it('does not offer the storage choice again from Token Savings once the installer applied it', () => {
    // Before the choice is sent (Token Savings sends it), the choice screen is one Back away.
    assert.equal(previousStep('savings', decided({ branch: 'go' }), { hasInstallStep: true, choiceLocked: false }), 'choice')
    // After: Checkout → Back → Token Savings stops there, as Finish Setup does.
    for (const branch of ['go', 'home'] as const) {
      assert.equal(previousStep('savings', decided({ branch }), { hasInstallStep: true, choiceLocked: true }), null, branch)
    }
    assert.equal(previousStep('checkout', decided({ branch: 'go' }), { hasInstallStep: true, choiceLocked: true }), 'savings')
  })
  it('lands on a screen guardStep shows, so Back never bounces', () => {
    const paths: Array<[SetupStep, SetupFlowState]> = [
      ['reveal', state({ scanComplete: true })],
      ['choice', state({ scanComplete: true, revealContinued: true })],
      ['savings', state({ scanComplete: true, revealContinued: true, choiceContinued: true })],
      ['checkout', decided({ branch: 'go' })],
      ['finish-setup', decided({ branch: 'go', checkoutReviewed: true })],
      ['finish-setup', decided({ branch: 'home' })],
      ['workspace', decided({ branch: 'home', setupComplete: true, finishTools: ['claude-code'] })],
    ]
    for (const [step, flow] of paths) {
      const target = previousStep(step, flow, facts)!
      assert.equal(guardStep(target, flow), target, `${step} → ${target}`)
    }
  })
  it('reaches the finished installation only to look at it, and the scan again from there', () => {
    assert.equal(guardStep('install', state()), 'scan')
    assert.equal(guardStep('install', state({ installReview: true })), 'install')
    assert.equal(guardStep('scan', state({ installReview: true })), 'scan')
  })
  it('waits exactly while the scan runs, and for the whole import, and says which', () => {
    for (const phase of SCAN_PHASES) {
      assert.equal(backWaitsFor('scan', phase), scanRunning(phase) ? 'scan' : null, phase)
      // The import screen shows only while its import runs, whatever the scan did.
      assert.equal(backWaitsFor('import', phase), 'import', phase)
      // No other screen waits for the scan.
      assert.equal(backWaitsFor('reveal', phase), null, phase)
    }
    // Some phases wait for the person (Back can be pressed) and some run.
    assert.ok(SCAN_PHASES.some(scanRunning))
    assert.ok(SCAN_PHASES.some((phase) => !scanRunning(phase)))
  })
  it('lands Back from the scan on a screen guardStep shows, with the page\'s review flag', () => {
    const done = state({ scanComplete: true, revealContinued: true })
    assert.equal(guardStep('install', { ...done, installReview: true }), 'install')
    assert.equal(guardStep('scan', { ...done, scanReview: true }), 'scan')
  })
})

describe('a finished scan moves on by itself', () => {
  const finished = { installationComplete: true, scanComplete: true, scanReview: false, installReview: false }
  it('opens the Reveal the moment the scan is done, from the scan screen or the opening request', () => {
    assert.equal(scanMovesOn('scan', finished), true)
    assert.equal(scanMovesOn('install', finished), true)
  })
  it('waits while the scan runs or the installation is not done', () => {
    assert.equal(scanMovesOn('scan', { ...finished, scanComplete: false }), false)
    assert.equal(scanMovesOn('install', { ...finished, installationComplete: false }), false)
  })
  it('stays on the scan or the installation the person came Back to look at', () => {
    assert.equal(scanMovesOn('scan', { ...finished, scanReview: true }), false)
    assert.equal(scanMovesOn('install', { ...finished, installReview: true }), false)
  })
  it('never moves a later screen', () => {
    for (const step of SETUP_STEPS.filter((step) => step !== 'scan' && step !== 'install')) assert.equal(scanMovesOn(step, finished), false, step)
  })
})

describe('scan skipped', () => {
  it('lets setup go on past a stopped scan only when the person chose to skip it', () => {
    assert.equal(guardStep('reveal', state()), 'scan')
    assert.equal(guardStep('reveal', state({ scanSkipped: true })), 'reveal')
    assert.equal(guardStep('install', state({ scanSkipped: true })), 'reveal')
    assert.equal(guardStep('choice', state({ scanSkipped: true, revealContinued: true })), 'choice')
  })
})

describe('launch length', () => {
  // Before Phase 8 the workspace opened when the launch's last animation ended (HEAD launch-screen.tsx:43-45): the logo
  // after 1,950 ms, or the last of n tools after 1,500 + 80 × (n − 1) ms. These are the numbers that must not move.
  it('keeps the logo\'s 1,950 ms up to six tools', () => {
    for (const tools of [1, 2, 6]) assert.equal(launchLengthMs(tools), 1950, `${tools} tools`)
  })
  it('waits for the last tool from seven tools on, as before Phase 8', () => {
    assert.equal(launchLengthMs(7), 1980)
    assert.equal(launchLengthMs(10), 2220)
  })
})
