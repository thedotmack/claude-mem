// Which requests changed between two work models, so their cards can show the "Just updated" dot.
import type { Request } from '../data.ts'

/** Requests whose recorded content changed, or that are new, since the shown model. Nothing is "fresh" on the first model. */
export function freshlyUpdatedRequestIds(shown: Request[], next: Request[]): string[] {
  if (shown.length === 0) return []
  const shownFingerprints = new Map(shown.map((request) => [request.id, request.contentFingerprint]))
  return next
    .filter((request) => !shownFingerprints.has(request.id) || shownFingerprints.get(request.id) !== request.contentFingerprint)
    .map((request) => request.id)
}
