import { clockDay, displayTime } from '@/lib/display-time'
// The area header above My Work when a focus area (or Other) is selected (page-03, page-04, c-focus-header): a
// breadcrumb back to the focus overview, then one compact card with the area's picture as a thumbnail, its name, goal
// and "…" menu, the combined progress of the reviewed requests in it, what shipped, and the owner's words and sharing
// folded to one line each. The asks nothing is working on yet (NotStartedAsks) follow the page's main card, which leads
// with what needs the owner (components/focus-main-card.tsx).
import { useId, useState, type ReactNode } from 'react'
import { AlignLeftIcon, ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, CircleIcon, CopyIcon, LightbulbIcon, Link2Icon, MergeIcon, MoreHorizontalIcon, PencilIcon, XIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { InlineCitationQuote } from '@/components/ai-elements/inline-citation'
import { Badge } from '@/components/ui/badge'
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb'
import { Button, buttonVariants } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Progress } from '@/components/ui/progress'
import { FOCUS_FROM_CODE_CLASS_NAME, usePagedRows } from '@/lib/paged-rows'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { requestTitle, type FocusArea, type FocusAsk, type LiveState, type Quote, type Request } from '@/data'
import { useStore, useWorkModel } from '@/store'
import { placeLinkPress, usePageHref } from '@/lib/place-link'
import { myWorkPlace } from '../../../app-places'
import { FocusArtwork } from './focus-artwork'
import { formatPromptDay, formatPromptTime, promptDayKey, shipDayKey } from '@/lib/prompt-time'
import { navWordIn } from '../../../../services/work-view/nav-words.mjs'
import { AreaEditDialog, type AreaEdit, type FocusChanges } from './focus-changes'
import { describeFocusChange } from './focus-change-message'
import { SharedMark, ShareFocusDialog, SharingFold } from './share-focus'
import { FailureDetails } from './bits'
import { ReviewFailedLine } from './review-failed-line'
import { SaveButton } from './save-button'
import { ShowMoreRows } from './request-rows'
import { canShareArea } from '@/live/to-shared-focus'
import { asksToKeepOrDismiss } from '@/live/to-focus-model'

const isReviewed = (request: Request) => request.progress.readings > 0

/** Where an area stands, from the requests in it. The dot uses the same state tokens as My Work; the text stays plain. */
type AreaStatus = 'nothing' | 'your-move' | 'moving' | 'asked-again' | 'shipped' | 'stalled'
/**
 * Each status's words, dot and text colour, and the bar's fill at full strength: ≥3:1 against the muted track in both
 * themes (the Phase 1 contract; the /75 fills were 2.86:1 and 3.00:1 in light).
 */
const AREA_STATUS: Record<AreaStatus, { label: string; dot: string; text: string; meter: string }> = {
  nothing: { label: 'Nothing on it', dot: 'bg-attention-foreground', text: 'text-attention-foreground', meter: '' },
  'your-move': { label: 'Waiting on you', dot: 'bg-attention-foreground', text: 'text-attention-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-attention-foreground' },
  moving: { label: 'Moving', dot: 'bg-working-foreground', text: 'text-working-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-working-foreground' },
  'asked-again': { label: 'Asked again after ship', dot: 'bg-review-foreground', text: 'text-review-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-review-foreground' },
  shipped: { label: 'Shipped', dot: 'bg-shipped-foreground', text: 'text-shipped-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-shipped-foreground' },
  stalled: { label: 'Stalled', dot: 'bg-idle-foreground', text: 'text-muted-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-idle-foreground' },
}

/** The request that shipped last, by its day (the goal stamps it is compared with carry a day and no year). */
const lastShipped = (requests: Request[]) => requests.filter((request) => request.progress.completedAt)
  .sort((a, b) => shipDayKey(b.progress.completedAt!) - shipDayKey(a.progress.completedAt!))[0]
/** You asked for it again after the latest ship: what shipped didn't cover it. The request that shipped, or null. */
const askedAgainAfter = (latestAt: string | null, requests: Request[]) => {
  const shipped = lastShipped(requests)
  return shipped && latestAt && promptDayKey(latestAt) > shipDayKey(shipped.progress.completedAt!) ? shipped : null
}
/** The day a request shipped, in the reader's words: from its instant where the model has one (V3), else as recorded. */
const shipDayWords = (request: Request) => (request.progress.completedAtIso ? clockDay(request.progress.completedAtIso)?.short : null) ?? displayTime(request.progress.completedAt!)

