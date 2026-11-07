// The area header above My Work when a focus area (or Other) is selected: the goal sentence, combined progress of the
// reviewed requests in it, what shipped, the asks nothing is working on yet, the owner's words, and the area menu.
// Rollup, Quotes and WhyItsHere moved here from the retired goals page unchanged.
import { useState, type ReactNode } from 'react'
import { ArrowDownIcon, ArrowUpIcon, CheckIcon, ChevronDownIcon, CircleDashedIcon, MergeIcon, MoreHorizontalIcon, PencilIcon, XIcon } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { EncryptedText } from '@/components/aceternity/encrypted-text'
import { InlineCitationQuote } from '@/components/ai-elements/inline-citation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { plural, timesLabel } from '@/lib/words'
import { Req } from '@/spec/req'
import { type FocusArea, type FocusAsk, type LiveState, type Quote, type Request } from '@/data'
import { useWorkModel } from '@/store'
import { formatPromptDay, formatPromptTime, promptDayKey, shipDayKey } from '@/lib/prompt-time'
import { navWordIn } from '../../../../services/work-view/nav-words.mjs'
import { AreaEditDialog, type AreaEdit, type FocusChanges } from './focus-changes'

const requestTitle = (request: Request) => request.title ?? 'New request, title being written'
const isReviewed = (request: Request) => request.progress.readings > 0

/** Where an area stands, from the requests in it. The dot uses the same state tokens as My Work; the text stays plain. */
type AreaStatus = 'nothing' | 'your-move' | 'moving' | 'asked-again' | 'shipped' | 'stalled'
const AREA_STATUS: Record<AreaStatus, { label: string; dot: string; text: string; meter: string }> = {
  nothing: { label: 'Nothing on it', dot: 'bg-attention-foreground', text: 'text-attention-foreground', meter: '' },
  'your-move': { label: 'Waiting on you', dot: 'bg-attention-foreground', text: 'text-attention-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-attention-foreground/75' },
  moving: { label: 'Moving', dot: 'bg-working-foreground', text: 'text-working-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-working-foreground/75' },
  'asked-again': { label: 'Asked again after ship', dot: 'bg-review-foreground', text: 'text-review-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-review-foreground/75' },
  shipped: { label: 'Shipped', dot: 'bg-shipped-foreground', text: 'text-shipped-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-shipped-foreground/75' },
  stalled: { label: 'Stalled', dot: 'bg-idle-foreground', text: 'text-muted-foreground', meter: '[&_[data-slot=progress-indicator]]:bg-idle-foreground/75' },
}

const lastShip = (requests: Request[]) => requests.map((request) => request.progress.completedAt).filter(Boolean).sort((a, b) => shipDayKey(b!) - shipDayKey(a!))[0]
/** You asked for it again after the latest ship: what shipped didn't cover it. */
const askedAgainAfter = (latestAt: string | null, requests: Request[]) => {
  const shipped = lastShip(requests)
  return shipped && latestAt && promptDayKey(latestAt) > shipDayKey(shipped) ? shipped : null
}

function statusOf(latestAt: string | null, requests: Request[]): AreaStatus {
  if (requests.length === 0) return 'nothing'
  const has = (state: LiveState) => requests.some((request) => request.state === state)
  if (has('your-move')) return 'your-move'
  if (has('working') || has('needs-check')) return 'moving'
  if (requests.every((request) => request.state === 'shipped')) return askedAgainAfter(latestAt, requests) ? 'asked-again' : 'shipped'
  return 'stalled'
}

/**
 * Combined progress of the requests in an area, from memory reviews only (§12).
 * The percentage always says how much of the area it covers, and names what it leaves out.
 */
function Rollup({ status, requests, className }: { status: AreaStatus; requests: Request[]; className?: string }) {
  const reviewed = requests.filter(isReviewed)
  const unreviewed = requests.filter((request) => !isReviewed(request))
  if (requests.length === 0) {
    return <Req ids={['R12.1', 'R5.11']}><p className={cn('text-xs text-muted-foreground', className)}>No requests, so no progress to measure</p></Req>
  }
  const percent = reviewed.length ? Math.round(reviewed.reduce((sum, request) => sum + (request.progress.percent ?? 0), 0) / reviewed.length) : 0
  return (
    <Req ids={['R16.2', 'R5.11', 'R12.1']}>
      <div className={cn('space-y-1', className)}>
        <Progress value={percent} className={cn('h-1.5 bg-muted', AREA_STATUS[status].meter)} aria-label={`${percent}% from ${reviewed.length} of ${requests.length} requests reviewed`} />
        <p className="text-xs text-muted-foreground">
          {reviewed.length ? <><span className="font-medium text-foreground tabular-nums">{percent}%</span> · {reviewed.length} of {plural(requests.length, 'request')} reviewed</> : <>Not reviewed yet · 0 of {plural(requests.length, 'request')}</>}
        </p>
        {unreviewed.length > 0 && reviewed.length > 0 && (
          <p className="truncate text-xs text-muted-foreground">Not counted: {unreviewed.map(requestTitle).join(', ')}</p>
        )}
      </div>
    </Req>
  )
}

