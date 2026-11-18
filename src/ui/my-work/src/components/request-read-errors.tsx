// Requests the mapper could not read (c-work-request-read-error-card), as one notice either board layout can mount at
// the top of its requests (plan rule 12).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react'
import { ErrorDetails } from '@/components/error-details'
import { LocalTime, type Translate } from '@/components/bits'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { interpolate, useI18n } from '@/lib/i18n'
import { sentenceWith } from '@/lib/sentence-with'
import { Req } from '@/spec/req'
import { useStore } from '@/store'
import type { RequestReadError } from '@/live/work-data-source'

/** One unreadable request's identity: the request and the mapper's reason, so a dismissal holds for that error only. */
const readErrorIdentity = (readError: RequestReadError) => JSON.stringify([readError.requestId, readError.reason])

/**
 * What the card's Try again last did, so a press always shows its outcome (it looked the same whether the read worked
 * or failed). Its one writer is readAgain below; the card's state, so it starts over when the card mounts again.
 *
 *   not-tried ──Try again──▶ reading ──the read answers──▶ read | failed
 *   read | failed ──Try again──▶ reading
 */
type ReadAgainOutcome = 'not-tried' | 'reading' | 'read' | 'failed'

/**
 * The outcome in words, under the requests: nothing before a press; "read" says when and that those shown still
 * cannot be read (a request the fresh records fixed has left the card by then); "failed" is the plain line, its raw
 * cause under Details (G17).
 */
const READ_AGAIN_WORDS: Record<ReadAgainOutcome, ((t: Translate, stillUnreadable: number) => string) | null> = {
  'not-tried': null,
  reading: (t) => t('Reading your work again…'),
  read: (t, stillUnreadable) => stillUnreadable === 1 ? t('Read again at {time}: this one still can’t be read.') : t('Read again at {time}: these still can’t be read.'),
  failed: (t) => t('Couldn’t read your work again.'),
}

/** One unreadable request: its title, the prompt it came from, and the mapper's reason under Details (G17). */
function ReadErrorEntry({ readError, children }: { readError: RequestReadError; children?: ReactNode }) {
  const { t } = useI18n()
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
      <div className="min-w-0 flex-1 basis-56 space-y-1">
        <p className="font-medium text-foreground">{readError.title ?? t('Untitled request')}</p>
        {readError.evidenceHref && <a href={readError.evidenceHref} target="_blank" rel="noreferrer" className="text-sm">{t('Open the prompt it came from')}</a>}
        <ErrorDetails cause={readError.reason} />
      </div>
      {children}
    </li>
  )
}

/**
 * Requests whose saved records disagree with the lifecycle rules (data.ts assertConsistentRequest), once at the top of
 * the board in every layout (after every request it would not be seen): plain words, each request's title and the
 * mapper's own reason under Details (G17: it showed an internal id and a rule's text), Try again (one fresh read;
 * nothing retries by itself) with its outcome in words, and a Dismiss for each request.
 * - A dismissal holds for that request and reason (its identity): fixing another one never brings it back as an alert.
 *   A new unreadable request, or a new reason, is a new error and shows.
 * - The dismissed ones fold to one row with their count (G5's fold row, "Show them"), so none is left out unsaid (plan
 *   rule 5); the row keeps focus while it opens and closes.
 * - Dismiss moves focus on to the next error's Dismiss (the one before it when it was the last), or with none left to
 *   the board's heading (`onAllDismissed`), never to the page body. A Try again whose read leaves nothing unreadable
 *   sends focus to the same place.
 */
