// What My Work's home page leads with (design pass Phase 6; Codex D01, Claude D02 and D03), from recorded state only:
// the requests marked as waiting on the owner (data.ts needsYou: your move, or done and waiting for a check, which a
// review records, Phase 1), and the requests an agent is working on. Pure, with .ts imports, so `node --test` loads it.
import { firstNeedingYou, isWorkingNow, startedTimestamp, type Request } from '../data.ts'

/**
 * Why the lead card's request leads, which its label says ("Waiting on you in Viewer", "Working in Viewer"): it is
 * marked as waiting on the owner, or nothing is and it is the working request reviewed most recently. The one list:
 * the home page's words for each are a Record over it.
 */
export const HOME_LEAD_KINDS = ['waiting', 'working'] as const
export type HomeLeadKind = (typeof HOME_LEAD_KINDS)[number]

export interface HomeWork {
  /** Open requests marked as waiting on the owner, in the boards' attention order (data.ts byAttention). */
  waiting: Request[]
  /** Open requests an agent is working on (data.ts isWorkingNow, the one rule for it), the newest review first (byNewestReview). */
  working: Request[]
  /** The request the lead card shows and why; null when nothing waits on the owner and nothing is working. */
  lead: { kind: HomeLeadKind; request: Request } | null
}

/** A review's time, for sorting: its recorded instant, or none (sample fixtures and unreviewed requests carry none). */
const reviewedAt = (request: Request) => {
  const at = request.progress.reviewedAtIso ? Date.parse(request.progress.reviewedAtIso) : Number.NaN
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
}

/**
 * The newest review first; a request with no recorded review time after every one with one; between those, and between
 * two reviewed at the same instant, the one that started most recently first.
 */
export const byNewestReview = (a: Request, b: Request) => {
  const newerReview = reviewedAt(b) - reviewedAt(a)
  return Number.isNaN(newerReview) || newerReview === 0 ? startedTimestamp(b) - startedTimestamp(a) : newerReview
}

/**
 * Home's requests, closed ones left out: what waits on the owner, what is working, and which one leads. The first that
 * waits on the owner leads; when none does, the working request with the newest review leads, and the first line
 * under the title already says why.
 */
export function homeWork(requests: readonly Request[]): HomeWork {
  const waiting = firstNeedingYou(requests.filter((request) => !request.closed))
  const working = requests.filter(isWorkingNow).sort(byNewestReview)
  const lead: HomeWork['lead'] = waiting.length > 0 ? { kind: 'waiting', request: waiting[0] }
    : working.length > 0 ? { kind: 'working', request: working[0] } : null
  return { waiting, working, lead }
}
