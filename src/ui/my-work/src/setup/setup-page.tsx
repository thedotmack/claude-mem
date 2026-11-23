// The install funnel page (`?setup=1`), outside My Work's nav. Screens get their data through props from one source:
// the local worker, or the review fixtures with `?source=sample` (loaded by a dynamic import, so they are never in
// reach without the flag). The step machine is setup-flow.ts.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CmemMark } from '@/components/brand'
import { LOCALES, LOCALE_NAMES, useI18n, type Locale } from '@/lib/i18n'
import { EMPTY_SETUP_DATA, connectionFailureAbove, localSetupSource, setupToolsForInstall, toSetupFailure, uploadTooLarge, type SetupChoice, type SetupData, type SetupFailure, type SetupSource } from './setup-data'
import { backWaitsFor, choiceLocked, guardStep, hydrateSetupChoice, initialFlowState, nextAfterChoice, previousStep, scanMovesOn, type SetupFlowState, type SetupStep } from './setup-flow'
import type { SampleFailure, SampleScanStop } from './setup-sample'
import { CheckoutScreen } from './screens/checkout-screen'
import { ChoiceScreen } from './screens/choice-screen'
import { FinishSetupScreen } from './screens/finish-setup-screen'
import { ImportScreen } from './screens/import-screen'
import { InstallScreen } from './screens/install-screen'
import { LaunchScreen } from './screens/launch-screen'
import { RevealScreen } from './screens/reveal-screen'
import { SavingsScreen } from './screens/savings-screen'
import { ScanScreen } from './screens/scan-screen'
import { SetupButton, SetupError, type SetupBack } from './screens/shared'
import { SetupStepBar } from './screens/step-bar'
import { prefersReducedMotion } from './format'
import { WorkspaceScreen } from './screens/workspace-screen'
import { connectSetupTelemetry, createSetupTracker, sendSetupEvent } from './setup-telemetry'
import { DEFAULT_CLOUD_SYNC_OFFER, historyImportRunning, setupCloudSyncOffer, type SetupError as SetupErrorCode } from '../../../../shared/setup-funnel.ts'
import './setup.css'

const PARAMS = new URLSearchParams(window.location.search)
const SAMPLE_REQUESTED = PARAMS.get('source') === 'sample'

function useSetupSource(): SetupSource | null {
  const [source, setSource] = useState<SetupSource | null>(SAMPLE_REQUESTED ? null : localSetupSource)
  useEffect(() => {
    if (!SAMPLE_REQUESTED) return
    let current = true
    // `&scan=<percent>` holds the scan there; `&scan=consent|failed` stops it at the upload question or a failure.
    // `&fail=`, `&installer=on` and `&import=running`: setup-sample.ts's header says what each plays.
    const scan = PARAMS.get('scan')
    const scanStop = (['consent', 'failed'] as const).find((stop): stop is SampleScanStop => stop === scan)
    const fail = (['install', 'checkout', 'import', 'installer', 'choice', 'stop'] as const).find((kind): kind is SampleFailure => kind === PARAMS.get('fail'))
    const installer = PARAMS.get('installer') === 'on'
    const importRunning = PARAMS.get('import') === 'running'
    import('./setup-sample').then(({ createSampleSetupSource }) => { if (current) setSource(createSampleSetupSource(PARAMS.get('sample') === 'new', scan !== null && !scanStop ? Number(scan) : null, (['partial', 'none'] as const).find((kind) => kind === PARAMS.get('usage')), PARAMS.get('agent') === 'none', { scanStop, fail, installer, importRunning })) })
    return () => { current = false }
  }, [])
  return source
}

/**
 * A failed hand-off as the page shows it: the screen it belongs to (it shows there only), what failed (English,
 * translated when drawn), why, and the press that sends it again, which runs only when the person presses "Try again".
 */
