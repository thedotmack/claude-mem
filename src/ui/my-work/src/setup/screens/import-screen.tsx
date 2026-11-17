import { InfoIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import type { HistoryImportProgress } from '../setup-data'
import { PageHeading, SetupActions, SetupButton, type SetupBack } from './shared'

/** The PROTO history-import phases, minus "Bringing over your sessions.": the import carries observations only (gap G2). */
const PHASES = ['Reading your projects.', 'Importing your memories.', 'Building your cross-project search.']
/**
 * The percent each phase line covers. The worker reports a percent and no phase, so the lines split 0-100 into equal
 * thirds: 0-33, 34-67, 68-100 (34 = 100 / 3, rounded up, so 100% still lands on the last line).
 */
const PHASE_SPAN = Math.ceil(100 / PHASES.length)

/**
 * Step 6b, On The Go with history only (PROTO #route-import). The page shows it only while the upload runs and goes
 * back to Finish Setup by itself when it ends, so Back waits for as long as it is up. "Stop import" (E9) ends the upload
 * at once: the worker sends nothing after it, keeps what reached the account, and Finish Setup then says what was sent
 * and what is unknown. While the stop is on its way the button says so and takes no second press.
 */
export function ImportScreen({ progress, back, stopping, onStop }: {
  progress: HistoryImportProgress | null; back?: SetupBack | null
  /** The person pressed Stop and the worker has not answered yet. */
  stopping: boolean
  onStop: () => void
}) {
  const { t } = useI18n()
  const percent = progress?.percent ?? 0
  return (
    <section aria-labelledby="import-title">
      <PageHeading id="import-title" title={t('Bringing your memory together.')} lead={t('All your projects. Ready to pick up again.')} />
      <div className="panel is-memory import-panel">
        <div className="scan-meter">
          <progress max={100} value={percent} aria-label={t('Full history import progress')}>{percent}%</progress>
          <span className="scan-percent tabular" aria-hidden="true">{percent}%</span>
        </div>
        <div className="import-status">
          <p className="scan-status" role="status" aria-live="polite">{t(PHASES[Math.min(PHASES.length - 1, Math.floor(percent / PHASE_SPAN))])}</p>
          {/* "<sent> of <total>" only when the worker reports both (plan G19). */}
          {progress?.sent !== undefined && progress.total !== undefined && (
            <p className="import-count tabular">{interpolate(t('{done} of {total}'), { done: progress.sent.toLocaleString('en-US'), total: progress.total.toLocaleString('en-US') })}</p>
          )}
        </div>
        <p className="setup-hint"><InfoIcon aria-hidden="true" />{t('Keep this page open. When the import finishes, you return to Finish Setup.')}</p>
      </div>
      <SetupActions back={back}>
        {/* Outlined, as the mockup draws it: stopping is not the way forward, and the screen has no navy button. */}
        <SetupButton look="outline" busy={stopping} busyLabel={t('Stopping…')} onClick={onStop}>{t('Stop import')}</SetupButton>
      </SetupActions>
    </section>
  )
}
