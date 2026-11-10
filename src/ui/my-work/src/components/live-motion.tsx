// What makes My Work feel alive without inventing anything: a clock that keeps open requests' running time current,
// a line naming what is moving right now, and a ticker of what just changed. Every word comes from the work model or
// from the difference between two models the screen showed (live/update-queue.ts). Reduced motion: no slides, the
// text simply swaps (MotionConfig reducedMotion="user" in App.tsx, and the CSS rule in index.css).
import { useEffect, useState } from 'react'
import { useNow } from '@/lib/use-now'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowRightIcon } from 'lucide-react'
import { STATE_LABEL } from '@/components/bits'
import { cn } from '@/lib/utils'
import { formatDuration } from '@/live/to-work-model'
import type { RequestChange } from '@/live/update-queue'
import { Req } from '@/spec/req'
import type { Request } from '@/data'
import { useConnection, useRecentChanges, useWorkModel } from '@/store'

/** How long a request has been going. An open live request counts up as you watch; anything else shows its record. */
export function RunningFor({ request }: { request: Request }) {
  const now = useNow(!!request.runningLive && !!request.startedAtIso)
  if (!request.runningLive || !request.startedAtIso) return <>{request.runningFor}</>
  return <>{formatDuration(now - Date.parse(request.startedAtIso))}</>
}

/** "just now", "3 min ago": when the screen saw a change. */
function sinceLabel(at: number, now: number) {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return `${hours} hr ago`
}

/** What one change says, in the words the badges use. */
function changeWords(change: RequestChange): { verb: string; tone: string } {
  if (change.kind === 'new') return { verb: 'New request', tone: 'text-accent-foreground' }
  if (change.kind === 'progress') return { verb: `${change.from === null ? 'First review' : `${change.from}% →`} ${change.to}%`, tone: 'text-working-foreground' }
  const tone = {
    working: 'text-working-foreground', 'needs-check': 'text-review-foreground', 'your-move': 'text-attention-foreground',
    idle: 'text-idle-foreground', shipped: 'text-shipped-foreground',
  }[change.to]
  const verb = change.to === 'working' ? (change.from === 'idle' ? 'Moving again' : 'Working')
    : change.to === 'needs-check' ? 'Ready to check'
      : change.to === 'your-move' ? 'Needs you'
        : change.to === 'idle' ? 'Went idle'
          : STATE_LABEL[change.to]
  return { verb, tone }
}

/** How long each change stays in the ticker before the next one slides in. */
const TICKER_STEP_MS = 4500
/** The ticker cycles through this many of the newest changes. */
const TICKER_SHOWS = 5

/**
 * "Just changed": the newest changes the screen saw, one at a time, sliding up every few seconds. Each one opens its
 * request. Before anything changes it says it is watching, and only while the feed is actually live.
 */
export function ChangeTicker({ onOpen }: { onOpen: (requestId: string) => void }) {
  const changes = useRecentChanges()
  const { sourceKind } = useWorkModel()
  const connection = useConnection()
  const live = sourceKind === 'sample' || connection.isLive
  const now = useNow(changes.length > 0)
  const shown = changes.slice(0, TICKER_SHOWS)
  const [step, setStep] = useState(0)
  // A new change always shows first.
  const newest = shown[0]
  const [newestSeen, setNewestSeen] = useState(newest)
  if (newest !== newestSeen) { setNewestSeen(newest); setStep(0) }
  // Keyed on the newest change too, so a change that arrives restarts the timer and gets its full step on screen.
  useEffect(() => {
    if (shown.length < 2) return
    const timer = setInterval(() => setStep((current) => (current + 1) % shown.length), TICKER_STEP_MS)
    return () => clearInterval(timer)
  }, [shown.length, newest])
  if (!live && shown.length === 0) return null
  const change = shown[step % Math.max(1, shown.length)]
  return (
    <Req ids={['R6.1', 'R6.4']}>
      <div className="flex min-h-9 min-w-0 items-center gap-2.5 overflow-hidden rounded-full border border-border/70 bg-card/60 py-1 pr-1.5 pl-3 text-[0.82rem] shadow-panel">
        <span className="relative flex size-2 shrink-0">
          {live && <span className="absolute inline-flex size-full rounded-full bg-shipped-foreground/40 motion-safe:animate-ping" />}
          <span className={cn('relative inline-flex size-2 rounded-full', live ? 'bg-shipped-foreground' : 'bg-idle-foreground')} />
        </span>
        <span className="hidden shrink-0 text-xs font-medium text-muted-foreground sm:inline">Just changed</span>
        {/* Screen readers hear each new change once. The cycling line below is off for them, or every slide would be read forever. */}
        <span role="status" aria-live="polite" className="sr-only">{newest ? `${changeWords(newest).verb}: ${newest.title}` : ''}</span>
        <div aria-live="off" className="relative h-7 min-w-0 flex-1">
          <AnimatePresence initial={false} mode="popLayout">
            {change ? (
              <motion.button
                key={`${change.requestId}-${change.at}`}
                type="button"
                onClick={() => onOpen(change.requestId)}
                initial={{ y: 18, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -18, opacity: 0 }}
                transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
                className="absolute inset-0 flex min-w-0 items-center gap-2 rounded-full px-1 text-left hover:bg-surface focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className={cn('shrink-0 font-medium', changeWords(change).tone)}>{changeWords(change).verb}</span>
                <span className="min-w-0 truncate">{change.title}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{sinceLabel(change.at, now)}</span>
                <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
              </motion.button>
            ) : (
              <motion.span key="watching" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute inset-0 flex min-w-0 items-center px-1 text-muted-foreground">
                <span className="truncate">Watching your agents<span className="hidden sm:inline">. Changes show up here the moment they're recorded</span>.</span>
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        {shown.length > 1 && (
          <span className="hidden shrink-0 items-center gap-1 pr-1.5 sm:flex" aria-hidden="true">
            {shown.map((entry, index) => <span key={`${entry.requestId}-${entry.at}`} className={cn('size-1.5 rounded-full transition-colors', index === step % shown.length ? 'bg-foreground/70' : 'bg-foreground/15')} />)}
          </span>
        )}
      </div>
    </Req>
  )
}