interface HandOffFailure { step: SetupStep; title: string; failure: SetupFailure; retry?: () => Promise<void> }

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

  const [flow, setFlow] = useState<SetupFlowState>(() => initialFlowState(false))
  const choiceEdited = useRef(false)
  const choicePending = useRef(false)
  const [savingChoice, setSavingChoice] = useState(false)
  const [requested, setRequested] = useState<SetupStep>('install')
  const update = (changes: Partial<SetupFlowState>, next?: SetupStep) => { setFlow((current) => ({ ...current, ...changes })); if (next) setRequested(next) }

  const [improveProduct, setImproveProduct] = useState<boolean | null>(null)
  const [preferenceError, setPreferenceError] = useState<SetupFailure | null>(null)
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
      setPreferenceError(toSetupFailure(error))
    }
  }

  const [consentError, setConsentError] = useState<SetupFailure | null>(null)
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
      // Either answer ends with the worker reporting the scan done, which moves the page on (scanMovesOn).
      await source.confirmUpload(upload, agents, improveProduct ?? data.scan.improveProduct)
    } catch (error) {
      failed()
      setConsentError(toSetupFailure(error))
    } finally { consentPending.current = false; setConsentSending(false) }
  }

  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<SetupFailure | null>(null)
  const retryPending = useRef(false)
  const retryScan = async () => {
    if (!source || retryPending.current) return
    retryPending.current = true
    setRetrying(true)
    setRetryError(null)
    // A new run is a first pass again: it moves on to the Reveal by itself when it finishes.
    update({ scanSkipped: false, scanReview: false })
    telemetry.action('retry_scan')
    const failed = telemetry.failure('scan_retry_failed')
    try { await source.retryScan() } catch (error) {
      failed()
      setRetryError(toSetupFailure(error))
    } finally {
      retryPending.current = false
      setRetrying(false)
    }
  }

  // Facts from the data, not decisions: they move the machine on as they arrive.
  const scanComplete = data.scan.done && data.scan.phase === 'done'
  // The worker's word on the installation: finished, or no install screen in this run. Only this ticks Tools.
  const installConfirmed = data.install !== undefined && (!data.install || data.install.status === 'ready')
  // A first load that never reached the worker knows nothing about the installation. It shows the stopped scan, with
  // its Try again, rather than an install screen with nothing to load.
  const installationComplete = installConfirmed || (data.install === undefined && data.connectionError !== null)
  const historyAvailable = !!data.history && data.history.observations > 0
  // A paid receipt keeps the new customer's usage screen. A resumed installer can also
  // confirm existing credentials before it clears an interrupted checkout request.
  const alreadyPro = data.installer?.stage === 'go-kept-existing-pro'
    ? data.checkout?.state !== 'paid'
    : data.installer?.stage !== 'go-awaiting-checkout' && !data.checkout && data.alreadyPro
  if (flow.scanComplete !== scanComplete || flow.alreadyPro !== alreadyPro) {
    setFlow((current) => ({ ...current, scanComplete, alreadyPro, branch: alreadyPro && !data.choice && !choiceEdited.current ? 'go' : current.branch }))
  }
  const hydratedFlow = hydrateSetupChoice(flow, data.choice, choiceEdited.current, data.installer?.stage)
  if (hydratedFlow !== flow) setFlow(hydratedFlow)
  const choiceApplied = choiceLocked(data.installer?.stage, !!data.checkout)
  if (data.choice && !branchConfirmed && (!choiceEdited.current || choiceApplied)) setBranchConfirmed(true)
  const availableTools = useMemo(() => setupToolsForInstall(data.install), [data.install])
  const initialTools = (branch: SetupChoice['branch']) => availableTools
    .filter(tool => (branch === 'go' || tool.kind === 'local') && (tool.installed || data.detectedTools.includes(tool.id)))
    .map(tool => tool.id)
  // Reload restores the worker's original choice and receipt without submitting another checkout.
  if (data.choice && installationComplete && !flow.choiceContinued && !choiceEdited.current
    && (choiceApplied || requested === 'choice')) {
    const restored = { ...hydratedFlow, ...data.choice, alreadyPro, checkoutReviewed: data.checkout?.state === 'paid' }
    update({ revealContinued: true, choiceContinued: true, checkoutReviewed: restored.checkoutReviewed, finishTools: initialTools(restored.branch) }, nextAfterChoice(restored))
  } else if (scanMovesOn(requested, { ...flow, installationComplete, scanComplete })) setRequested('reveal')
  if (flow.importStatus === 'none' && historyAvailable) setFlow((current) => ({ ...current, importStatus: 'available' }))
  // Only the terminal's confirmed pairing unlocks the optional hosted offer.
  if (data.checkout?.state === 'paid' && !flow.checkoutReviewed) {
    setFlow((current) => ({ ...current, checkoutReviewed: true }))
    if (requested === 'checkout') setRequested(nextAfterChoice({ ...flow, alreadyPro, checkoutReviewed: true }))
  }
  // The import screen shows only while the upload runs. When the worker says it ended (finished, failed, stopped by
  // the person, or forgotten by a restart), the page goes back to Finish Setup, which says how it ended; only the
  // person's Import starts it again (re-sending is safe).
  if (requested === 'import' && !historyImportRunning(data.historyImport?.state ?? 'idle')) {
    setFlow((current) => ({ ...current, importStatus: data.historyImport?.state === 'done' ? 'complete' : 'available' }))
    setRequested('finish-setup')
  }

  const flowNow: SetupFlowState = { ...flow, installationComplete, installConfirmed }
  const step = guardStep(requested, flowNow)
  useEffect(() => { if (data.scan.phase === 'failed') telemetry.error('scan_failed') }, [data.scan.phase, telemetry])
  useEffect(() => { if (data.checkout?.state === 'failed') telemetry.error('checkout_failed') }, [data.checkout?.state, telemetry])
  useEffect(() => { if (data.installer?.stage === 'failed') telemetry.error('installer_failed') }, [data.installer?.stage, telemetry])
  useEffect(() => { if (data.historyImport?.error) telemetry.error('import_failed') }, [data.historyImport?.error, telemetry])
  useEffect(() => {
    if (source?.kind === 'local') telemetry.view(step, { branch: flow.branch, branch_confirmed: branchConfirmed, importComplete: flow.importStatus === 'complete' })
  }, [source, step, flow.branch, branchConfirmed, flow.importStatus, telemetry])
  // After the view effect, so the error counts against the consent step. It reads every tool the step offers, all
  // ticked as it opens, which is when the consent step first shows its over-the-cap warning (scan-screen.tsx).
  const consentOverCap = data.scan.phase === 'awaiting-consent' && uploadTooLarge(data.scan.agents)
  useEffect(() => { if (consentOverCap) telemetry.error('upload_too_large') }, [consentOverCap, telemetry])
  const tools = useMemo(() => availableTools.filter((tool) => flow.branch === 'go' || tool.kind === 'local'), [availableTools, flow.branch])
  const pickedTools = useMemo(() => tools.filter((tool) => flow.finishTools.includes(tool.id)), [tools, flow.finishTools])

  // Back on every screen but the first: the screen before this one on the person's path, through guardStep like any
  // request; dimmed with the reason while a scan or an import runs (plan Phase 8).
  const backTarget = previousStep(step, flowNow, { hasInstallStep: !!data.install, choiceLocked: choiceApplied })
  const back: SetupBack | null = backTarget && {
    waitsFor: backWaitsFor(step, data.scan.phase),
    // Back to the installation or the scan is a look at a finished step: it stays up until the person's Continue.
    onBack: () => update(backTarget === 'install' ? { installReview: true } : backTarget === 'scan' ? { scanReview: true } : {}, backTarget),
  }

  // The terminal waits on these hand-offs; a refusal stays on the screen it was sent from and says what failed and why.
  const [handOffError, setHandOffError] = useState<HandOffFailure | null>(null)
  const [handOffRetrying, setHandOffRetrying] = useState(false)
  // `code` null: a hand-off the funnel's closed error list has no code for (Stop import), so its failure sends no event.
  const handOff = async (send: () => Promise<void>, code: SetupErrorCode | null, title: string, retry?: () => Promise<void>): Promise<boolean> => {
    const failed = code ? telemetry.failure(code) : () => {}
    const sentFrom = step
    try { await send() } catch (error) { failed(); setHandOffError({ step: sentFrom, title, failure: toSetupFailure(error), retry }); return false }
    setHandOffError(null)
    return true
  }
  // "Try again" sends the same hand-off once more, only when pressed (no automatic retry).
  const retryHandOff = async () => {
    if (!handOffError?.retry || handOffRetrying) return
    setHandOffRetrying(true)
    try { await handOffError.retry() } finally { setHandOffRetrying(false) }
  }

  // Each new step starts at the top, with focus on its title (PROTO renderRoute). Leaving a screen also dismisses its
  // failed hand-off: the alert belongs to the screen it was sent from and never follows Back or Continue elsewhere.
  const main = useRef<HTMLElement>(null)
  const shownStep = useRef<SetupStep | null>(null)
  useEffect(() => {
    if (shownStep.current === step) return
    const first = shownStep.current === null
    shownStep.current = step
    setHandOffError((current) => current?.step === step ? current : null)
    if (first) return
    window.scrollTo(0, 0)
    if (step !== 'workspace') main.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
  }, [step])

  const submitChoice = async (branch: SetupChoice['branch'], cloudSyncOffer: SetupFlowState['cloudSyncOffer']): Promise<void> => {
    if (!source || choicePending.current) return
    choicePending.current = true
    choiceEdited.current = true
    setSavingChoice(true)
    const selected = { ...flow, branch, cloudSyncOffer, memoryBilling: 'existing' as const, choiceContinued: true, checkoutReviewed: false, savingsComplete: false }
    const offer = setupCloudSyncOffer(selected)
    const next = nextAfterChoice(selected)
    const open = next === 'checkout'
    telemetry.action('choose_memory', { branch, branch_confirmed: false }, offer)
    try {
      const success = await handOff(() => source.choose({ branch, memoryBilling: 'existing', ...(offer ? { cloudSyncOffer: offer } : {}) }, open), 'choice_failed', 'Couldn’t save your storage choice.', () => submitChoice(branch, cloudSyncOffer))
      if (!success) return
      const committed = { branch, branch_confirmed: true }
      setBranchConfirmed(true)
      telemetry.action('choice_committed', committed, offer)
      if (open) {
        setCheckoutAsked(true)
        telemetry.action('open_checkout', committed, offer)
      }
      update({ branch, cloudSyncOffer, memoryBilling: 'existing', revealContinued: true, choiceContinued: true, checkoutReviewed: false, savingsComplete: false, finishTools: initialTools(branch), setupComplete: false }, next)
    } finally {
      choicePending.current = false
      setSavingChoice(false)
    }
  }
  const finishSetup = async () => {
    update({ setupComplete: true })
    if (prefersReducedMotion()) { setRequested('workspace'); return }
    await main.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240 }).finished.catch(() => {})
    setRequested('launch')
  }

  // On The Go: the press asks the terminal to open checkout. The page says it is waiting from the moment the ask is
  // accepted, before the installer's first report arrives.
  const [checkoutAsked, setCheckoutAsked] = useState(false)
  const openCheckout = async (): Promise<void> => {
    telemetry.action('open_checkout', undefined, setupCloudSyncOffer(flow))
    if (await handOff(() => source!.checkout(), 'checkout_failed', 'Couldn’t open checkout.', openCheckout)) setCheckoutAsked(true)
  }
  const startImport = async (): Promise<void> => {
    // A run the worker already reports running (found after a reload) is not started again: the worker answers with
    // that run and the page shows its progress. Only a press that can start one counts as a start.
    if (!historyImportRunning(data.historyImport?.state ?? 'idle')) telemetry.action('start_import')
    if (await handOff(() => source!.startHistoryImport(), 'import_failed', 'Couldn’t start the import.', startImport)) update({ importStatus: 'running' }, 'import')
  }
  // Stop import: the worker ends the upload at once and answers with the stopped run, which takes the page back to
  // Finish Setup (above), or keeps it there when the Stop was pressed on Finish Setup's running line. The button says it
  // is stopping until then; a refusal stays on the screen it was sent from, with Try again.
  const [stoppingImport, setStoppingImport] = useState(false)
  const stopPending = useRef(false)
  const stopImport = async (): Promise<void> => {
    if (stopPending.current) return
    stopPending.current = true
    setStoppingImport(true)
    try { await handOff(() => source!.stopHistoryImport(), null, 'Couldn’t stop the import.', stopImport) }
    finally { stopPending.current = false; setStoppingImport(false) }
  }

  // A failed handoff can restart its installer and retry the current choice from this page.
  const installerFailed = data.installer?.stage === 'failed'
  const [retryingSetup, setRetryingSetup] = useState(false)
  const retrySetup = async () => {
    if (!source || retryingSetup) return
    setRetryingSetup(true)
    // No "Try again" of its own: the "Retry setup" button right above it sends the same requests.
    await handOff(async () => {
      await source.resume()
      const offer = setupCloudSyncOffer(flow)
      await source.choose({ branch: flow.branch, memoryBilling: flow.memoryBilling, ...(offer ? { cloudSyncOffer: offer } : {}) }, !!offer && !flow.alreadyPro)
    }, 'choice_failed', 'Couldn’t restart setup.')
    setRetryingSetup(false)
  }
  const finishAll = async (): Promise<void> => {
    // Completion rides the successful state write before the installer can restart the worker.
    await Promise.race([telemetry.flush(), new Promise(resolve => setTimeout(resolve, 300))])
    if (await handOff(() => source!.complete(flow.finishTools, telemetry.completionEvents()), 'complete_failed', 'Couldn’t finish setup.', finishAll)) {
      telemetry.complete()
      onComplete()
    }
  }

  const screens: Record<SetupStep, () => ReactNode> = {
    install: () => <InstallScreen install={data.install} onInstall={async selection => {
      const failed = telemetry.failure('installer_failed')
      try { await source!.configureInstall(selection) } catch (error) { failed(); throw error }
    }} onContinue={() => update({ installReview: false }, 'scan')} />,
    scan: () => <ScanScreen scan={{ ...data.scan, improveProduct: improveProduct ?? data.scan.improveProduct }} back={back}
      onImproveProductChange={(checked) => void changeImproveProduct(checked)} onConfirmUpload={(upload, agents) => void confirmUpload(upload, agents)}
      consentError={consentError} consentSending={consentSending} preferenceError={preferenceError}
      onRetry={() => void retryScan()} retrying={retrying} retryError={retryError}
      // Never while "Try again" is starting the scan (the button is dimmed then too): a skip would leave that new scan
      // running behind a Reveal that says it was skipped.
      onSkip={() => { if (!retryPending.current) update({ scanSkipped: true }, 'reveal') }}
      onContinue={() => update({ scanReview: false }, 'reveal')} />,
    reveal: () => <RevealScreen agents={data.scan.agents} reveal={data.reveal} extraction={data.extraction} uploadedAgents={data.scan.uploadedAgents} recentPrompts={data.recentPrompts} hostedNotice={data.scan.hostedNotice}
      skipped={flow.scanSkipped && !scanComplete} back={savingChoice ? null : back} busy={savingChoice}
      onStartTrial={!flow.alreadyPro && !data.choice ? () => void submitChoice('go', DEFAULT_CLOUD_SYNC_OFFER) : undefined}
      onContinue={() => update({ revealContinued: true }, 'choice')} />,
    choice: () => <ChoiceScreen branch={flow.branch} cloudSyncOffer={flow.cloudSyncOffer} alreadyPro={flow.alreadyPro} saving={savingChoice} back={back} onChoose={(branch, offer) => void submitChoice(branch, offer)} />,
    savings: () => <SavingsScreen usage={data.usage} back={back}
      onViewPlans={() => telemetry.action('view_hosted_plans', undefined, flow.cloudSyncOffer)}
      onContinue={() => update({ savingsComplete: true }, 'finish-setup')} />,
    // A paid checkout reached by Back goes on to Finish Setup without asking for checkout again.
    checkout: () => <CheckoutScreen checkout={data.checkout} cloudSyncOffer={flow.cloudSyncOffer} legacyHosted={flow.memoryBilling === 'hosted'} asked={checkoutAsked} installerStopped={installerFailed} back={back}
      onOpen={() => void openCheckout()} onContinue={() => setRequested(flow.memoryBilling === 'existing' ? 'savings' : 'finish-setup')} />,
    'finish-setup': () => (
      <FinishSetupScreen branch={flow.branch} tools={tools} selected={flow.finishTools} onSelect={(finishTools) => update({ finishTools })}
        history={flow.branch === 'go' && historyAvailable ? data.history : null} importStatus={flow.importStatus}
        importResult={data.historyImport} back={back}
        stoppingImport={stoppingImport} onStopImport={() => void stopImport()}
        onImport={() => void startImport()}
        onContinue={() => void finishSetup()} />
    ),
    import: () => <ImportScreen progress={data.historyImport} back={back} stopping={stoppingImport} onStop={() => void stopImport()} />,
    launch: () => <LaunchScreen tools={pickedTools} back={back} onDone={() => setRequested('workspace')} />,
    workspace: () => <WorkspaceScreen suggestions={data.suggestions} back={back} search={(query) => source!.search(query)} keepNote={(record, text) => source!.keepNote(record, text)} forgetNote={(id) => source!.forgetNote(id)} onContinue={() => void finishAll()} />,
  }

  const connectionFailure = connectionFailureAbove(data, step)

  return (
    <div className="cmem-setup" data-step={step}>
      <a className="skip" href="#setup-main">{t('Skip to content')}</a>
      <header className="setup-header">
        <span className="brand" role="img" aria-label="CMEM"><CmemMark /></span>
        <SetupStepBar step={step} flow={flowNow} />
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
      <main id="setup-main" ref={main} tabIndex={-1} className={`setup-main step-${step}${['scan', 'reveal', 'choice', 'workspace'].includes(step) ? ' is-centered' : ''}`}>
        {/* Only on the screen the hand-off was sent from; "Try again" sends it again only when pressed. */}
        {handOffError?.step === step && (
          <SetupError title={t(handOffError.title)} failure={handOffError.failure}
            action={handOffError.retry && <SetupButton look="outline" busy={handOffRetrying} onClick={() => void retryHandOff()}>{t('Try again')}</SetupButton>} />
        )}
        {connectionFailure && <SetupError title={t('Couldn’t connect to the setup program.')} failure={connectionFailure} />}
        {installerFailed && (
          <SetupError title={t('Setup stopped.')} check={t('The setup program on this computer stopped before it finished. Retry setup to start it again.')}
            detail={data.installer?.error}
            action={<SetupButton look="outline" busy={retryingSetup} busyLabel={t('Retrying setup…')} onClick={() => void retrySetup()}>{t('Retry setup')}</SetupButton>} />
        )}
        {screens[step]()}
      </main>
    </div>
  )
}
