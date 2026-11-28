// One request on one line (c-work-cards-view, decision G4): working, idle and shipped requests on a focus area's Cards
// board. Self-contained, so any board layout can mount it (plan rule 12).
import { ChevronRightIcon } from 'lucide-react'
import { RunningFor } from '@/components/live-motion'
import { DURATION_WORD } from '@/live/running-time'
import { StateBadge } from '@/components/bits'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { requestTitle, type Request } from '@/data'

/**
 * The whole row is one button that opens the request's drawer (one Tab stop per request). The title ends in an
 * ellipsis when the row is too narrow; the button's name is the whole title, and so is its tooltip, which opens on
 * hover, keyboard focus and tap (G10; truncation-strategy). The state word, the reviewed percent and the duration are
 * monospace columns at the right; a phone keeps the state and the title. The row is the small button's height (h-9)
 * and the primitive's own touch rule makes it 44px on touch (plan rule 6); the row sets no touch size of its own.
 */
export function RequestLine({ request, onOpen, className }: {
  request: Request
  onOpen: (request: Request) => void
  className?: string
}) {
  const { t } = useI18n()
  const title = requestTitle(request, t)
  const percent = request.progress.readings > 0 || request.progress.completedAt ? request.progress.percent : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="bare" data-request-line={request.state} data-request-opener={request.id} onClick={() => onOpen(request)}
          className={cn('flex h-9 w-full items-center gap-3 rounded-lg px-3 py-1.5 text-sm hover-enabled:bg-surface', className)}>
          <span className={cn('min-w-0 flex-1 truncate font-medium', !request.title && 'text-muted-foreground')}>{title}</span>
          <StateBadge state={request.state} />
          {percent !== null && <span className="hidden w-11 shrink-0 text-right text-xs text-muted-foreground mono-number sm:inline">{percent}%</span>}
          <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
            <span className="sr-only">{t(DURATION_WORD[request.state])}</span>
            <RunningFor request={request} />
          </span>
          <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{title}</TooltipContent>
    </Tooltip>
  )
}
