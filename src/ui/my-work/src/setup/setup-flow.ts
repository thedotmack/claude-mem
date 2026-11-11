// The install funnel's step machine. `guardStep` and `nextAfterSavings` copy PROTO
// finish-setup-revision-09/finish-setup.js:3-23 (`guardRoute`, `nextAfterSavings`), adapted to the decided path in
// .scratch/funnel-gui/SCREEN-PATH.md, with the initial installation added: Install → Scan → Reveal → Storage choice → Token Savings (result only) → Checkout (On The
// Go only) → Finish Setup → Import (only when there is history to import) → Launch → What's next?.
// The retired PROTO routes (savings selection, the second usage scan, device, tools, home, trial, cloud-sync) are gone.

import { SETUP_STEPS, type SetupBranch, type SetupInstallerStage, type SetupMemoryBilling, type SetupStep } from '../../../../shared/setup-funnel.ts'
export { SETUP_STEPS, type SetupStep }

export type MemoryBranch = SetupBranch
/** Who generates memories: CMEM Pro (hosted) or the person's own token plan. On The Go is always hosted (gap G1). */
export type MemoryBilling = SetupMemoryBilling
export type HistoryImportStatus = 'none' | 'available' | 'running' | 'complete' | 'skipped'

export interface SetupFlowState {
  /** Agent integrations must finish installing before the memory scan begins. */
  installationComplete: boolean
  branch: MemoryBranch
  memoryBilling: MemoryBilling
  /** Already paying for Pro: On The Go is pre-selected and checkout is skipped. */
  alreadyPro: boolean
  /** The prompt scan finished without an error. */
  scanComplete: boolean
  revealContinued: boolean
  choiceContinued: boolean
  savingsComplete: boolean
  checkoutReviewed: boolean
  finishTools: string[]
  importStatus: HistoryImportStatus
  setupComplete: boolean
}

export function initialFlowState(alreadyPro: boolean): SetupFlowState {
  return {
    installationComplete: true, branch: 'go', memoryBilling: 'hosted', alreadyPro, scanComplete: false, revealContinued: false, choiceContinued: false,
    savingsComplete: false, checkoutReviewed: false, finishTools: [], importStatus: 'none', setupComplete: false,
  }
}

export function nextAfterSavings(state: Pick<SetupFlowState, 'branch' | 'alreadyPro'>): 'checkout' | 'finish-setup' {
  return state.branch === 'go' && !state.alreadyPro ? 'checkout' : 'finish-setup'
}

/** The installer's report on the choice. */
export type InstallerStage = SetupInstallerStage

/** The installer has applied the choice: the worker refuses a different one for the rest of this installer run. */
export function choiceLocked(stage: InstallerStage | null | undefined): boolean {
  return !!stage && stage !== 'waiting-for-choice' && stage !== 'failed'
}

/** Restore the worker's committed storage choice without replacing a choice being edited in this visit. */
export function hydrateSetupChoice(state: SetupFlowState, saved: Pick<SetupFlowState, 'branch' | 'memoryBilling'> | null,
  locallyEdited: boolean, stage: InstallerStage | null | undefined): SetupFlowState {
  if (!saved || (locallyEdited && !choiceLocked(stage))
    || (state.branch === saved.branch && state.memoryBilling === saved.memoryBilling)) return state
  return { ...state, branch: saved.branch, memoryBilling: saved.memoryBilling }
}

const BEFORE_CHOICE: SetupStep[] = ['scan', 'reveal']
const AFTER_SAVINGS: SetupStep[] = ['checkout', 'finish-setup', 'import', 'launch', 'workspace']

/** The step to show for a requested step: an earlier one when a decision it depends on hasn't been made yet. */
export function guardStep(step: SetupStep, state: SetupFlowState): SetupStep {
  if (!state.installationComplete) return 'install'
  if (step === 'install') return state.scanComplete ? 'reveal' : 'scan'
  if (!SETUP_STEPS.includes(step)) return 'scan'
  if (step !== 'scan' && !state.scanComplete) return 'scan'
  if (!BEFORE_CHOICE.includes(step) && !state.revealContinued) return 'reveal'
  if (![...BEFORE_CHOICE, 'choice'].includes(step) && !state.choiceContinued) return 'choice'
  if (AFTER_SAVINGS.includes(step) && !state.savingsComplete) return 'savings'
  const afterSavings = nextAfterSavings(state)
  if (step === 'checkout' && afterSavings !== 'checkout') return afterSavings
  if (step !== 'checkout' && AFTER_SAVINGS.includes(step) && afterSavings === 'checkout' && !state.checkoutReviewed) return 'checkout'
  if (step === 'import' && (state.branch !== 'go' || state.importStatus !== 'running')) return 'finish-setup'
  if ((step === 'launch' || step === 'workspace') && (!state.setupComplete || state.finishTools.length === 0)) return 'finish-setup'
  return step
}

/** Which progress-bar item a step belongs to. The pass5 PNGs show the bar on Checkout and Finish Setup only. */
export function progressItemFor(step: SetupStep): 'checkout' | 'finish' | null {
  if (step === 'checkout') return 'checkout'
  if (step === 'finish-setup' || step === 'import') return 'finish'
  return null
}