export function RequestReadErrors({ readErrors, onAllDismissed }: { readErrors: RequestReadError[]; onAllDismissed: () => void }) {
  const { t } = useI18n()
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const [showDismissed, setShowDismissed] = useState(false)
  const [outcome, setOutcome] = useState<{ state: ReadAgainOutcome; atIso: string | null; cause: string | null }>({ state: 'not-tried', atIso: null, cause: null })
  const dismissButtons = useRef(new Map<string, HTMLButtonElement>())
  // Where focus goes once a dismissal has redrawn the card: the next error's Dismiss, or null for the board's heading.
  const focusAfterDismiss = useRef<{ next: string | null } | null>(null)
  useEffect(() => {
    const asked = focusAfterDismiss.current
    if (!asked) return
    focusAfterDismiss.current = null
    const next = asked.next ? dismissButtons.current.get(asked.next) : undefined
    if (next) next.focus()
    else onAllDismissed()
  }, [dismissed, onAllDismissed])
  if (readErrors.length === 0) return null
  const shown = readErrors.filter((readError) => !dismissed.has(readErrorIdentity(readError)))
  const folded = readErrors.filter((readError) => dismissed.has(readErrorIdentity(readError)))
  const count = shown.length
  const title = interpolate(count === 1 ? t('{count} request couldn’t be read') : t('{count} requests couldn’t be read'), { count })
  const dismiss = (readError: RequestReadError) => {
    const identity = readErrorIdentity(readError)
    const at = shown.indexOf(readError)
    const next = shown[at + 1] ?? shown[at - 1] ?? null
    focusAfterDismiss.current = { next: next ? readErrorIdentity(next) : null }
    setDismissed((current) => new Set([...current, identity]))
  }
  const readAgain = (pressed: HTMLButtonElement) => {
    setOutcome({ state: 'reading', atIso: null, cause: null })
    void useStore.getState().retryWorkRead().then((answer) => {
      setOutcome(answer.read
        ? { state: 'read', atIso: new Date().toISOString(), cause: null }
        : { state: 'failed', atIso: null, cause: answer.error })
      // A read that leaves nothing unreadable takes the card, and the Try again just pressed, off the page: focus goes
      // where the last Dismiss sends it (`onAllDismissed`, the board's heading), never the page body (PR #6210 review).
      // After the frame the new model is drawn in; focus the person moved elsewhere meanwhile stays where it is.
      requestAnimationFrame(() => {
        const focused = document.activeElement
        if (!pressed.isConnected && (focused === null || focused === document.body)) onAllDismissed()
      })
    })
  }
  const outcomeWords = READ_AGAIN_WORDS[outcome.state]?.(t, count) ?? null
  return (
    <Req ids={['R12.1']}>
      <div className="space-y-2">
        {count > 0 && (
          <Alert variant="attention" role="alert" data-read-errors="shown">
            <AlertTitle>{title}</AlertTitle>
            <AlertDescription className="space-y-2 text-foreground/80">
              <p>{count === 1 ? t('Its saved records disagree with each other, so it isn’t shown with your other requests.') : t('Their saved records disagree with each other, so they aren’t shown with your other requests.')}</p>
              <ul className="space-y-2">
                {shown.map((readError) => (
                  <ReadErrorEntry key={readErrorIdentity(readError)} readError={readError}>
                    <Button variant="ghost" size="sm" data-dismiss-read-error="" className="shrink-0"
                      ref={(button) => { if (button) dismissButtons.current.set(readErrorIdentity(readError), button); else dismissButtons.current.delete(readErrorIdentity(readError)) }}
                      onClick={() => dismiss(readError)}>
                      {t('Dismiss')}
                    </Button>
                  </ReadErrorEntry>
                ))}
              </ul>
              {/* What the last Try again did (G17: plain words, then the raw cause under Details). */}
              <div role="status" data-read-again={outcome.state} className="space-y-1 text-sm">
                {outcomeWords && (outcome.state === 'read' && outcome.atIso ? <p>{sentenceWith(outcomeWords, 'time', <LocalTime iso={outcome.atIso} />)}</p> : <p>{outcomeWords}</p>)}
                {outcome.state === 'failed' && outcome.cause && <ErrorDetails cause={outcome.cause} />}
              </div>
            </AlertDescription>
            {/* Beside the words from 640px; under them on a phone, where a column beside them left the words a few
                characters wide. */}
            <AlertAction className="flex-wrap max-sm:col-start-2 max-sm:row-span-1 max-sm:row-start-3 max-sm:self-start max-sm:pt-2">
              <Button variant="outline" size="sm" busy={outcome.state === 'reading'} busyLabel={t('Reading…')} onClick={(event) => readAgain(event.currentTarget)}><RefreshCwIcon />{t('Try again')}</Button>
            </AlertAction>
          </Alert>
        )}
        {folded.length > 0 && (
          <Collapsible open={showDismissed} onOpenChange={setShowDismissed} data-read-errors="dismissed">
            <CollapsibleFoldTrigger count={showDismissed ? t('Hide them') : t('Show them')}>
              <span className="inline-flex min-w-0 items-center gap-2">
                <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-attention-foreground" />
                {interpolate(folded.length === 1 ? t('{count} dismissed request couldn’t be read') : t('{count} dismissed requests couldn’t be read'), { count: folded.length })}
              </span>
            </CollapsibleFoldTrigger>
            <CollapsibleContent className="pt-2">
              <ul className="space-y-2 rounded-xl border border-control-edge/55 px-4 py-3 text-sm">
                {folded.map((readError) => <ReadErrorEntry key={readErrorIdentity(readError)} readError={readError} />)}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </Req>
  )
}
