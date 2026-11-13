// An open request's running time, kept current by the page's clock. Every figure comes from the work model.
import { useNow } from '@/lib/use-now'
import { formatDuration } from '@/live/to-work-model'
import type { Request } from '@/data'

/** How long a request has been going. An open live request counts up as you watch; anything else shows its record. */
export function RunningFor({ request }: { request: Request }) {
  const now = useNow(!!request.runningLive && !!request.startedAtIso)
  if (!request.runningLive || !request.startedAtIso) return <>{request.runningFor}</>
  return <>{formatDuration(now - Date.parse(request.startedAtIso))}</>
}