/** The owner's words, dated to the minute they typed them. */
export function Quotes({ quotes }: { quotes: Quote[] }) {
  return (
    <Req ids={['R16.2', 'R5.11']}>
      <div className="space-y-2">
        {quotes.map((quote) => (
          <InlineCitationQuote key={quote.at + quote.quote} className="border-border text-foreground/80 not-italic">
            “{quote.quote}” <time className="ml-1 text-xs whitespace-nowrap text-muted-foreground">{formatPromptTime(quote.at)}</time>
          </InlineCitationQuote>
        ))}
      </div>
    </Req>
  )
}

/** Every quote is kept, behind one disclosure, so the requests come first (§3). */
function WhyItsHere({ quotes }: { quotes: Quote[] }) {
  return (
    <Req ids={['R16.2']}>
      <Collapsible>
        <CollapsibleTrigger className="group flex min-h-11 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />Why it’s here · {plural(quotes.length, 'quote')}
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-1 pb-1"><Quotes quotes={quotes} /></CollapsibleContent>
      </Collapsible>
    </Req>
  )
}

/** Asks owner-goals found that no request is linked to: one compact line each, with how often you asked and its
 * quotes on demand. The first few show; the rest are one click away, so the area's requests stay near the top. */
// Three asks keep the header under about a third of a 1000px window with the requests showing below it.
const ASKS_SHOWN_FIRST = 3
function NotStartedAsks({ asks }: { asks: FocusAsk[] }) {
  const [showAll, setShowAll] = useState(false)
  if (asks.length === 0) return null
  const shown = showAll ? asks : asks.slice(0, ASKS_SHOWN_FIRST)
  return (
    <Req ids={['R16.2', 'R6.3', 'R12.2']}>
      <div className="space-y-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">Not started · {asks.length}</h3>
        {/* Dashed and unfilled: asked for, but nothing is working on it yet. The heading names the state once. */}
        <ul className="divide-y divide-dashed rounded-lg border border-dashed">
          {shown.map((ask) => (
            <li key={ask.id} className="px-3 py-2">
              <Collapsible>
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <p className="flex min-w-0 flex-1 basis-64 items-start gap-2 text-sm leading-snug font-medium"><CircleDashedIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{ask.title}</p>
                  <p className="flex items-center gap-1.5 pl-5.5 text-xs text-muted-foreground sm:pl-0">
                    {timesLabel(ask.timesAsked).replace(/^a/, 'A')}, last {formatPromptDay(ask.latestAt)}
                    {ask.quotes.length > 0 && <>
                      <span aria-hidden="true">·</span>
                      <CollapsibleTrigger className="group inline-flex min-h-11 items-center gap-0.5 hover:text-foreground sm:min-h-0">
                        {plural(ask.quotes.length, 'quote')}<ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                      </CollapsibleTrigger>
                    </>}
                  </p>
                </div>
                <CollapsibleContent className="pt-2 pb-1 pl-5.5"><Quotes quotes={ask.quotes} /></CollapsibleContent>
              </Collapsible>
            </li>
          ))}
        </ul>
        {asks.length > ASKS_SHOWN_FIRST && (
          <Button variant="ghost" size="sm" className="-ml-2 h-11 text-xs text-muted-foreground sm:h-8" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show ${asks.length - ASKS_SHOWN_FIRST} more`}
          </Button>
        )}
      </div>
    </Req>
  )
}

/** Rename, Edit goal, Merge into…, Move up / down (the owner's order), and Done or back in focus. */
function AreaMenu({ area, changes, onEdit }: { area: FocusArea; changes: FocusChanges; onEdit: (edit: AreaEdit) => void }) {
  const { focusAreas } = useWorkModel()
  // The owner's order covers kept areas only (the worker refuses anything else), all of them at once, as the rail shows them.
  const order = focusAreas.filter((entry) => entry.status === 'kept' && !entry.mergedInto).map((entry) => entry.id)
  const at = order.indexOf(area.id)
  const swap = (other: number) => { const next = [...order]; [next[at], next[other]] = [next[other], next[at]]; changes.apply({ action: 'reorder', focusAreaIds: next }) }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-11 w-11 shrink-0 sm:h-8 sm:w-8" aria-label={`Change ${area.name}`} disabled={changes.saving}><MoreHorizontalIcon /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onEdit({ kind: 'rename', area })}><PencilIcon />Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onEdit({ kind: 'edit-goal', area })}><PencilIcon />Edit goal</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onEdit({ kind: 'merge', area })}><MergeIcon />Merge into…</DropdownMenuItem>
        {at >= 0 && <>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={at === 0} onSelect={() => swap(at - 1)}><ArrowUpIcon />Move up</DropdownMenuItem>
          <DropdownMenuItem disabled={at === order.length - 1} onSelect={() => swap(at + 1)}><ArrowDownIcon />Move down</DropdownMenuItem>
        </>}
        <DropdownMenuSeparator />
        {area.status === 'done'
          ? <DropdownMenuItem onSelect={() => changes.apply({ action: 'keep', focusAreaId: area.id })}><CheckIcon />Back in focus</DropdownMenuItem>
          : <DropdownMenuItem onSelect={() => changes.apply({ action: 'done', focusAreaId: area.id })}><CheckIcon />Done</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HeaderFrame({ children }: { children: ReactNode }) {
  return <section className="space-y-3 rounded-xl border bg-card p-4 shadow-panel">{children}</section>
}

// Switching areas decrypts the new name from scramble (EncryptedText), as a fresh request title does; ~0.5s whatever
// the name's length, so it lands before the eye moves on to the goal. Reduced motion: the plain name.
const DECRYPT_AREA_NAME_IN_MS = 500
function AreaName({ name }: { name: string }) {
  const reduceMotion = useReducedMotion()
  if (reduceMotion) return <>{name}</>
  return <><span className="sr-only">{name}</span><span aria-hidden="true"><EncryptedText key={name} text={name} revealDelayMs={DECRYPT_AREA_NAME_IN_MS / Math.max(1, name.length)} /></span></>
}

/** One focus area, on top of its requests. `requests` are all of them, closed ones too, as the combined progress counts them. */
export function FocusHeader({ area, requests, changes }: { area: FocusArea; requests: Request[]; changes: FocusChanges }) {
  const [edit, setEdit] = useState<AreaEdit | null>(null)
  const navWord = navWordIn(area.name)
  const status = statusOf(area.latestAt, requests)
  const shipped = requests.filter((request) => request.state === 'shipped').length
  const shippedBefore = askedAgainAfter(area.latestAt, requests)
  return (
    <Req ids={['R16.2', 'R12.3']}>
      <HeaderFrame>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg leading-snug font-semibold tracking-tight"><AreaName name={area.name} /></h2>
              {area.status === 'suggested' && <Badge variant="outline" className="font-normal">Suggested</Badge>}
              {area.status === 'done' && <Badge variant="outline" className="border-shipped-border font-normal text-shipped-foreground">Done</Badge>}
            </div>
            {area.goal ? <p className="text-[0.95rem] leading-snug">{area.goal}</p> : <p className="text-sm text-muted-foreground italic">Write one sentence saying what this area is for (Edit goal).</p>}
            {/* The area's own evidence sits with its goal, so it can't be read as belonging to the asks below. */}
            {area.quotes.length > 0 ? <WhyItsHere quotes={area.quotes} /> : area.evidence && <p className="text-xs text-muted-foreground">Why it’s here: {area.evidence}</p>}
          </div>
          <AreaMenu area={area} changes={changes} onEdit={setEdit} />
        </div>
        {navWord && <p className="text-xs text-attention-foreground">“{area.name}” reuses the page name “{navWord}”. Rename it so each word means one thing.</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <Rollup status={status} requests={requests} />
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className={cn('inline-flex items-center gap-1.5 font-medium', AREA_STATUS[status].text)}><span className={cn('size-1.5 rounded-full', AREA_STATUS[status].dot)} />{AREA_STATUS[status].label}</span>
            <span><span className="font-medium text-foreground tabular-nums">{shipped}</span> shipped</span>
            {area.timesAsked !== null && area.latestAt && <span>{timesLabel(area.timesAsked)}, last {formatPromptDay(area.latestAt)}</span>}
          </p>
        </div>
        {shippedBefore && <p className="text-xs text-review-foreground">You asked again on {formatPromptDay(area.latestAt!)}, after the last ship on {shippedBefore}. What shipped doesn’t cover it yet.</p>}
        <NotStartedAsks asks={area.asks} />
        {area.status === 'suggested' && (
          <Req ids={['R16.4']}>
            <div className="flex flex-wrap gap-2 border-t pt-3">
              <Button size="sm" className="h-11 sm:h-8" disabled={changes.saving} onClick={() => changes.apply({ action: 'keep', focusAreaId: area.id })}><CheckIcon />Keep</Button>
              <Button size="sm" variant="ghost" className="h-11 sm:h-8" disabled={changes.saving} onClick={() => changes.apply({ action: 'dismiss', focusAreaId: area.id })}><XIcon />Dismiss</Button>
            </div>
          </Req>
        )}
        <AreaEditDialog edit={edit} changes={changes} onClose={() => setEdit(null)} />
      </HeaderFrame>
    </Req>
  )
}

/** Other: the permanent bucket for requests that fit no area, and asks the run placed in none. */
export function OtherHeader({ requests }: { requests: Request[] }) {
  const { otherAsks } = useWorkModel()
  const shipped = requests.filter((request) => request.state === 'shipped').length
  return (
    <Req ids={['R16.3', 'R12.3']}>
      <HeaderFrame>
        <div className="space-y-1">
          <h2 className="text-lg leading-snug font-semibold tracking-tight">Other</h2>
          <p className="text-sm text-muted-foreground">Requests that fit none of your focus areas. A refresh suggests a new area when several of these turn out to be steps of something larger.</p>
        </div>
        <Rollup status={statusOf(null, requests)} requests={requests} />
        <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground tabular-nums">{shipped}</span> shipped</p>
        <NotStartedAsks asks={otherAsks} />
      </HeaderFrame>
    </Req>
  )
}
