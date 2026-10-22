// The install funnel page (`?setup=1`), outside My Work's nav. Screens get their data through props from one source:
// the local worker, or the review fixtures with `?source=sample` (loaded by a dynamic import, so they are never in
// reach without the flag). The step machine is setup-flow.ts.
import { CheckIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CmemMark } from '@/components/brand'
import { EMPTY_SETUP_DATA, localSetupSource, SETUP_TOOLS, type SetupData, type SetupSource } from './setup-data'
import { guardStep, initialFlowState, nextAfterSavings, progressItemFor, type MemoryBranch, type SetupFlowState, type SetupStep } from './setup-flow'
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
    import('./setup-sample').then(({ createSampleSetupSource }) => { if (current) setSource(createSampleSetupSource(PARAMS.get('sample') === 'new', PARAMS.has('scan') ? Number(PARAMS.get('scan')) : null)) })
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

  const toFinishSetup = (changes: Partial<SetupFlowState>) => {
    const merged = { ...flow, ...changes }
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

  const screens: Record<SetupStep, () => ReactNode> = {
    scan: () => <ScanScreen scan={data.scan} />,
    reveal: () => <RevealScreen agents={data.scan.agents} reveal={data.reveal} onContinue={() => update({ revealContinued: true }, 'choice')} />,
    choice: () => <ChoiceScreen branch={flow.branch} onChoose={(branch) => update({ branch, memoryBilling: branch === 'go' ? 'hosted' : 'existing', choiceContinued: true, savingsComplete: false, checkoutReviewed: false, setupComplete: false, finishTools: [] }, 'savings')} />,
    savings: () => (
      <SavingsScreen usage={data.usage} branch={flow.branch}
        onPro={() => toFinishSetup({ branch: 'go', memoryBilling: 'hosted' })}
        onExistingPlan={() => toFinishSetup({ memoryBilling: 'existing' })}
        onSkip={() => toFinishSetup({})} />
    ),
    checkout: () => <CheckoutScreen onBack={() => setRequested('savings')} onContinue={() => update({ checkoutReviewed: true }, 'finish-setup')} />,
    'finish-setup': () => (
      <FinishSetupScreen branch={flow.branch} tools={tools} selected={flow.finishTools} onSelect={(finishTools) => update({ finishTools })}
        history={flow.branch === 'go' && historyAvailable ? data.history : null} importStatus={flow.importStatus}
        onImport={() => { source!.startHistoryImport(); update({ importStatus: 'running' }, 'import') }}
        onSkipImport={() => update({ importStatus: 'skipped' })}
        onBack={() => setRequested(nextAfterSavings(flow) === 'checkout' ? 'checkout' : 'savings')}
        onContinue={() => void finishSetup()} />
    ),
    import: () => <ImportScreen progress={data.historyImport} />,
    launch: () => <LaunchScreen tools={pickedTools} onDone={() => setRequested('workspace')} />,
    workspace: () => <WorkspaceScreen suggestions={data.suggestions} search={(query) => source!.search(query)} onContinue={onComplete} />,
  }

  return (
    <div className="cmem-setup" data-step={step}>
      <a className="skip" href="#setup-main">Skip to content</a>
      <header className="setup-header">
        <span className="brand" role="img" aria-label="CMEM"><CmemMark /></span>
        <ProgressBar step={step} branch={flow.branch} showCheckout={!flow.alreadyPro} />
      </header>
      <main id="setup-main" ref={main} tabIndex={-1} className={`setup-main step-${step}${['scan', 'reveal', 'choice', 'savings', 'workspace'].includes(step) ? ' is-centered' : ''}`}>
        {screens[step]()}
      </main>
    </div>
  )
}