function statusOf(latestAt: string | null, requests: Request[]): AreaStatus {
  if (requests.length === 0) return 'nothing'
  const has = (state: LiveState) => requests.some((request) => request.state === state)
  if (has('your-move')) return 'your-move'
  if (has('working') || has('needs-check')) return 'moving'
  if (requests.every((request) => request.state === 'shipped')) return askedAgainAfter(latestAt, requests) ? 'asked-again' : 'shipped'
  return 'stalled'
}

/**
 * Where this page is (page-03 M: a breadcrumb, built on the shared Breadcrumb): Focus areas, one press back, then this
 * area. Focus areas opens with every area shown; the crumb names it as the bar does (src/ui/app-places.ts).
 */
function FocusBreadcrumb({ current }: { current: string }) {
  const { t } = useI18n()
  const toFocusAreas = () => useStore.getState().goToPage('focus')
  const href = usePageHref('focus')
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href={href} onClick={placeLinkPress(toFocusAreas)}>{t(myWorkPlace('focus').label)}</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem><BreadcrumbPage>{current}</BreadcrumbPage></BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  )
}

/**
 * The requests the area's percent leaves out (c-focus-header-rollup M3, F7; page-04 M: "what it is not counted in"):
 * how many, named in its own row with the percent it is not counted in, and "Show them", which lists each by name as a
 * link to its request (it was a grey list of names with no links).
 */
