import type { HistoryImportProgress } from '../setup-data'
import { PageHeading } from './shared'

/** The PROTO history-import phases, minus "Bringing over your sessions.": the import carries observations only (gap G2). */
const PHASES = ['Reading your projects.', 'Importing your memories.', 'Building your cross-project search.']

/** Step 6b, On The Go with history only (PROTO #route-import). */
export function ImportScreen({ progress }: { progress: HistoryImportProgress | null }) {
  const percent = progress?.percent ?? 0
  return (
    <section aria-labelledby="import-title">
      <PageHeading id="import-title" title="Bringing your memory together." lead="All your projects. Ready to pick up again." />
      <div className="panel is-memory import-panel">
        <div className="scan-meter">
          <progress max={100} value={percent} aria-label="Full history import progress">{percent}%</progress>
          <span className="scan-percent" aria-hidden="true">{percent}%</span>
        </div>
        <p className="scan-status" role="status" aria-live="polite">{PHASES[Math.min(PHASES.length - 1, Math.floor(percent / 34))]}</p>
      </div>
    </section>
  )
}
