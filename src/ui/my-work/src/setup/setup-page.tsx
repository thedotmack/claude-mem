// The install funnel page (`?setup=1`), outside My Work's nav. Screens get their data through props from one source:
// the local worker, or the review fixtures with `?source=sample` (loaded by a dynamic import, so they are never in
// reach without the flag). The step machine is setup-flow.ts.
import { CheckIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CmemMark } from '@/components/brand'
import { EMPTY_SETUP_DATA, localSetupSource, SETUP_TOOLS, type SetupData, type SetupSource } from './setup-data'
import { choiceLocked, guardStep, initialFlowState, nextAfterSavings, progressItemFor, type MemoryBranch, type SetupFlowState, type SetupStep } from './setup-flow'
import { CheckoutScreen } from './screens/checkout-screen'
import { ChoiceScreen } from './screens/choice-screen'
import { FinishSetupScreen } from './screens/finish-setup-screen'
import { ImportScreen } from './screens/import-screen'
import { LaunchScreen } from './screens/launch-screen'
import { RevealScreen } from './screens/reveal-screen'
import { SavingsScreen } from './screens/savings-screen'
import { ScanScreen } from './screens/scan-screen'
import { prefersReducedMotion } from './format'
import { WorkspaceScreen } from './screens/workspace-screen'
import './setup.css'

const PARAMS = new URLSearchParams(window.location.search)
const SAMPLE_REQUESTED = PARAMS.get('source') === 'sample'

function useSetupSource(): SetupSource | null {
  const [source, setSource] = useState<SetupSource | null>(SAMPLE_REQUESTED ? null : localSetupSource)
  useEffect(() => {
    if (!SAMPLE_REQUESTED) return
    let current = true
    import('./setup-sample').then(({ createSampleSetupSource }) => { if (current) setSource(createSampleSetupSource(PARAMS.get('sample') === 'new', PARAMS.has('scan') ? Number(PARAMS.get('scan')) : null, (['partial', 'none'] as const).find((kind) => kind === PARAMS.get('usage')), PARAMS.get('agent') === 'none')) })
    return () => { current = false }
  }, [])
  return source
}

function ProgressBar({ step, branch, showCheckout }: { step: SetupStep; branch: MemoryBranch; showCheckout: boolean }) {
  const current = progressItemFor(step)
  if (!current) return null
  const items = [['memory', 'Memory'], ['savings', 'Token Savings'], ...(branch === 'go' && showCheckout ? [['checkout', 'Checkout']] : []), ['finish', 'Finish Setup']]
  const currentIndex = items.findIndex(([id]) => id === current)
  return (
    <nav aria-label="Setup progress">
      <ol className="progress">
        {items.map(([id, label], index) => (
          <li key={id} className={index < currentIndex ? 'is-done' : index === currentIndex ? 'is-current' : undefined} aria-current={index === currentIndex ? 'step' : undefined}>
            <span className="dot" aria-hidden="true">{index < currentIndex && <CheckIcon strokeWidth={3} />}</span>
            {label}
          </li>
        ))}
      </ol>
    </nav>
  )
}