function NotCounted({ requests, percent, onOpen }: { requests: Request[]; percent: number; onOpen?: (request: Request) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const listId = useId()
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-not-counted="">
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span className="tabular">{interpolate(requests.length === 1 ? t('Not counted in the {percent}%: {count} request with no review yet') : t('Not counted in the {percent}%: {count} requests with no review yet'), { percent, count: requests.length })}</span>
        <CollapsibleTrigger asChild>
          <Button variant="link" size="xs" aria-controls={listId} className="h-auto md:not-pointer-coarse:min-h-6 px-0 text-xs">{open ? t('Hide them') : t('Show them')}</Button>
        </CollapsibleTrigger>
      </p>
      <CollapsibleContent id={listId}>
        <ul className="space-y-0.5 pt-1 text-sm">
          {requests.map((request) => (
            <li key={request.id}>
              {onOpen
                ? <Button variant="link" className="h-auto md:not-pointer-coarse:min-h-6 justify-start px-0 text-left whitespace-normal" onClick={() => onOpen(request)}>{requestTitle(request, t)}</Button>
                : <span>{requestTitle(request, t)}</span>}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Combined progress of the requests in an area, from memory reviews only (§12), on one row (c-focus-header-rollup):
 * the area's status word and dot first, the bar with its visible track, the percent in monospace right after it, then
 * the counts. A plain sentence says what the percent measures (the review read "84%" beside "31 of 31 requests
 * reviewed" as two numbers that disagree), and the requests it leaves out are counted with "Show them". `facts`: the
 * caller's other numbers for the row (what shipped, how often it was asked).
 */
function Rollup({ status, requests, facts, onOpen }: { status: AreaStatus; requests: Request[]; facts?: ReactNode; onOpen?: (request: Request) => void }) {
  const { t } = useI18n()
  const reviewed = requests.filter(isReviewed)
  const unreviewed = requests.filter((request) => !isReviewed(request))
  const statusWord = (
    <span data-area-status={status} className={cn('inline-flex shrink-0 items-center gap-1.5 text-sm font-medium', AREA_STATUS[status].text)}>
      <span aria-hidden="true" className={cn('size-2 rounded-full', AREA_STATUS[status].dot)} />{t(AREA_STATUS[status].label)}
    </span>
  )
  if (requests.length === 0) {
    return (
      <Req ids={['R12.1', 'R5.11']}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{statusWord}<p className="text-xs text-muted-foreground">{t('No requests, so no progress to measure')}</p>{facts}</div>
      </Req>
    )
  }
  const percent = reviewed.length ? Math.round(reviewed.reduce((sum, request) => sum + (request.progress.percent ?? 0), 0) / reviewed.length) : null
  const measures = percent === null ? null : reviewed.length === 1
    ? interpolate(t('{percent}% is the progress of the one reviewed request.'), { percent })
    : interpolate(t('{percent}% is the average progress of the {count} reviewed requests.'), { percent, count: reviewed.length })
  return (
    <Req ids={['R16.2', 'R5.11', 'R12.1']}>
      <div data-rollup="" className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {statusWord}
          {percent !== null && measures !== null && (
            <span className="inline-flex min-w-0 items-center gap-2">
              {/* The bar's name is the sentence below it, so the number beside it is not read twice. A new percent is drawn
                  at once: with the change ticker and the List's riffle, its easing was a third moving thing (rule 8). */}
              <Progress value={percent} aria-label={measures} className={cn('h-1.5 w-36 sm:w-56 [&_[data-slot=progress-indicator]]:transition-none', AREA_STATUS[status].meter)} />
              <span aria-hidden="true" data-rollup-percent="" className="text-sm font-medium mono-number">{percent}%</span>
            </span>
          )}
          <span className="text-xs text-muted-foreground tabular">
            {reviewed.length ? interpolate(t('{reviewed} of {total} requests reviewed'), { reviewed: reviewed.length, total: requests.length }) : interpolate(t('Not reviewed yet · 0 of {count} requests'), { count: requests.length })}
          </span>
          {facts}
        </div>
        {measures && <p className="text-xs text-muted-foreground">{measures}</p>}
        {percent !== null && unreviewed.length > 0 && <NotCounted requests={unreviewed} percent={percent} onOpen={onOpen} />}
      </div>
    </Req>
  )
}

/**
 * The owner's words, each with the minute they typed it (c-focus-header-quotes M2): the quote, then its time in one
 * right-hand column, monospace, on the 12-hour clock (they were 24-hour, in the body face, at uneven places); on a phone
 * the time sits under its quote. Past focus and Suggested areas show quotes the same way.
 */
export function Quotes({ quotes }: { quotes: Quote[] }) {
  return (
    <Req ids={['R16.2', 'R5.11']}>
      <ul data-slot="quotes" className="space-y-2">
        {quotes.map((quote) => (
          <li key={quote.at + quote.quote} className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline">
            <InlineCitationQuote className="border-border text-foreground/80 not-italic">“{quote.quote}”</InlineCitationQuote>
            <time data-slot="quote-time" className="pl-3 text-xs whitespace-nowrap text-muted-foreground mono-number sm:pl-0 sm:text-right">{displayTime(formatPromptTime(quote.at))}</time>
          </li>
        ))}
      </ul>
    </Req>
  )
}

/**
 * The area router's evidence as separate lines (c-focus-header F9): a list of quoted prompts ("'a'; 'b'; 'c'", up to
 * 300 characters on one line) splits at its semicolons, one prompt a line; any other sentence stays whole.
 */
function evidenceLines(evidence: string): string[] {
  const parts = evidence.split(/;\s+/).map((part) => part.trim())
  const quoted = (part: string) => /^['"‘“].*['"’”][.!?]?$/.test(part)
  return parts.length > 1 && parts.every(quoted) ? parts : [evidence.trim()]
}

/**
 * Why the area is here, in one format on every area (c-focus-header F9: a list on one area, a sentence on another, a
 * 300-character line joined by semicolons on a third): the shared fold row (G5, c-focus-header-quotes) whose closed row
 * shows the start of the first entry, so the words are in sight without opening it (§3). Opened: every quote of the
 * owner's with its time, or, for an area with no quotes, the router's evidence, a line each (evidenceLines).
 */
function WhyItsHere({ quotes, evidence }: { quotes: Quote[]; evidence: string | null }) {
  const { t } = useI18n()
  const lines = quotes.length === 0 && evidence ? evidenceLines(evidence) : []
  if (quotes.length === 0 && lines.length === 0) return null
  const count = quotes.length === 0 ? undefined : quotes.length === 1 ? interpolate(t('{count} quote'), { count: '1' }) : interpolate(t('{count} quotes'), { count: quotes.length })
  const preview = quotes.length ? `“${quotes[0].quote}”` : lines[0]
  return (
    <Req ids={['R16.2']}>
      <Collapsible data-why-its-here="">
        <CollapsibleFoldTrigger count={count}>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0">{t('Why it’s here')}</span>
            {/* The preview is the first entry's start; opened, every entry shows whole, so it steps aside. */}
            <span aria-hidden="true" className="min-w-0 truncate font-normal text-muted-foreground group-data-[state=open]/fold-trigger:hidden">{preview}</span>
          </span>
        </CollapsibleFoldTrigger>
        <CollapsibleContent className="space-y-2 px-3 pt-2 pb-1">
          {quotes.length > 0 ? <>
            <Quotes quotes={quotes} />
            <p className="text-xs text-muted-foreground">{t('Your own words, from the prompts you typed.')}</p>
          </> : (
            <ul data-slot="evidence-lines" className="space-y-1.5 text-sm text-foreground/80">
              {lines.map((line, index) => <li key={index} className="border-l-2 border-border pl-3 [overflow-wrap:anywhere]">{line}</li>)}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Req>
  )
}

/**
 * One ask nobody has started, on a 56px row (c-focus-header-not-started-asks M3): its words, how often and when it was
 * asked (the day in monospace), its quotes toggle as part of the row (≥24px; it was 17px tall), and "Copy as prompt",
 * which copies the ask's words to paste into an agent: nothing on this page can start a request, so the row offers the
 * copy instead of a button that would do nothing. A refused copy says so, with the browser's reason under Details.
 */
function NotStartedAsk({ ask }: { ask: FocusAsk }) {
  const { t } = useI18n()
  const titleId = useId()
  const [copyRefused, setCopyRefused] = useState<string | null>(null)
  const times = ask.timesAsked === 1 ? t('asked once') : interpolate(t('asked {times}×'), { times: ask.timesAsked })
  const quoteCount = ask.quotes.length === 1 ? interpolate(t('{count} quote'), { count: '1' }) : interpolate(t('{count} quotes'), { count: ask.quotes.length })
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ask.title)
      setCopyRefused(null)
      return true
    } catch (error) {
      // The browser refused the clipboard (no permission, or an insecure page): the line says what to do instead.
      setCopyRefused(error instanceof Error ? error.message : String(error))
      return false
    }
  }
  return (
    <li data-list-row="" data-not-started-ask={ask.id}>
      <Collapsible>
        <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2">
          <CircleIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 basis-56">
            <p id={titleId} className="text-sm leading-snug font-medium">{ask.title}</p>
            <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span>{times}</span><span aria-hidden="true">·</span><span className="mono-number">{displayTime(formatPromptDay(ask.latestAt))}</span>
              {ask.quotes.length > 0 && <>
                <span aria-hidden="true">·</span>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="xs" data-ask-quotes="" className="group/quotes -mx-1.5 px-1.5 font-normal text-muted-foreground">
                    {quoteCount}<ChevronDownIcon aria-hidden="true" className="motion-safe:transition-transform group-data-[state=open]/quotes:rotate-180" />
                  </Button>
                </CollapsibleTrigger>
              </>}
            </p>
          </div>
          <SaveButton className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')} icon={<CopyIcon />} aria-describedby={titleId}
            // The row's line under it says a refused copy, as an alert, so the button says nothing then: heard once (V6).
            savingLabel={t('Copying…')} savedLabel={t('Copied')} notSavedLabel={null} onClick={copy}>{t('Copy as prompt')}</SaveButton>
        </div>
        {copyRefused !== null && (
          <div className="px-4 pb-2 pl-11 text-xs text-muted-foreground">
            <p role="alert">{t('Could not copy. Select the ask to copy it.')}</p>
            <FailureDetails cause={copyRefused} />
          </div>
        )}
        <CollapsibleContent className="px-4 pb-3 pl-11"><Quotes quotes={ask.quotes} /></CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/**
 * Asks owner-goals found that no request is linked to (c-focus-header-not-started-asks), after the page's main card
 * (page-03's order): one fold row with its count (G5), open from the start, over a solid card that says what the list
 * is (the dashed, hollow look read as "disabled") with one 56px row each. Every ask shows (page-04 M: it showed three
 * and "Show 1 more"); a list past one page draws 50 rows at a time (G4) with "Show 50 more · N left".
 */
export function NotStartedAsks({ asks }: { asks: FocusAsk[] }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(true)
  const paged = usePagedRows(asks.length, true)
  if (asks.length === 0) return null
  const count = asks.length === 1 ? interpolate(t('{count} ask'), { count: '1' }) : interpolate(t('{count} asks'), { count: asks.length })
  return (
    <Req ids={['R16.2', 'R6.3', 'R12.2']}>
      <Collapsible open={open} onOpenChange={setOpen} data-not-started-asks="">
        <h2><CollapsibleFoldTrigger count={count}>{t('Not started')}</CollapsibleFoldTrigger></h2>
        <CollapsibleContent className="pt-2">
          <div className="rounded-xl border border-control-edge/55 bg-card shadow-panel">
            <p className="px-4 pt-3 pb-1 text-sm text-muted-foreground">{t('You asked for these. No request covers them yet.')}</p>
            <ul id={paged.listId} className="divide-y divide-border/70">
              {asks.slice(0, paged.shown).map((ask) => <NotStartedAsk key={ask.id} ask={ask} />)}
            </ul>
            <div className="px-2 pb-1"><ShowMoreRows left={paged.left} onShowMore={paged.showMore} /></div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Req>
  )
}

/**
 * Rename, Edit goal, Move up / down (the owner's saved order), Merge into…, Share…, then Mark done on its own, last
 * (c-focus-header-area-menu): rows under small labels, Move up and Move down saying where the area sits in the saved
 * order ("2 of 23", which the board's needs-you-first pinning does not change), Rename and Edit goal with their own
 * marks, and Mark done with a line saying where the area goes and, where the change bar can undo it (the Undo the bar
 * offers, focus-change-message.ts), that it can be undone right after. Done, Move up and Move down save at once; the
 * change bar above the page then shows the change with its Undo.
 */
function AreaMenu({ area, changes, onEdit, onShare }: { area: FocusArea; changes: FocusChanges; onEdit: (edit: AreaEdit) => void; onShare: () => void }) {
  const { t } = useI18n()
  const { focusAreas, requests } = useWorkModel()
  // The owner's order covers kept areas only (the worker refuses anything else), all of them at once, as the focus area board shows them.
  const order = focusAreas.filter((entry) => entry.status === 'kept' && !entry.mergedInto).map((entry) => entry.id)
  const at = order.indexOf(area.id)
  const swap = (other: number) => { const next = [...order]; [next[at], next[other]] = [next[other], next[at]]; changes.apply({ action: 'reorder', focusAreaIds: next }) }
  const position = at >= 0 ? <span className="mono-number">{interpolate(t('{position} of {count}'), { position: at + 1, count: order.length })}</span> : null
  // The change bar's Undo for Mark done, worked out the way the bar works it out: only then does the line promise it.
  const undoable = area.status !== 'done' && describeFocusChange({ action: 'done', focusAreaId: area.id }, focusAreas, requests).undo !== null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* 44px or more with a visible edge (c-focus-header M5, c-focus-header-area-menu F4: 34px, 1:1 until hovered). */}
        <Button variant="outline" size="icon" className="shrink-0" aria-label={interpolate(t('Change {name}'), { name: area.name })} aria-disabled={changes.saving || undefined}><MoreHorizontalIcon /></Button>
      </DropdownMenuTrigger>
      {/* 44px rows on every pointer (page-03's area decision), the size the menu primitive offers for it. */}
      <DropdownMenuContent align="end" rowSize="lg" className="min-w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('Name and goal')}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onEdit({ kind: 'rename', area })}><PencilIcon />{t('Rename')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onEdit({ kind: 'edit-goal', area })}><AlignLeftIcon />{t('Edit goal')}</DropdownMenuItem>
        </DropdownMenuGroup>
        {at >= 0 && <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('Order')}</DropdownMenuLabel>
            <DropdownMenuItem disabled={at === 0} hint={position} onSelect={() => swap(at - 1)}><ArrowUpIcon />{t('Move up')}</DropdownMenuItem>
            <DropdownMenuItem disabled={at === order.length - 1} hint={position} onSelect={() => swap(at + 1)}><ArrowDownIcon />{t('Move down')}</DropdownMenuItem>
          </DropdownMenuGroup>
        </>}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('Organise')}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => onEdit({ kind: 'merge', area })}><MergeIcon />{t('Merge into…')}</DropdownMenuItem>
          {canShareArea(area) && <DropdownMenuItem onSelect={onShare}><Link2Icon />{t('Share…')}</DropdownMenuItem>}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('Finish')}</DropdownMenuLabel>
          {area.status === 'done'
            ? <DropdownMenuItem onSelect={() => changes.apply({ action: 'keep', focusAreaId: area.id })}><CheckIcon />{t('Back in focus')}</DropdownMenuItem>
            : (
              <DropdownMenuItem data-mark-done="" className="items-start" onSelect={() => changes.apply({ action: 'done', focusAreaId: area.id })}>
                <CheckIcon className="mt-0.5" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{t('Mark done')}</span>
                  <span className="text-xs text-muted-foreground">{undoable ? t('Moves it to Past focus. You can undo this right after.') : t('Moves it to Past focus.')}</span>
                </span>
              </DropdownMenuItem>
            )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HeaderFrame({ children }: { children: ReactNode }) {
  return <section data-focus-header="" className="space-y-3 rounded-xl border border-control-edge/55 bg-card p-4 shadow-panel md:p-5">{children}</section>
}

/**
 * The area's name: one text node (c-focus-header F8: each letter was its own element while it scrambled in), the view's
 * heading, which takes focus from code when the request drawer closes and the row that opened it is gone.
 */
function AreaHeading({ children }: { children: ReactNode }) {
  return <h2 tabIndex={-1} data-view-heading="" className={cn('rounded-sm text-lg leading-snug font-semibold tracking-tight', FOCUS_FROM_CODE_CLASS_NAME)}>{children}</h2>
}

/**
 * One focus area, on top of its requests. `requests` are all of them, closed ones too, as the combined progress counts
 * them. `onOpen` opens a request named in the header (the requests its percent leaves out).
 */
export function FocusHeader({ area, requests, changes, onOpen }: { area: FocusArea; requests: Request[]; changes: FocusChanges; onOpen?: (request: Request) => void }) {
  const { t } = useI18n()
  const [edit, setEdit] = useState<AreaEdit | null>(null)
  const [sharing, setSharing] = useState(false)
  const artwork = useStore((state) => state.view.focusArtwork)
  const navWord = navWordIn(area.name)
  const status = statusOf(area.latestAt, requests)
  const shipped = requests.filter((request) => request.state === 'shipped').length
  const shippedBefore = askedAgainAfter(area.latestAt, requests)
  const shareable = canShareArea(area)
  return (
    <Req ids={['R16.2', 'R12.3']}>
      <div className="space-y-2">
        <FocusBreadcrumb current={area.name} />
        <HeaderFrame>
          {/* The picture is a thumbnail (c-focus-header M2): the board's Artwork choice, Compact by default (store). */}
          <div className={`focus-header-intro artwork-${artwork}`}>
            {artwork !== 'off' && <FocusArtwork area={area} priority />}
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <AreaHeading>{area.name}</AreaHeading>
                  {area.status === 'suggested' && <Badge variant="outline" className="font-normal">{t('Suggested')}</Badge>}
                  {area.status === 'done' && <Badge variant="outline" className="border-shipped-border font-normal text-shipped-foreground">{t('Done')}</Badge>}
                  <SharedMark focusAreaId={area.id} onOpen={() => setSharing(true)} />
                </div>
                {area.goal ? <p className="text-[0.95rem] leading-snug">{area.goal}</p> : <p className="text-sm text-muted-foreground italic">{t('Write one sentence saying what this area is for (Edit goal).')}</p>}
              </div>
              <AreaMenu area={area} changes={changes} onEdit={setEdit} onShare={() => setSharing(true)} />
            </div>
          </div>
          {/* The failure line, under the area's name and goal as under any page's title (design pass Phase 4). */}
          <ReviewFailedLine />
          {navWord && <p className="text-xs text-attention-foreground">{interpolate(t('“{name}” reuses the page name “{navWord}”. Rename it so each word means one thing.'), { name: area.name, navWord })}</p>}
          <Rollup status={status} requests={requests} onOpen={onOpen} facts={<>
            <span className="text-xs text-muted-foreground tabular">{interpolate(t('{count} shipped'), { count: shipped })}</span>
            {area.timesAsked !== null && area.latestAt && <span className="text-xs text-muted-foreground tabular">{interpolate(t('{times}, last {date}'), { times: area.timesAsked === 1 ? t('asked once') : interpolate(t('asked {times}×'), { times: area.timesAsked }), date: displayTime(formatPromptDay(area.latestAt)) })}</span>}
          </>} />
          {shippedBefore && <p className="text-xs text-review-foreground">{interpolate(t('You asked again on {latestAt}, after the last ship on {shippedBefore}. What shipped doesn’t cover it yet.'), { latestAt: displayTime(formatPromptDay(area.latestAt!)), shippedBefore: shipDayWords(shippedBefore) })}</p>}
          {/* The owner's words and sharing, folded to one line each with their count (c-focus-header M4). */}
          {(area.quotes.length > 0 || area.evidence || shareable) && (
            <div className="space-y-2">
              <WhyItsHere quotes={area.quotes} evidence={area.evidence} />
              {shareable && <SharingFold focusAreaId={area.id} onOpenSharing={() => setSharing(true)} />}
            </div>
          )}
          {asksToKeepOrDismiss(area) && (
            <Req ids={['R16.4']}>
              <div className="flex flex-wrap gap-2 border-t pt-3">
                <Button size="sm" aria-disabled={changes.saving || undefined} onClick={() => changes.apply({ action: 'keep', focusAreaId: area.id })}><CheckIcon />{t('Keep')}</Button>
                <Button size="sm" variant="ghost" aria-disabled={changes.saving || undefined} onClick={() => changes.apply({ action: 'dismiss', focusAreaId: area.id })}><XIcon />{t('Dismiss')}</Button>
              </div>
            </Req>
          )}
          <AreaEditDialog edit={edit} changes={changes} onClose={() => setEdit(null)} />
          {shareable && <ShareFocusDialog area={area} open={sharing} onOpenChange={setSharing} />}
        </HeaderFrame>
      </div>
    </Req>
  )
}

/**
 * Where Other's requests may lead (page-04 M: the "suggests a new area" sentence becomes a one-line notice): a refresh
 * suggests an area when several of them belong together, with a link to the suggested areas waiting for a decision.
 */
function SuggestedAreasNotice() {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  const suggested = focusAreas.filter((area) => area.status === 'suggested' && !area.mergedInto).length
  const toSuggested = () => useStore.getState().goToPage('suggested')
  const href = usePageHref('suggested')
  return (
    <p data-suggested-notice="" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-control-edge/55 bg-surface/60 px-3 py-2 text-sm">
      <LightbulbIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 basis-64">{t('A refresh suggests a new area when several of these belong together.')}</span>
      <a href={href} onClick={placeLinkPress(toSuggested)}
        className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'h-auto md:not-pointer-coarse:min-h-6 px-0')}>
        {suggested === 0 ? t('See suggested areas') : suggested === 1 ? t('See 1 suggested area') : interpolate(t('See {count} suggested areas'), { count: suggested })}
      </a>
    </p>
  )
}

/**
 * Other: the permanent bucket for requests that fit no area (page-04): one short line saying what it holds (≤75
 * characters; it ran the card's width), its progress with the requests the percent leaves out, and the notice that a
 * refresh may suggest an area for them. Its asks (the run placed them in no area) follow the page's main card.
 */
export function OtherHeader({ requests, onOpen }: { requests: Request[]; onOpen?: (request: Request) => void }) {
  const { t } = useI18n()
  const shipped = requests.filter((request) => request.state === 'shipped').length
  return (
    <Req ids={['R16.3', 'R12.3']}>
      <div className="space-y-2">
        <FocusBreadcrumb current={t('Other')} />
        <HeaderFrame>
          <div className="space-y-1">
            <AreaHeading>{t('Other')}</AreaHeading>
            <p className="text-sm text-muted-foreground">{t('Requests that fit none of your focus areas.')}</p>
          </div>
          <ReviewFailedLine />
          <Rollup status={statusOf(null, requests)} requests={requests} onOpen={onOpen} facts={<span className="text-xs text-muted-foreground tabular">{interpolate(t('{count} shipped'), { count: shipped })}</span>} />
          <SuggestedAreasNotice />
        </HeaderFrame>
      </div>
    </Req>
  )
}
