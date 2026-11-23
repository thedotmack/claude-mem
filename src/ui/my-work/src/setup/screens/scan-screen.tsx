import { useState } from 'react'
import { ArrowRightIcon, CheckIcon } from 'lucide-react'
import { DottedGlowBackground } from '@/components/aceternity/dotted-glow-background'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { interpolate, useI18n } from '@/lib/i18n'
import { uploadTooLarge, type SetupFailure, type SetupScanPhase, type SetupScanView } from '../setup-data'
import { scanAgentStatus } from '../setup-scan-status'
import { PageHeading, SETUP_WAITING_LINE_ID, SetupActions, SetupButton, SetupError, ToolMark, type SetupBack } from './shared'

/** PROTO savings.js status phrases, one per scan phase. A stopped scan says what happened in its own alert instead. */
const STATUS: Record<SetupScanPhase, string | null> = {
  idle: 'Finding your recent work.',
  reading: 'Finding your recent work.',
  checking: 'Finding the context behind your work.',
  saving: 'Preparing your overview.',
  'awaiting-consent': null,
  uploading: 'Discovering your work, rules and focus…',
  done: 'Your scan is done. Continue to see what it found.',
  failed: null,
}

/**
 * Step 1: each detected agent ticks in and its prompt count climbs while the worker reads the last 30 days. When the
 * scan finishes the page moves on to the Reveal by itself, as it always has; Back waits while the scan runs. The done
 * state, with its Continue, shows only when the person comes Back from the Reveal to look at the scan again.
 */
