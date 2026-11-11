// The install funnel page (`?setup=1`), outside My Work's nav. Screens get their data through props from one source:
// the local worker, or the review fixtures with `?source=sample` (loaded by a dynamic import, so they are never in
// reach without the flag). The step machine is setup-flow.ts.
import { CheckIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CmemMark } from '@/components/brand'
import { interpolate, LOCALES, LOCALE_NAMES, useI18n, type Locale } from '@/lib/i18n'
import { uiMessage, renderUiMessage, type UiMessage } from '../../../ui-message'
import { EMPTY_SETUP_DATA, localSetupSource, setupToolsForInstall, type SetupData, type SetupSource } from './setup-data'
import { choiceLocked, guardStep, hydrateSetupChoice, initialFlowState, nextAfterSavings, progressItemFor, type MemoryBranch, type SetupFlowState, type SetupStep } from './setup-flow'
import { CheckoutScreen } from './screens/checkout-screen'
import { ChoiceScreen } from './screens/choice-screen'
import { FinishSetupScreen } from './screens/finish-setup-screen'
import { ImportScreen } from './screens/import-screen'
import { InstallScreen } from './screens/install-screen'
import { LaunchScreen } from './screens/launch-screen'
import { RevealScreen } from './screens/reveal-screen'
import { SavingsScreen } from './screens/savings-screen'
import { ScanScreen } from './screens/scan-screen'
import { prefersReducedMotion } from './format'
import { WorkspaceScreen } from './screens/workspace-screen'
import { connectSetupTelemetry, createSetupTracker, sendSetupEvent } from './setup-telemetry'
import type { SetupError } from '../../../../shared/setup-funnel.ts'
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
  const { t } = useI18n()
  const current = progressItemFor(step)
  if (!current) return null
  const items = [['memory', t('Memory')], ['savings', t('Token Savings')], ...(branch === 'go' && showCheckout ? [['checkout', t('Checkout')]] : []), ['finish', t('Finish Setup')]]
  const currentIndex = items.findIndex(([id]) => id === current)
  return (
    <nav aria-label={t('Setup progress')}>
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
  const { t, locale, setLocale } = useI18n()
  const source = useSetupSource()
  const telemetry = useMemo(() => createSetupTracker(sendSetupEvent), [])
  const [branchConfirmed, setBranchConfirmed] = useState(false)
  useEffect(() => {
    if (source?.kind !== 'local') return
    const disconnect = connectSetupTelemetry(context => telemetry.start(context))
    const visibility = () => telemetry.visibility(document.visibilityState !== 'hidden')
    const leaving = () => telemetry.visibility(false)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', leaving)
    return () => { disconnect(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', leaving) }
  }, [source, telemetry])
  const [data, setData] = useState<SetupData>(EMPTY_SETUP_DATA)
  useEffect(() => source?.subscribe(setData), [source])

  const [improveProduct, setImproveProduct] = useState<boolean | null>(null)
  const [preferenceError, setPreferenceError] = useState<UiMessage | null>(null)
  const preferenceRevision = useRef(0)
  const changeImproveProduct = async (checked: boolean) => {
    if (!source) return
    const revision = ++preferenceRevision.current
    const failed = telemetry.failure('usage_preference_failed')
    // Keep the user's choice visible even if an earlier scan response arrives after their click.
    setImproveProduct(checked)
    setPreferenceError(null)
    try { await source.setImproveProduct(checked) } catch (error) {
      failed()
      if (revision !== preferenceRevision.current) return
      setImproveProduct(null)
      setPreferenceError(uiMessage('Could not save this choice: {error}', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const [consentError, setConsentError] = useState<UiMessage | null>(null)
  const consentPending = useRef(false)
  const [consentSending, setConsentSending] = useState(false)
  const confirmUpload = async (upload: boolean, agents?: string[]) => {
    if (!source || consentPending.current) return
    consentPending.current = true
    setConsentError(null)
    setConsentSending(true)
    const failed = telemetry.failure('upload_consent_failed')
    telemetry.action(upload ? 'upload_allowed' : 'upload_skipped')
    try {
      // The sharing choice travels with the consent, so a queued preference request cannot lose a race with the upload.
      await source.confirmUpload(upload, agents, improveProduct ?? data.scan.improveProduct)
    } catch (error) {
      failed()
      setConsentError(uiMessage('Could not confirm your choice: {error}. If you chose to upload, your prompts may already have been uploaded; reload this page to check.', { error: error instanceof Error ? error.message : String(error) }))
    } finally { consentPending.current = false; setConsentSending(false) }
  }

  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const retryPending = useRef(false)
  const retryScan = async () => {
    if (!source || retryPending.current) return
    retryPending.current = true
    setRetrying(true)
    setRetryError(null)
    telemetry.action('retry_scan')
    const failed = telemetry.failure('scan_retry_failed')
    try { await source.retryScan() } catch (error) {
      failed()
      setRetryError(error instanceof Error ? error.message : String(error))
    } finally {
      retryPending.current = false
      setRetrying(false)
    }
  }

  const [flow, setFlow] = useState<SetupFlowState>(() => initialFlowState(false))
  const choiceEdited = useRef(false)
  const [requested, setRequested] = useState<SetupStep>('install')
  const update = (changes: Partial<SetupFlowState>, next?: SetupStep) => { setFlow((current) => ({ ...current, ...changes })); if (next) setRequested(next) }

  // Facts from the data, not decisions: they move the machine on as they arrive.
  const scanComplete = data.scan.done && data.scan.phase === 'done'
  const installationComplete = data.install !== undefined && (!data.install || data.install.status === 'ready')
  const historyAvailable = !!data.history && data.history.observations > 0
  if (flow.scanComplete !== scanComplete || flow.alreadyPro !== data.alreadyPro) {
    setFlow((current) => ({ ...current, scanComplete, alreadyPro: data.alreadyPro, branch: data.alreadyPro && !data.choice && !choiceEdited.current ? 'go' : current.branch }))
  }
  const hydratedFlow = hydrateSetupChoice(flow, data.choice, choiceEdited.current, data.installer?.stage)
  if (hydratedFlow !== flow) setFlow(hydratedFlow)
  if (data.choice && !branchConfirmed && (!choiceEdited.current || choiceLocked(data.installer?.stage))) setBranchConfirmed(true)
  if (flow.importStatus === 'none' && historyAvailable) setFlow((current) => ({ ...current, importStatus: 'available' }))
  if ((requested === 'scan' || requested === 'install') && installationComplete && scanComplete) setRequested('reveal')
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

  const step = guardStep(requested, { ...flow, installationComplete })
  useEffect(() => { if (data.scan.phase === 'failed') telemetry.error('scan_failed') }, [data.scan.phase, telemetry])
  useEffect(() => { if (data.checkout?.state === 'failed') telemetry.error('checkout_failed') }, [data.checkout?.state, telemetry])
  useEffect(() => { if (data.installer?.stage === 'failed') telemetry.error('installer_failed') }, [data.installer?.stage, telemetry])
  useEffect(() => { if (data.historyImport?.error) telemetry.error('import_failed') }, [data.historyImport?.error, telemetry])
  useEffect(() => {
    if (source?.kind === 'local') telemetry.view(step, { branch: flow.branch, branch_confirmed: branchConfirmed, importComplete: flow.importStatus === 'complete' })
  }, [source, step, flow.branch, branchConfirmed, flow.importStatus, telemetry])
  const availableTools = useMemo(() => setupToolsForInstall(data.install), [data.install])
  const tools = useMemo(() => availableTools.filter((tool) => flow.branch === 'go' || tool.kind === 'local'), [availableTools, flow.branch])
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
  const handOff = async (send: () => Promise<void>, code: SetupError): Promise<boolean> => {
    const failed = telemetry.failure(code)
    try { await send() } catch (error) { failed(); setHandOffError(error instanceof Error ? error.message : String(error)); return false }
    setHandOffError(null)
    return true
  }

  // Leaving Token Savings is when both halves of the choice are final, so that is when the installer gets it.
  const toFinishSetup = async (changes: Partial<SetupFlowState>) => {
    const merged = { ...flow, ...changes }
    if (!await handOff(() => source!.choose({ branch: merged.branch, memoryBilling: merged.memoryBilling }), 'choice_failed')) return
    setBranchConfirmed(true)
    telemetry.action('choice_committed', { branch: merged.branch, branch_confirmed: true })
    // Detected tools come pre-ticked the first time Finish Setup opens for this branch.
    const available = availableTools.filter((tool) => merged.branch === 'go' || tool.kind === 'local').map((tool) => tool.id)
    const installed = availableTools.filter(tool => tool.installed).map(tool => tool.id)
    const finishTools = merged.finishTools.length ? merged.finishTools.filter((id) => available.includes(id)) : [...new Set([...installed, ...data.detectedTools.filter((id) => available.includes(id))])]
    update({ ...changes, finishTools, savingsComplete: true }, nextAfterSavings(merged))
  }
  const finishSetup = async () => {
    update({ setupComplete: true })
    if (prefersReducedMotion()) { setRequested('workspace'); return }
    await main.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240 }).finished.catch(() => {})
    setRequested('launch')
  }

  // A failed handoff can restart its installer and retry the current choice from this page.
  const installerFailed = data.installer?.stage === 'failed'
  const [retryingSetup, setRetryingSetup] = useState(false)
  const retrySetup = async () => {
    if (!source || retryingSetup) return
    setRetryingSetup(true)
    await handOff(async () => {
      await source.resume()
      await source.choose({ branch: flow.branch, memoryBilling: flow.memoryBilling })
    }, 'choice_failed')
    setRetryingSetup(false)
  }
  const finishAll = async () => {
    // Completion rides the successful state write before the installer can restart the worker.
    await Promise.race([telemetry.flush(), new Promise(resolve => setTimeout(resolve, 300))])
    if (await handOff(() => source!.complete(flow.finishTools, telemetry.completionEvents()), 'complete_failed')) {
      telemetry.complete()
      onComplete()
    }
  }

  const screens: Record<SetupStep, () => ReactNode> = {
    install: () => <InstallScreen install={data.install} onInstall={async selection => {
      const failed = telemetry.failure('installer_failed')
      try { await source!.configureInstall(selection) } catch (error) { failed(); throw error }
    }} />,
    scan: () => <ScanScreen scan={{ ...data.scan, improveProduct: improveProduct ?? data.scan.improveProduct }} onImproveProductChange={(checked) => void changeImproveProduct(checked)} onConfirmUpload={(upload, agents) => void confirmUpload(upload, agents)} consentError={consentError && renderUiMessage(consentError, t)} consentSending={consentSending} preferenceError={preferenceError && renderUiMessage(preferenceError, t)} onRetry={() => void retryScan()} retrying={retrying} retryError={retryError} />,
    reveal: () => <RevealScreen agents={data.scan.agents} reveal={data.reveal} extraction={data.extraction} uploadedAgents={data.scan.uploadedAgents} recentPrompts={data.recentPrompts} hostedNotice={data.scan.hostedNotice} onContinue={() => update({ revealContinued: true }, 'choice')} />,
    choice: () => <ChoiceScreen branch={flow.branch} onChoose={(branch) => { choiceEdited.current = true; telemetry.action('choose_memory', { branch, branch_confirmed: false }); setBranchConfirmed(false); update({ branch, memoryBilling: branch === 'go' ? 'hosted' : 'existing', choiceContinued: true, savingsComplete: false, checkoutReviewed: false, setupComplete: false, finishTools: [] }, 'savings') }} />,
    savings: () => (
      <SavingsScreen usage={data.usage} branch={flow.branch}
        onPro={() => void toFinishSetup({ branch: 'go', memoryBilling: 'hosted' })}
        onExistingPlan={() => void toFinishSetup({ memoryBilling: 'existing' })}
        onSkip={() => void toFinishSetup({})} />
    ),
    checkout: () => <CheckoutScreen checkout={data.checkout} installerStopped={installerFailed} onBack={() => setRequested('savings')} onContinue={() => { telemetry.action('open_checkout'); void handOff(() => source!.checkout(), 'checkout_failed') }} />,
    'finish-setup': () => (
      <FinishSetupScreen branch={flow.branch} tools={tools} selected={flow.finishTools} onSelect={(finishTools) => update({ finishTools })}
        history={flow.branch === 'go' && historyAvailable ? data.history : null} importStatus={flow.importStatus}
        importResult={data.historyImport}
        onImport={() => { telemetry.action('start_import'); void handOff(() => source!.startHistoryImport(), 'import_failed').then((started) => { if (started) update({ importStatus: 'running' }, 'import') }) }}
        onSkipImport={() => { telemetry.action('skip_import'); update({ importStatus: 'skipped' }) }}
        onBack={nextAfterSavings(flow) === 'checkout' ? () => setRequested('checkout') : choiceLocked(data.installer?.stage) ? undefined : () => setRequested('savings')}
        onContinue={() => void finishSetup()} />
    ),
    import: () => <ImportScreen progress={data.historyImport} />,
    launch: () => <LaunchScreen tools={pickedTools} onDone={() => setRequested('workspace')} />,
    workspace: () => <WorkspaceScreen suggestions={data.suggestions} search={(query) => source!.search(query)} keepNote={(record, text) => source!.keepNote(record, text)} forgetNote={(id) => source!.forgetNote(id)} onContinue={() => void finishAll()} />,
  }

  return (
    <div className="cmem-setup" data-step={step}>
      <a className="skip" href="#setup-main">{t('Skip to content')}</a>
      <header className="setup-header">
        <span className="brand" role="img" aria-label="CMEM"><CmemMark /></span>
        <ProgressBar step={step} branch={flow.branch} showCheckout={!flow.alreadyPro} />
        <div className="setup-header-actions">
          <select
            aria-label={t('Language')}
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            className="setup-lang-select"
          >
            {LOCALES.map((code) => <option key={code} value={code}>{LOCALE_NAMES[code]}</option>)}
          </select>
        </div>
      </header>
      <main id="setup-main" ref={main} tabIndex={-1} className={`setup-main step-${step}${['scan', 'reveal', 'choice', 'savings', 'workspace'].includes(step) ? ' is-centered' : ''}`}>
        {handOffError && <p className="scan-error" role="alert">{handOffError}</p>}
        {data.connectionError && <p className="scan-error" role="alert">{data.connectionError}</p>}
        {installerFailed && (
          <p className="scan-error" role="alert">
            {interpolate(t('Setup stopped: {error}'), {
              error: data.installer?.error ?? t('the installer did not say why.'),
            })}
            {' '}<button type="button" className="text-action" disabled={retryingSetup} onClick={() => void retrySetup()}>{retryingSetup ? t('Retrying setup…') : t('Retry setup')}</button>
          </p>
        )}
        {screens[step]()}
      </main>
    </div>
  )
}
