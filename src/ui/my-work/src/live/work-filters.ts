// My Work's filters: which requests each one shows.
import { isDone, needsYou, type Request } from '../data.ts'
import type { WorkFilter } from '../store/store-types.ts'

/** Every request is under Open or under Done, never both: Done (shipped, checked, closed) shows only when asked for. */
export const FILTER_MATCHES: Record<WorkFilter, (request: Request) => boolean> = {
  open: (request) => !isDone(request),
  'needs-you': needsYou,
  working: (request) => request.state === 'working',
  done: isDone,
}
