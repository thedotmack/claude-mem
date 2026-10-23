import type { HistoryImportProgress } from '../setup-data'
import { PageHeading } from './shared'

/** PROTO workspace-data.js history phases, one per quarter of the upload. */
const PHASES = ['Reading your projects.', 'Bringing over your sessions.', 'Importing your memories.', 'Building your cross-project search.']

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
        <p className="scan-status" role="status" aria-live="polite">{PHASES[Math.min(3, Math.floor(percent / 26))]}</p>
      </div>
    </section>
  )
}