export function ScanScreen({ scan, back, onImproveProductChange, onConfirmUpload, consentError, consentSending, preferenceError, onRetry, retrying, retryError, onSkip, onContinue }: {
  scan: SetupScanView
  back?: SetupBack | null
  onImproveProductChange: (improveProduct: boolean) => void
  onConfirmUpload: (upload: boolean, agents?: string[]) => void
  consentError?: SetupFailure | null
  consentSending?: boolean
  preferenceError: SetupFailure | null
  onRetry: () => void
  retrying: boolean
  retryError: SetupFailure | null
  /** "Skip the scan" after it stopped: setup goes on without it, and nothing is sent. */
  onSkip?: () => void
  onContinue?: () => void
}) {
  const { t } = useI18n()
  const detected = scan.agents.filter((agent) => agent.detected)
  const [unticked, setUnticked] = useState<string[]>([])
  const [includeRecentWork, setIncludeRecentWork] = useState(true)
  // Offer every tool that has prompts, even when its history folder is gone and only saved prompts remain.
  const uploadable = scan.agents.filter((agent) => agent.prompts > 0)
  const selected = includeRecentWork ? uploadable.filter((agent) => !unticked.includes(agent.id)) : []
  const chosen = selected.map((agent) => agent.id)
  const asking = scan.phase === 'awaiting-consent'
  const tooLarge = asking && uploadTooLarge(selected)
  const stopped = scan.phase === 'failed'
  const count = (prompts: number) => interpolate(t('{count} messages'), { count: prompts.toLocaleString('en-US') })
  const status = STATUS[scan.phase]
  // While the scan runs the row has nothing to press forward (the page moves on by itself), so its only line is
  // Back's reason, which the bottom row words (BACK_WAIT_WORDS).
  const waiting = tooLarge ? t('Choose fewer tools or turn off recent conversations to continue.') : undefined
  return (
    <section aria-labelledby="scan-title">
      <PageHeading id="scan-title" title={asking ? t('Find your focus areas') : t('Finding your recent work.')} lead={asking ? undefined : detected.map((agent) => agent.label).join(' · ') || undefined} />
      <div className="panel is-memory scan-panel">
        {/* Texture only (C1): still and faint, drawn once (speedScale 0), hidden from screen readers. */}
        <DottedGlowBackground className="scan-dots" gap={16} radius={1.2} color="rgba(75, 70, 200, 0.5)" glowColor="rgba(91, 87, 230, 0.9)" opacity={0.28} speedScale={0} />
        {/* While the scan asks about the upload, the tick list below names each tool with its count, so this list folds away. */}
        {detected.length > 0 && !asking && (
          <ul className="scan-agents" aria-label={t('Agents found on this computer')}>
            {detected.map((agent) => {
              const agentStatus = scanAgentStatus(agent)
              return (
                <li key={agent.id} className={agentStatus.note ? 'cannot-run' : undefined}>
                  <span className="check" aria-hidden="true"><CheckIcon strokeWidth={3} /></span>
                  <ToolMark id={agent.id} name={agent.label} />
                  <span className="scan-agent-name">{agent.label} <span className="detected">({t(agentStatus.label)})</span></span>
                  <span className="count tabular">{count(agent.prompts)}</span>
                  {agentStatus.note && <span className="scan-agent-note">{t(agentStatus.note)}</span>}
                </li>
              )
            })}
          </ul>
        )}
        <div className="scan-meter">
          <progress max={100} value={scan.percent} aria-label={t('Scan progress')}>{scan.percent}%</progress>
          <span className="scan-percent tabular" aria-hidden="true">{scan.percent}%</span>
        </div>
        {status && <p className="scan-status" role="status" aria-live="polite">{t(status)}</p>}
        {stopped && (retryError
          ? <SetupError title={t('Couldn’t start the scan again.')} failure={retryError} />
          : <SetupError title={scan.errorKind || scan.percent === 0 ? t('The scan couldn’t start.') : t('The scan stopped.')}
            // A page that could not reach the worker says so; any other stop says the conversations are safe.
            check={scan.errorKind === 'unreachable' ? undefined : t('Your conversations are on this computer. Setup can continue with new work.')}
            failure={scan.error ? { kind: scan.errorKind ?? 'refused', detail: scan.error } : null} />)}
        {asking && (
          <div className="scan-consent" role="group" aria-label={t('Discover your work')}>
            <label className="install-option"><input type="checkbox" checked={includeRecentWork} disabled={consentSending} onChange={event => setIncludeRecentWork(event.target.checked)} />
              <strong>{t('Include recent conversations')}</strong></label>
            {includeRecentWork && <>
              <p>{t('Claude-Mem uses the last 30 days of conversations to find your projects and preferences.')}</p>
              <p className="scan-consent-notice">{t('Selected messages are sent to cmem.ai and an AI provider.')}</p>
              <Collapsible className="scan-consent-details">
                <CollapsibleFoldTrigger>{t('What gets uploaded?')}</CollapsibleFoldTrigger>
                <CollapsibleContent forceMount><p>{t('The full text of your messages from the last 30 days in the selected tools, with session IDs, project names, folder paths and timestamps.')}</p></CollapsibleContent>
              </Collapsible>
              <ul className="scan-consent-agents" aria-label={t('Tools to upload')}>
                {uploadable.map((agent) => (
                  <li key={agent.id}>
                    <label>
                      <input type="checkbox" disabled={consentSending} checked={!unticked.includes(agent.id)}
                        onChange={(event) => setUnticked(event.target.checked ? unticked.filter((id) => id !== agent.id) : [...unticked, agent.id])} />
                      <span>{agent.label} ({count(agent.prompts)})</span>
                    </label>
                  </li>
                ))}
              </ul>
            </>}
            {consentSending && <p className="scan-status" role="status">{t('Sending your choice…')}</p>}
            {consentError && <SetupError title={t('Couldn’t send your choice.')} check={t('If you chose to upload, your prompts may already have been uploaded. Reload this page to check.')} failure={consentError} />}
          </div>
        )}
        {preferenceError && <SetupError title={t('Couldn’t save this choice.')} failure={preferenceError} />}
        {/* The choice can change while the scan can still use it, as before Phase 8. A finished scan shows only on the way
            Back from the Reveal, and there the choice is read-only: a change would send POST /api/setup/scan/preferences
            after the scan finished, which this page never did. */}
        <label className="scan-improve-product">
          <input type="checkbox" checked={scan.improveProduct} disabled={scan.phase === 'uploading' || scan.phase === 'done'} onChange={(event) => onImproveProductChange(event.target.checked)} />
          <span>
            <strong>{t('Share anonymous usage statistics to help improve your Claude-mem experience')}</strong>
            <small>{scan.phase === 'done' ? t('The scan is done, and this choice was saved with it.') : t('Shared with cmem.ai only when you include conversations.')}</small>
          </span>
        </label>
      </div>
      <SetupActions back={back} waiting={waiting}>
        {stopped && <>
          {/* Dimmed while "Try again" is starting the scan: skipping then would leave a new scan running behind a
              Reveal that says it was skipped, with an upload question nobody can answer. */}
          {onSkip && <SetupButton look="outline" aria-disabled={retrying || undefined} onClick={onSkip}>{t('Continue with new work')}</SetupButton>}
          <SetupButton busy={retrying} busyLabel={t('Starting again…')} onClick={onRetry}>{t('Try again')}</SetupButton>
        </>}
        {asking && <SetupButton aria-disabled={tooLarge || consentSending || undefined} aria-describedby={tooLarge ? SETUP_WAITING_LINE_ID : undefined}
          onClick={() => onConfirmUpload(chosen.length > 0, chosen)}>{chosen.length > 0 ? t('Find my focus areas') : t('Continue with new work')} <ArrowRightIcon aria-hidden="true" /></SetupButton>}
        {scan.phase === 'done' && onContinue && <SetupButton onClick={onContinue}>{t('Continue')} <ArrowRightIcon aria-hidden="true" /></SetupButton>}
      </SetupActions>
    </section>
  )
}
