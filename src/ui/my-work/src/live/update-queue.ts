// Which requests changed between two work models, so their cards can show the "Just updated" dot, and what changed,
// so My Work can say it out loud ("Shipped: Move embeddings into their own table").
import type { LiveState, Request } from '../data.ts'

/** Requests whose recorded content changed, or that are new, since the shown model. */
export function freshlyUpdatedRequestIds(shown: Request[], next: Request[]): string[] {
  const shownFingerprints = new Map(shown.map((request) => [request.id, request.contentFingerprint]))
  return next
    .filter((request) => !shownFingerprints.has(request.id) || shownFingerprints.get(request.id) !== request.contentFingerprint)
    .map((request) => request.id)
}

/** One thing that changed in a request between two models the screen showed. `at` is when the screen saw it. */
export type RequestChange =
  | { kind: 'new'; requestId: string; title: string; at: number }
  | { kind: 'state'; requestId: string; title: string; from: LiveState; to: LiveState; at: number }
  | { kind: 'progress'; requestId: string; title: string; from: number | null; to: number; at: number }

/** How many changes My Work keeps to show. */
export const RECENT_CHANGES_KEPT = 12

const titleOf = (request: Request) => request.title ?? request.resolvesTo?.title ?? 'New request, title being written'

/**
 * A request goes idle on the clock alone: the local source rebuilds every minute and an untouched request turns idle
 * after its quiet period, with nothing new recorded. That is not a change worth announcing or glowing for.
 */
const clockOnlyIdle = (previous: Request, next: Request) =>
  next.state === 'idle' && previous.contentFingerprint === next.contentFingerprint

/**
 * What changed between the shown model and the next one: a request that appeared, a state that moved, or a reviewed
 * percent that went up. Read only from the two models, never guessed. Nothing on the first model.
 */
export function requestChanges(shown: Request[], next: Request[], at: number): RequestChange[] {
  const before = new Map(shown.map((request) => [request.id, request]))
  const changes: RequestChange[] = []
  for (const request of next) {
    const previous = before.get(request.id)
    const title = titleOf(request)
    if (!previous) {
      if (!request.closed) changes.push({ kind: 'new', requestId: request.id, title, at })
    } else if (previous.state !== request.state && !clockOnlyIdle(previous, request)) {
      changes.push({ kind: 'state', requestId: request.id, title, from: previous.state, to: request.state, at })
    } else if (request.progress.percent !== null && request.progress.percent > (previous.progress.percent ?? -1)) {
      changes.push({ kind: 'progress', requestId: request.id, title, from: previous.progress.percent, to: request.progress.percent, at })
    }
  }
  return changes
}

/** Adds the newest changes in front, keeping one entry per request (its newest) and at most RECENT_CHANGES_KEPT. */
export function mergeRecentChanges(recent: RequestChange[], latest: RequestChange[]): RequestChange[] {
  if (latest.length === 0) return recent
  const latestIds = new Set(latest.map((change) => change.requestId))
  return [...latest, ...recent.filter((change) => !latestIds.has(change.requestId))].slice(0, RECENT_CHANGES_KEPT)
}
