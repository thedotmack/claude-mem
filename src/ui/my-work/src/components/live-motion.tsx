// What makes My Work feel alive without inventing anything: a clock that keeps open requests' running time current,
// a line naming what is moving right now, and a ticker of what just changed. Every word comes from the work model or
// from the difference between two models the screen showed (live/update-queue.ts). Reduced motion: no slides, the
// text simply swaps (MotionConfig reducedMotion="user" in App.tsx, and the CSS rule in index.css), and here in the
// component too (plan rule 8).
import { useEffect, useState } from 'react'
import { useNow } from '@/lib/use-now'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowRightIcon, PauseIcon, PlayIcon } from 'lucide-react'
import { LocalTime, STATE_LABEL, type Translate } from '@/components/bits'
import { sentenceWith } from '@/lib/sentence-with'
import { Button } from '@/components/ui/button'
import { interpolate, useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { TICKER_OFFERS_RECONNECT, TICKER_STEP_MS, tickerState, type TickerState } from '@/live/change-ticker'
import { durationWords } from '@/live/running-time'
import type { RequestChange } from '@/live/update-queue'
import { Req } from '@/spec/req'
import type { LiveState, Request } from '@/data'
import { useConnection, useRecentChanges, useWorkModel } from '@/store'

/**
 * How long a request has been going, in monospace so durations line up from card to card (plan rule 9), at the body's
 * small size rather than the card's 12px metadata (c-live-motion-running-for F: 12.75px, 12px at 390). An open live
 * request counts up as you watch, with a still dot (rule 8: nothing here moves); anything else shows its record. No
 * "long" marker: no constant in claude-mem says when a run is long (STALE_AFTER_MS measures quiet time, not a run's
 * length), and the plan allows the marker only with one.
 */
export function RunningFor({ request }: { request: Request }) {
  const { t } = useI18n()
  const counting = !!request.runningLive && !!request.startedAtIso
  const now = useNow(counting)
  const milliseconds = counting ? now - Date.parse(request.startedAtIso!) : request.runningForMs
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      {counting && request.state !== 'idle' && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-working-foreground" />}
      <span className="mono-number">{durationWords(milliseconds, request.runningFor, t)}</span>
    </span>
  )
}

/** "just now", "3 min ago": when the screen saw a change. */
function sinceLabel(at: number, now: number, t: Translate) {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return t('just now')
  if (minutes < 60) return interpolate(t('{minutes} min ago'), { minutes })
  return interpolate(t('{hours} hr ago'), { hours: Math.floor(minutes / 60) })
}

/** Each state a request moved into, worded as the ticker says it, and in that state's colour (the badges' colours). */
const MOVED_INTO: Record<LiveState, { verb: string; tone: string }> = {
  working: { verb: 'Working', tone: 'text-working-foreground' },
  'needs-check': { verb: 'Ready to check', tone: 'text-review-foreground' },
  'your-move': { verb: 'Needs you', tone: 'text-attention-foreground' },
  idle: { verb: 'Went idle', tone: 'text-idle-foreground' },
  shipped: { verb: STATE_LABEL.shipped, tone: 'text-shipped-foreground' },
}

/** What one change says, in the words the badges use, in the reader's language. */
function changeWords(change: RequestChange, t: Translate): { verb: string; tone: string } {
  if (change.kind === 'new') return { verb: t('New request'), tone: 'text-accent-foreground' }
  if (change.kind === 'progress') {
    return {
      verb: change.from === null ? interpolate(t('First review {to}%'), { to: change.to }) : interpolate(t('{from}% → {to}%'), { from: change.from, to: change.to }),
      tone: 'text-working-foreground',
    }
  }
  if (change.to === 'working' && change.from === 'idle') return { verb: t('Moving again'), tone: MOVED_INTO.working.tone }
  return { verb: t(MOVED_INTO[change.to].verb), tone: MOVED_INTO[change.to].tone }
}

/** The slide between two changes: 0.4 s, inside the half second TICKER_STEP_MS (live/change-ticker.ts) leaves after reading. */
const TICKER_SLIDE = { type: 'spring', bounce: 0, duration: 0.4 } as const
/**
 * The ticker cycles through this many of the newest changes: the mockup's five position dots
 * (after/c-live-motion-change-ticker.png), one per change. Older ones are counted beside them, never dropped unsaid.
 */
const TICKER_SHOWS = 5

/**
 * The ticker's label and its line in each state (live/change-ticker.ts TickerState), each in its own t() call. `line`
 * is null where the state shows its changes instead; `asOf` adds the time of the shown data.
 */
const TICKER_WORDS: Record<TickerState, { label: (t: Translate) => string; line: ((t: Translate) => string) | null; asOf: boolean }> = {
  connecting: { label: (t) => t('Connecting'), line: (t) => t('Waiting for the first live update.'), asOf: false },
  quiet: { label: (t) => t('Just changed'), line: (t) => t('Nothing has changed since {time}.'), asOf: false },
  changes: { label: (t) => t('Just changed'), line: null, asOf: false },
  'stream-down': { label: (t) => t('Not live'), line: (t) => t('Changes are not arriving.'), asOf: true },
  'source-behind': { label: (t) => t('Not live'), line: (t) => t('Connected, but the saved work is not up to date.'), asOf: true },
}

/** The line's mark in each state: green while live, a hollow ring otherwise. Still in every state (rule 8). */
const TICKER_MARK: Record<TickerState, string> = {
  connecting: 'border-[1.5px] border-idle-foreground bg-transparent',
  quiet: 'bg-shipped-foreground',
  changes: 'bg-shipped-foreground',
  'stream-down': 'border-[1.5px] border-idle-foreground bg-transparent',
  'source-behind': 'border-[1.5px] border-idle-foreground bg-transparent',
}

/**
 * "Just changed": the newest changes the screen saw, one at a time, every few seconds, each opening its request. It
 * pauses with its pause button, and while the pointer is on it or a key has focus in it (auto-rotation-controls).
 * At rest it says since when nothing has changed and how many working requests it watches. While the feed connects it
 * says so; when it is not live it says why, with the time of the shown data, and offers Reconnect only where reading
 * the page again can help (live/change-ticker.ts).
 */
export function ChangeTicker({ onOpen }: { onOpen: (requestId: string) => void }) {
  const { t } = useI18n()
  const changes = useRecentChanges()
  const { sourceKind, requests } = useWorkModel()
  const connection = useConnection()
  const reduceMotion = useReducedMotion()
  const state = tickerState(connection, sourceKind === 'sample', changes.length)
  const live = state === 'quiet' || state === 'changes'
  const now = useNow(changes.length > 0)
  const shown = changes.slice(0, TICKER_SHOWS)
  const older = changes.length - shown.length
  const [step, setStep] = useState(0)
  // When this screen started watching: "nothing has changed since" then.
  const [watchingSince] = useState(() => new Date().toISOString())
  const [pausedByButton, setPausedByButton] = useState(false)
  const [pointerOn, setPointerOn] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const paused = pausedByButton || pointerOn || focusIn
  // A new change always shows first.
  const newest = shown[0]
  const [newestSeen, setNewestSeen] = useState(newest)
  if (newest !== newestSeen) { setNewestSeen(newest); setStep(0) }
  // Keyed on the newest change too, so a change that arrives restarts the timer and gets its full step on screen.
  useEffect(() => {
    if (shown.length < 2 || paused || !live) return
    const timer = setInterval(() => setStep((current) => (current + 1) % shown.length), TICKER_STEP_MS)
    return () => clearInterval(timer)
  }, [shown.length, newest, paused, live])
  const change = shown[step % Math.max(1, shown.length)]
  const watching = requests.filter((request) => request.state === 'working' && !request.closed).length
  const words = change ? changeWords(change, t) : null
  const { label, line, asOf } = TICKER_WORDS[state]
  return (
    <Req ids={['R6.1', 'R6.4']}>
      <div data-ticker={state} data-paused={paused || undefined}
        onPointerEnter={() => setPointerOn(true)} onPointerLeave={() => setPointerOn(false)}
        onFocus={() => setFocusIn(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusIn(false) }}
        className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-2xl border border-control-edge bg-card/60 py-1 pr-1.5 pl-3 text-[0.82rem] shadow-panel sm:flex-nowrap sm:rounded-full">
        <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', TICKER_MARK[state])} />
        <span className="shrink-0 text-xs font-medium text-muted-foreground">{label(t)}</span>
        {/* Screen readers hear each new change once. The cycling line below is off for them, or every slide would be read forever. */}
        <span role="status" aria-live="polite" className="sr-only">{newest ? `${changeWords(newest, t).verb}: ${newest.title}` : ''}</span>
        {line ? (
          <>
            <span className={cn('min-w-0 flex-1 text-muted-foreground', state === 'quiet' && 'truncate')}>
              {state === 'quiet' ? sentenceWith(line(t), 'time', <LocalTime iso={watchingSince} />) : line(t)}
              {asOf && connection.lastSuccessfulCheckAt && <>{' '}{sentenceWith(t('Showing the page as of {time}.'), 'time', <LocalTime iso={connection.lastSuccessfulCheckAt} />)}</>}
            </span>
            {state === 'quiet' && <span className="hidden shrink-0 pr-2 text-xs text-muted-foreground tabular sm:inline">{interpolate(watching === 1 ? t('Watching {count} working request') : t('Watching {count} working requests'), { count: watching })}</span>}
            {/* The stream reconnects by itself; Reconnect starts over now, reading the page and opening a new stream. */}
            {TICKER_OFFERS_RECONNECT[state] && <Button variant="outline" size="sm" className="shrink-0" onClick={() => window.location.reload()}>{t('Reconnect')}</Button>}
          </>
        ) : (
          <>
            {/* popLayout takes the change that leaves out of the flow, so the box keeps the height of the Button inside. */}
            <div aria-live="off" className="relative min-w-0 flex-1">
              <AnimatePresence initial={false} mode="popLayout">
                {change && words && (
                  <motion.div
                    key={`${change.requestId}-${change.at}`}
                    initial={reduceMotion ? false : { y: 18, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { y: -18, opacity: 0 }}
                    transition={TICKER_SLIDE}
                    className="min-w-0"
                  >
                    {/* The primitive: its focus ring, cursor and touch size (44px on touch, G14 and rule 6). */}
                    <Button variant="ghost" size="sm" onClick={() => onOpen(change.requestId)} className="w-full min-w-0 justify-start gap-2 px-1 text-left text-[0.82rem] font-normal">
                      <span className={cn('shrink-0 font-medium', words.tone)}>{words.verb}</span>
                      <span className="min-w-0 truncate">{change.title}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground mono-number">{sinceLabel(change.at, now, t)}</span>
                      <ArrowRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            {shown.length > 1 && (
              <span className="hidden shrink-0 items-center gap-1 sm:flex" aria-hidden="true">
                {shown.map((entry, index) => <span key={`${entry.requestId}-${entry.at}`} className={cn('size-1.5 rounded-full', index === step % shown.length ? 'bg-foreground/70' : 'bg-foreground/25')} />)}
              </span>
            )}
            {older > 0 && <span className="shrink-0 text-xs text-muted-foreground tabular">{interpolate(older === 1 ? t('{count} older change') : t('{count} older changes'), { count: older })}</span>}
            {shown.length > 1 && (
              <Button variant="ghost" size="icon-sm" className="shrink-0" aria-pressed={pausedByButton}
                aria-label={pausedByButton ? t('Play the changes') : t('Pause the changes')} onClick={() => setPausedByButton((current) => !current)}>
                {pausedByButton ? <PlayIcon /> : <PauseIcon />}
              </Button>
            )}
          </>
        )}
      </div>
    </Req>
  )
}
