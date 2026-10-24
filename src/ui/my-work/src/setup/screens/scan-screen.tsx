import { CheckIcon } from 'lucide-react'
import { AgentMark } from '@/components/brand'
import { agentToolFor, type SetupScanPhase, type SetupScanView } from '../setup-data'
import { scanAgentStatus } from '../setup-scan-status'
import { PageHeading } from './shared'

/** PROTO savings.js status phrases, one per scan phase. */
const STATUS: Record<SetupScanPhase, string> = {
  idle: 'Looking for usage history.',
  reading: 'Looking for usage history.',
  checking: 'Checking repeated context.',
  saving: 'Preparing your usage summary.',
  uploading: 'Finding your goals, work and rules.',
  done: 'Preparing your usage summary.',
  failed: 'Setup stopped. Try again when you are ready.',
}

/** Step 1: each detected agent ticks in and its prompt count climbs while the worker reads the last 30 days. */
export function ScanScreen({ scan, onImproveProductChange, preferenceError, onRetry, retrying, retryError }: {
  scan: SetupScanView
  onImproveProductChange: (improveProduct: boolean) => void
  preferenceError: string | null
  onRetry: () => void
  retrying: boolean
  retryError: string | null
}) {
  const detected = scan.agents.filter((agent) => agent.detected)
  return (
    <section aria-labelledby="scan-title">
      <PageHeading id="scan-title" title="Checking your AI usage." lead={detected.map((agent) => agent.label).join(' · ') || undefined} />
      <div className="panel is-memory scan-panel">
        <ul className="scan-agents" aria-label="Agents found on this computer">
          {detected.map((agent) => {
            const status = scanAgentStatus(agent)
            return (
              <li key={agent.id} className={status.note ? 'cannot-run' : undefined}>
                <span className="check" aria-hidden="true"><CheckIcon strokeWidth={3} /></span>
                <AgentMark tool={agentToolFor(agent.id)} className="mark" />
                <span>{agent.label} <span className="detected">({status.label})</span></span>
                <span className="count">{agent.prompts.toLocaleString('en-US')} prompts</span>
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
          <span>Help make claude-mem smarter for everyone with my anonymized setup results</span>
        </label>
        <p className="scan-status" role="status" aria-live="polite">{STATUS[scan.phase]}</p>
        {preferenceError && <p className="scan-error" role="alert">{preferenceError}</p>}
        {scan.error && <p className="scan-error" role="alert">{scan.error}</p>}
        {retryError && <p className="scan-error" role="alert">{retryError}</p>}
        {scan.phase === 'failed' && <button type="button" className="scan-retry" onClick={onRetry} disabled={retrying}>{retrying ? 'Starting again…' : 'Try again'}</button>}
      </div>
    </section>
  )
}
