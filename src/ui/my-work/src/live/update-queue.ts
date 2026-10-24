// Queued updates while reading, the pure part of claude-mem v15.0.1 plugin/ui/work-view/app.js:143-158
// (`isReading` and `apply`). The DOM reads that feed it live in data.ts.
import type { Request } from '../data.ts'

/** Scrolled further than this, a new model would move what the person is reading. */
export const READING_SCROLL_Y = 220

export interface ReadingSignals {
  /** The request drawer, or any other dialog, is open. */
  dialogOpen: boolean
  /** Keyboard focus is in a control on the page (a card, filter, sort or toolbar). */
  focusInControl: boolean
  scrollY: number
}

/** Hold a new model while the person is reading, but never before any work has been shown. */
export function shouldHoldWorkModelUpdate(hasShownWork: boolean, signals: ReadingSignals): boolean {
  if (!hasShownWork) return false
  return signals.dialogOpen || signals.focusInControl || signals.scrollY > READING_SCROLL_Y
}

/** Requests whose recorded content changed, or that are new, since the shown model. Nothing is "fresh" on the first model. */
export function freshlyUpdatedRequestIds(shown: Request[], next: Request[]): string[] {
  if (shown.length === 0) return []
  const shownFingerprints = new Map(shown.map((request) => [request.id, request.contentFingerprint]))
  return next
    .filter((request) => !shownFingerprints.has(request.id) || shownFingerprints.get(request.id) !== request.contentFingerprint)
    .map((request) => request.id)
}
