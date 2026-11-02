import { useState } from 'react'
import { CheckIcon } from 'lucide-react'
import { AgentMark } from '@/components/brand'
import { DottedGlowBackground } from '@/components/aceternity/dotted-glow-background'
import { agentToolFor, type SetupScanPhase, type SetupScanView } from '../setup-data'
import { scanAgentStatus } from '../setup-scan-status'
import { useMatchesMedia } from '@/lib/use-media'
import { PageHeading } from './shared'

/** PROTO savings.js status phrases, one per scan phase. */
const STATUS: Record<SetupScanPhase, string> = {
  idle: 'Finding your recent work.',
  reading: 'Finding your recent work.',
  checking: 'Finding the context behind your work.',
  saving: 'Preparing your overview.',
  'awaiting-consent': 'Choose the tools to include.',
  uploading: 'Discovering your work, rules and focus…',
  done: 'Preparing your overview.',
  failed: 'Setup stopped. Try again when you are ready.',
}

/** Step 1: each detected agent ticks in and its prompt count climbs while the worker reads the last 30 days. */
export function ScanScreen({ scan, onImproveProductChange, onConfirmUpload, consentError, consentSending, preferenceError, onRetry, retrying, retryError }: {
  scan: SetupScanView
  onImproveProductChange: (improveProduct: boolean) => void
  onConfirmUpload: (upload: boolean, agents?: string[]) => void
  consentError?: string | null
  consentSending?: boolean
  preferenceError: string | null
  onRetry: () => void
  retrying: boolean
  retryError: string | null
}) {
  const detected = scan.agents.filter((agent) => agent.detected)
  const [unticked, setUnticked] = useState<string[]>([])
  // Offer every tool that has prompts, even when its history folder is gone and only saved prompts remain.
  const uploadable = scan.agents.filter((agent) => agent.prompts > 0)
  const chosen = uploadable.filter((agent) => !unticked.includes(agent.id)).map((agent) => agent.id)
  const reducedMotion = useMatchesMedia('(prefers-reduced-motion: reduce)')
  return (
    <section aria-labelledby="scan-title">
      <PageHeading id="scan-title" title={scan.phase === 'awaiting-consent' ? 'Pick up where you left off.' : 'Finding your recent work.'} lead={detected.map((agent) => agent.label).join(' · ') || undefined} />
      <div className="panel is-memory scan-panel">
        {/* Texture behind the panel's content; reduced motion holds the dots still (speedScale 0). */}
        <DottedGlowBackground className="scan-dots" gap={16} radius={1.5} color="rgba(75, 70, 200, 0.5)" glowColor="rgba(91, 87, 230, 0.9)" opacity={0.5} speedScale={reducedMotion ? 0 : 1} />
        <ul className="scan-agents" aria-label="Agents found on this computer">
          {detected.map((agent) => {
            const status = scanAgentStatus(agent)
            return (
              <li key={agent.id} className={status.note ? 'cannot-run' : undefined}>
                <span className="check" aria-hidden="true"><CheckIcon strokeWidth={3} /></span>
                <AgentMark tool={agentToolFor(agent.id)} className="mark" />
                <span>{agent.label} <span className="detected">({status.label})</span></span>
                <span className="count">{agent.prompts.toLocaleString('en-US')} messages</span>
                {status.note && <span className="scan-agent-note">{status.note}</span>}
              </li>
            )
          })}
        </ul>
        <div className="scan-meter">
          <progress max={100} value={scan.percent} aria-label="Scan progress">{scan.percent}%</progress>
          <span className="scan-percent" aria-hidden="true">{scan.percent}%</span>
        </div>
        <label className="scan-improve-product">
          <input type="checkbox" checked={scan.improveProduct} disabled={scan.phase === 'uploading'} onChange={(event) => onImproveProductChange(event.target.checked)} />
          <span>Also share my anonymized setup results to help improve claude-mem (optional)</span>
        </label>
        {scan.phase === 'awaiting-consent' && (
          <div className="scan-consent" role="group" aria-label="Discover your work">
            <p>
              Claude-Mem scans your transcripts to automatically discover your existing work, your preferences, and what you’re focused on.
            </p>
            <p className="scan-consent-notice">
              Selected messages are sent to cmem.ai and an AI provider.
            </p>
            <details className="scan-consent-details">
              <summary>What gets uploaded?</summary>
              <p>The full text of your messages from the last 30 days in the selected tools, with session IDs, project names, folder paths and timestamps.</p>
            </details>
            <ul className="scan-consent-agents" aria-label="Tools to upload">
              {uploadable.map((agent) => (
                <li key={agent.id}>
                  <label>
                    <input type="checkbox" checked={!unticked.includes(agent.id)}
                      onChange={(event) => setUnticked(event.target.checked ? unticked.filter((id) => id !== agent.id) : [...unticked, agent.id])} />
                    <span>{agent.label} ({agent.prompts.toLocaleString('en-US')} messages)</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="scan-consent-actions">
              <button type="button" className="primary" disabled={chosen.length === 0 || consentSending} onClick={() => onConfirmUpload(true, chosen)}>Discover My Work, Rules &amp; Focus</button>
              <button type="button" className="scan-consent-skip" disabled={consentSending} onClick={() => onConfirmUpload(false)}>Skip this step</button>
            </div>
            {consentSending && <p className="scan-status" role="status">Sending your choice…</p>}
            {consentError && <p className="scan-error" role="alert">{consentError}</p>}
          </div>
        )}
        <p className="scan-status" role="status" aria-live="polite">{STATUS[scan.phase]}</p>
        {preferenceError && <p className="scan-error" role="alert">{preferenceError}</p>}
        {scan.error && <p className="scan-error" role="alert">{scan.error}</p>}
        {retryError && <p className="scan-error" role="alert">{retryError}</p>}
        {scan.phase === 'failed' && <button type="button" className="scan-retry" onClick={onRetry} disabled={retrying}>{retrying ? 'Starting again…' : 'Try again'}</button>}
      </div>
    </section>
  )
}