export default function SetupPage({ onComplete }: { onComplete: () => void }) {
  const source = useSetupSource()
  const [data, setData] = useState<SetupData>(EMPTY_SETUP_DATA)
  useEffect(() => source?.subscribe(setData), [source])

  const [improveProduct, setImproveProduct] = useState<boolean | null>(null)
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  const preferenceRevision = useRef(0)
  const changeImproveProduct = async (checked: boolean) => {
    if (!source) return
    const revision = ++preferenceRevision.current
    // Keep the user's choice visible even if an earlier scan response arrives after their click.
    setImproveProduct(checked)
    setPreferenceError(null)
    try { await source.setImproveProduct(checked) } catch (error) {
      if (revision !== preferenceRevision.current) return
      setImproveProduct(null)
      setPreferenceError(`Could not save this choice: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const retryPending = useRef(false)
  const retryScan = async () => {
    if (!source || retryPending.current) return
    retryPending.current = true
    setRetrying(true)
    setRetryError(null)
    try { await source.retryScan() } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error))
    } finally {
      retryPending.current = false
      setRetrying(false)
    }
  }

  const [flow, setFlow] = useState<SetupFlowState>(() => initialFlowState(false))
  const [requested, setRequested] = useState<SetupStep>('scan')
  const update = (changes: Partial<SetupFlowState>, next?: SetupStep) => { setFlow((current) => ({ ...current, ...changes })); if (next) setRequested(next) }

  // Facts from the data, not decisions: they move the machine on as they arrive.
  const scanComplete = data.scan.done && data.scan.phase === 'done'
  const historyAvailable = !!data.history && data.history.observations > 0
  if (flow.scanComplete !== scanComplete || flow.alreadyPro !== data.alreadyPro) {
    setFlow((current) => ({ ...current, scanComplete, alreadyPro: data.alreadyPro, branch: data.alreadyPro ? 'go' : current.branch }))
  }
  if (flow.importStatus === 'none' && historyAvailable) setFlow((current) => ({ ...current, importStatus: 'available' }))
  if (requested === 'scan' && scanComplete) setRequested('reveal')
  // The terminal reports the On The Go checkout paid: Finish Setup is next.
  if (data.checkout?.state === 'paid' && !flow.checkoutReviewed) {
    setFlow((current) => ({ ...current, checkoutReviewed: true }))
    if (requested === 'checkout') setRequested('finish-setup')
  }
  // A stopped import goes back to Finish Setup with the reason; Import starts it again (re-sending is safe).
  if (requested === 'import' && data.historyImport?.error) {
    setFlow((current) => ({ ...current, importStatus: 'available' }))
    setRequested('finish-setup')
  }
  if (requested === 'import' && data.historyImport?.done) {
    setFlow((current) => ({ ...current, importStatus: 'complete' }))
    setRequested('finish-setup')
  }

  const step = guardStep(requested, flow)
  const tools = useMemo(() => SETUP_TOOLS.filter((tool) => flow.branch === 'go' || tool.kind === 'local'), [flow.branch])
  const pickedTools = useMemo(() => tools.filter((tool) => flow.finishTools.includes(tool.id)), [tools, flow.finishTools])

  // Each new step starts at the top, with focus on its title (PROTO renderRoute).
  const main = useRef<HTMLElement>(null)
  const shownStep = useRef<SetupStep | null>(null)
  useEffect(() => {
    if (shownStep.current === step) return
    const first = shownStep.current === null
    shownStep.current = step
    if (first) return
    window.scrollTo(0, 0)
    if (step !== 'workspace') main.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
  }, [step])

  // The terminal waits on these two hand-offs; a refusal stays on this screen and says why.
  const [handOffError, setHandOffError] = useState<string | null>(null)
  const handOff = async (send: () => Promise<void>): Promise<boolean> => {
    try { await send() } catch (error) { setHandOffError(error instanceof Error ? error.message : String(error)); return false }
    setHandOffError(null)
    return true
  }

  // Leaving Token Savings is when both halves of the choice are final, so that is when the installer gets it.
  const toFinishSetup = async (changes: Partial<SetupFlowState>) => {
    const merged = { ...flow, ...changes }
    if (!await handOff(() => source!.choose({ branch: merged.branch, memoryBilling: merged.memoryBilling }))) return
    // Detected tools come pre-ticked the first time Finish Setup opens for this branch.
    const available = SETUP_TOOLS.filter((tool) => merged.branch === 'go' || tool.kind === 'local').map((tool) => tool.id)
    const finishTools = merged.finishTools.length ? merged.finishTools.filter((id) => available.includes(id)) : data.detectedTools.filter((id) => available.includes(id))
    update({ ...changes, finishTools, savingsComplete: true }, nextAfterSavings(merged))
  }
  const finishSetup = async () => {
    update({ setupComplete: true })
    if (prefersReducedMotion()) { setRequested('workspace'); return }
    await main.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240 }).finished.catch(() => {})
    setRequested('launch')
  }

  // The installer stops after a failed hand-off (e.g. On The Go sign-in could not start); only the terminal can restart it.
  const installerFailed = data.installer?.stage === 'failed'

  const screens: Record<SetupStep, () => ReactNode> = {
    scan: () => <ScanScreen scan={{ ...data.scan, improveProduct: improveProduct ?? data.scan.improveProduct }} onImproveProductChange={(checked) => void changeImproveProduct(checked)} preferenceError={preferenceError} onRetry={() => void retryScan()} retrying={retrying} retryError={retryError} />,
    reveal: () => <RevealScreen agents={data.scan.agents} reveal={data.reveal} extraction={data.extraction} recentPrompts={data.recentPrompts} onContinue={() => update({ revealContinued: true }, 'choice')} />,
    choice: () => <ChoiceScreen branch={flow.branch} onChoose={(branch) => update({ branch, memoryBilling: branch === 'go' ? 'hosted' : 'existing', choiceContinued: true, savingsComplete: false, checkoutReviewed: false, setupComplete: false, finishTools: [] }, 'savings')} />,
    savings: () => (
      <SavingsScreen usage={data.usage} branch={flow.branch}
        onPro={() => void toFinishSetup({ branch: 'go', memoryBilling: 'hosted' })}
        onExistingPlan={() => void toFinishSetup({ memoryBilling: 'existing' })}
        onSkip={() => void toFinishSetup({})} />
    ),
    checkout: () => <CheckoutScreen checkout={data.checkout} installerStopped={installerFailed} onBack={() => setRequested('savings')} onContinue={() => void handOff(() => source!.checkout())} />,
    'finish-setup': () => (
      <FinishSetupScreen branch={flow.branch} tools={tools} selected={flow.finishTools} onSelect={(finishTools) => update({ finishTools })}
        history={flow.branch === 'go' && historyAvailable ? data.history : null} importStatus={flow.importStatus}
        importResult={data.historyImport}
        onImport={() => void handOff(() => source!.startHistoryImport()).then((started) => { if (started) update({ importStatus: 'running' }, 'import') })}
        onSkipImport={() => update({ importStatus: 'skipped' })}
        onBack={nextAfterSavings(flow) === 'checkout' ? () => setRequested('checkout') : choiceLocked(data.installer?.stage) ? undefined : () => setRequested('savings')}
        onContinue={() => void finishSetup()} />
    ),
    import: () => <ImportScreen progress={data.historyImport} />,
    launch: () => <LaunchScreen tools={pickedTools} onDone={() => setRequested('workspace')} />,
    workspace: () => <WorkspaceScreen suggestions={data.suggestions} search={(query) => source!.search(query)} keepNote={(record, text) => source!.keepNote(record, text)} forgetNote={(id) => source!.forgetNote(id)} onContinue={() => void handOff(() => source!.complete(flow.finishTools)).then((done) => { if (done) onComplete() })} />,
  }

  return (
    <div className="cmem-setup" data-step={step}>
      <a className="skip" href="#setup-main">Skip to content</a>
      <header className="setup-header">
        <span className="brand" role="img" aria-label="CMEM"><CmemMark /></span>
        <ProgressBar step={step} branch={flow.branch} showCheckout={!flow.alreadyPro} />
      </header>
      <main id="setup-main" ref={main} tabIndex={-1} className={`setup-main step-${step}${['scan', 'reveal', 'choice', 'savings', 'workspace'].includes(step) ? ' is-centered' : ''}`}>
        {handOffError && <p className="scan-error" role="alert">{handOffError}</p>}
        {installerFailed && <p className="scan-error" role="alert">Setup stopped in the terminal: {data.installer?.error ?? 'the installer did not say why.'} Run <code>npx claude-mem install</code> again to restart setup.</p>}
        {screens[step]()}
      </main>
    </div>
  )
}
