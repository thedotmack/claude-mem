// The pure part of the fingerprint-guarded check, from claude-mem v15.0.1 plugin/ui/work-view/app.js:125-138
// (`saveReview`) and the worker's POST /api/work-view/review (WorkViewRoutes.ts:132-152). The fetch lives in
// local-source.ts; this reads the worker's answer.
import type { WorkModel } from './work-data-source.ts'

/** What the review POST answered. Anything else throws: a failed save is never silent. */
export type ReviewResponse =
  | { kind: 'saved'; snapshot: unknown }
  /** 409: the fingerprint is stale, or the request is not reported complete. The latest model tells which. */
  | { kind: 'conflict'; serverMessage: string }
  /** 503: the worker can't read local work or its review storage right now. */
  | { kind: 'unavailable'; serverMessage: string }

/** What the person is told after pressing Check or Undo. */
export type ReviewResult =
  | { outcome: 'saved'; model: WorkModel }
  /** The version on screen is not the latest one; the latest is shown now and nothing was saved. */
  | { outcome: 'changed-while-reading'; model: WorkModel }
  /** The latest version was refused as it is (409 "not reported complete"); nothing was saved. */
  | { outcome: 'refused'; serverMessage: string; model: WorkModel }
  | { outcome: 'unavailable'; serverMessage: string }

export const CHANGED_WHILE_READING_MESSAGE = 'This work changed while you were reading. Review the latest version before checking.'
export const CHECKED_LOCALLY_MESSAGE = 'Checked locally.'
export const CHECK_UNDONE_MESSAGE = 'Check undone. The result is ready to review.'

const serverErrorText = (body: unknown): string | null => {
  const error = (body as { error?: unknown } | null)?.error
  return typeof error === 'string' && error.trim() ? error.trim() : null
}

/** Maps the worker's status and JSON body. 200, 409 and 503 are answers; every other status throws with its error text. */
export function readReviewResponse(status: number, body: unknown): ReviewResponse {
  if (status === 200) {
    if (!body || typeof body !== 'object') throw new Error('The local review was saved, but the worker sent no work snapshot back. Reload to see it.')
    return { kind: 'saved', snapshot: body }
  }
  if (status === 409) return { kind: 'conflict', serverMessage: serverErrorText(body) ?? 'This work changed. Read the latest result before checking it.' }
  if (status === 503) return { kind: 'unavailable', serverMessage: serverErrorText(body) ?? 'Local work is unavailable right now (503).' }
  throw new Error(`The local review could not be saved (${status}): ${serverErrorText(body) ?? 'the worker gave no reason'}`)
}

/**
 * A 409 means one of two things on the worker. When the latest version still has the fingerprint that was sent,
 * nothing changed: the worker refused this version as it is (not reported complete). Otherwise the work changed
 * (or left the loaded work) while it was being read.
 */
export function conflictReason(expectedFingerprint: string, latestFingerprint: string | undefined): 'changed-while-reading' | 'refused' {
  return latestFingerprint === expectedFingerprint ? 'refused' : 'changed-while-reading'
}
