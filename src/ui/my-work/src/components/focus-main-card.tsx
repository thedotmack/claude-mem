// The focus area page's main card (page-03, decision G2): the first request in the area that needs the owner, as the
// first block under the header, with the request's reply card inside it (components/conversation-continue.tsx
// ConversationReplyCard, as the drawer mounts it), so the area's one decision is where the eye lands. Self-contained, so
// either board layout can mount it (plan rule 12). Also the answer buttons every card that needs you carries (G2).
import { useId, type ReactNode } from 'react'
import { CircleCheckIcon, RefreshCwIcon, ReplyIcon } from 'lucide-react'
import { interpolate, t, useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { AgentIcon, FailureDetails, NextMove, ProgressMeter, RecordedTime, StateBadge } from '@/components/bits'
import { RunningFor } from '@/components/live-motion'
import { ConversationReplyCard, type SendEmphasis } from '@/components/conversation-continue'
import { Deliverables } from '@/components/request-card'
import { DURATION_WORD } from '@/live/running-time'
import { recordedStart } from '@/live/to-work-model'
import { useRequestDetail } from '@/lib/use-request-detail'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { firstNeedingYou, requestTitle, type Request } from '@/data'
import { useStore } from '@/store'

/** Whether this page can continue a conversation: only the page this computer's worker serves (live/work-data-source). */
function useCanReply() {
  return useStore((state) => state.conversationContinuationSource() !== null)
}

/**
 * A request's answer buttons (G2): Reply opens its drawer with the reply box focused, and Open opens the drawer. Where
 * this page cannot continue a conversation (sample data, the cloud page) the one button is "Open request". `primary`
 * makes the first button the screen's one orange button (G1: one primary per decision unit); every other is outlined.
 *
 * That button takes its colours at once (`transition-none`): when a live change brings a newer request that needs you,
 * the orange moves to that request's button, and the previous one's fade from orange to outlined was a third moving
 * thing beside the change ticker's slide and the newest row's riffle (plan rule 8; home in the List, Phase 6 fix 2).
 */
export function ReplyActions({ request, primary, onOpen, onReply }: { request: Request; primary: boolean; onOpen: (request: Request) => void; onReply: (request: Request) => void }) {
  const canReply = useCanReply()
  const variant = primary ? 'default' : 'outline'
  if (!canReply) return <Button variant={variant} className="transition-none" onClick={() => onOpen(request)}>{t('Open request')}</Button>
  return (
    <>
      <Button variant={variant} className="transition-none" onClick={() => onReply(request)}><ReplyIcon aria-hidden="true" />{t('Reply')}</Button>
      <Button variant="link" className="px-1" onClick={() => onOpen(request)}>{t('Open')}</Button>
    </>
  )
}

/**
 * Where the main card is with its request's conversations, which the compact overview leaves out of each request. They
 * come from the one detail read the drawer has too (lib/use-request-detail.ts), so its rule holds here: a newer version
 * of the same request keeps the conversations read before it on screen, and the reply card with what is typed in it,
 * while its own read runs (and if that read fails, the card says so beside them, with Try again). Worked out from that
 * read on every render; nothing else writes it:
 *
 *   reading ──the detail comes back──▶ read ──a newer version──▶ read (the last read stays on screen)
 *   reading ──the read fails──▶ failed ──Try again──▶ reading
 *
 * A request that already carries its detail (sample data, an older worker's full model) is read at once.
 */
type ConversationsRead = 'reading' | 'read' | 'failed'

/** What each state says on the card: nothing once read, a status line while reading, plain words when it failed. */
const CONVERSATIONS_READ_WORDS: Record<ConversationsRead, (() => string) | null> = {
  reading: () => t('Reading this request’s conversations…'),
  read: null,
  failed: () => t('This request’s conversations could not be read here. Reply opens them in the request.'),
}

/** When it started (the reader's clock, with the full stamp on hover, focus and tap) and how long it has run. */
function StartedAndRunning({ request }: { request: Request }) {
  // The card's and the drawer's rule for a start that is not recorded (live/to-work-model.ts recordedStart).
  const started = recordedStart(request.startedAt)
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">{t('Started')}{started ? <RecordedTime iso={request.startedAtIso} words={started} /> : <span>{t('Start not recorded')}</span>}</span>
      <span className="inline-flex items-center gap-1">{t(DURATION_WORD[request.state])}<RunningFor request={request} className="text-xs" /></span>
    </span>
  )
}

/**
 * The request the card leads with: its state and agent, its title (a press opens the drawer), its summary and next
 * step, its deliverables, then its reply card on the page that can continue a conversation, and the facts line with
 * "Open request". The card's one orange button follows the drawer's decision (G1, page-05): your move, the reply card's
 * Send; done and not checked, "Open request", where Mark checked waits. `primary` false leaves every button outlined
 * (the area header holds the screen's one orange: a suggested area's Keep).
 */
function MainRequest({ request, primary, onOpen, onReply }: { request: Request; primary: boolean; onOpen: (request: Request) => void; onReply: (request: Request) => void }) {
  const canReply = useCanReply()
  const detail = useRequestDetail(request, canReply)
  const read: ConversationsRead = detail.loaded ? 'read' : detail.failure ? 'failed' : 'reading'
  const conversations = detail.loaded?.conversations ?? []
  const yourMove = request.state === 'your-move'
  const inlineReply = canReply && read === 'read' && conversations.length > 0
  const sendEmphasis: SendEmphasis = yourMove && primary ? 'primary' : yourMove ? 'once-words-are-typed' : 'outlined'
  const title = requestTitle(request, t)
  const summary = request.summary ?? request.resolvesTo?.summary
  const words = CONVERSATIONS_READ_WORDS[read]
  // With the reply card inline and the reply as the decision, Send is the orange and "Open request" a quiet link.
  const openButton: ReactNode = inlineReply && yourMove
    ? <Button variant="link" className="px-1" onClick={() => onOpen(request)}>{t('Open request')}</Button>
    : inlineReply || !yourMove
      ? <Button variant={primary ? 'default' : 'outline'} onClick={() => onOpen(request)}>{t('Open request')}</Button>
      : <ReplyActions request={request} primary={primary} onOpen={onOpen} onReply={onReply} />
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2"><StateBadge state={request.state} /><AgentIcon agentId={request.agentId} /></div>
      <div className="space-y-1">
        <h3 className="text-[1.06rem] leading-snug font-semibold tracking-tight">
          <Button variant="bare" data-request-opener={request.id} onClick={() => onOpen(request)} className={cn(!request.title && !request.resolvesTo && 'text-muted-foreground')}>{title}</Button>
        </h3>
        {/* Two lines, as on the request's card (request-card.tsx), so the reply card and its Send stay near the top of
            the card; the whole summary is still in the page for a screen reader (the clamp only draws less), and on
            screen in the request's drawer, which the title and Open request open. */}
        {summary && <p className="line-clamp-2 text-sm text-muted-foreground">{summary}</p>}
      </div>
      <NextMove next={request.next} className="text-[0.95rem]" />
      <Deliverables request={request} onOpen={() => onOpen(request)} />
      {inlineReply && <ConversationReplyCard conversations={conversations} sendEmphasis={sendEmphasis} />}
      {canReply && detail.newerVersionReadFailure !== null && (
        <div role="alert" data-main-card-read="newer-version-failed" className="space-y-2">
          <p className="text-sm text-muted-foreground">{t('Could not load the newest version of this request. This is the version read before it.')}</p>
          <FailureDetails cause={detail.newerVersionReadFailure} />
          <Button variant="outline" size="sm" onClick={detail.tryAgain}><RefreshCwIcon />{t('Try again')}</Button>
        </div>
      )}
      {canReply && words && (
        <div data-main-card-read={read} className="space-y-2">
          <p role={read === 'failed' ? 'alert' : 'status'} className="text-sm text-muted-foreground">{words()}</p>
          {read === 'reading' && <Skeleton className="h-24 w-full rounded-lg" />}
          {read === 'failed' && <>
            <FailureDetails cause={detail.failure?.message} />
            <Button variant="outline" size="sm" onClick={detail.tryAgain}><RefreshCwIcon />{t('Try again')}</Button>
          </>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3">
        <ProgressMeter request={request} compact />
        <StartedAndRunning request={request} />
        <span data-slot="request-card-actions" className="ml-auto flex flex-wrap items-center gap-2">{openButton}</span>
      </div>
    </div>
  )
}

/**
 * What leads a focus area's requests (page-03, c-focus-header M1): "One thing needs you" with that request as the main
 * card (it was a sentence under the header and the fourth block down), or "N need you" with the first of them and
 * "Show all N that need you"; the others follow on the board. With nothing that needs you, one quiet line says so
 * (page-04 F: it read as loud as a real alert would). No pointer, highlight or other motion.
 */
export function FocusMainCard({ requests, primary, onOpen, onReply, onShowAll }: {
  /** The area's open requests. */
  requests: Request[]
  /** Whether the card's button is the screen's one orange (G1): not when the area header holds one. */
  primary: boolean
  onOpen: (request: Request) => void; onReply: (request: Request) => void; onShowAll: () => void
}) {
  useI18n()
  const headingId = useId()
  const waiting = firstNeedingYou(requests)
  if (waiting.length === 0) {
    return (
      <p data-main-card="none" className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
        <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0" />{t('Nothing needs you right now.')}
      </p>
    )
  }
  const [first] = waiting
  return (
    <Req ids={['R12.2', 'R12.3', 'R1.1', 'R2.8']}>
      <section data-main-card={first.state} aria-labelledby={headingId} className="space-y-3 rounded-xl border border-control-edge bg-card p-4 shadow-panel md:p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id={headingId} className="flex items-center gap-2 text-xs font-semibold tracking-[0.08em] text-attention-foreground uppercase">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-attention-foreground" />
            {waiting.length === 1 ? t('One thing needs you') : interpolate(t('{count} need you'), { count: waiting.length })}
          </h2>
          {waiting.length > 1 && <Button variant="link" size="sm" className="ml-auto px-1" onClick={onShowAll}>{interpolate(t('Show all {count} that need you'), { count: waiting.length })}</Button>}
        </div>
        {/* Keyed by its request: when the next one takes the card, it gets its own title button (so the drawer's focus
            return never lands on another request's title) and its own reply box. */}
        <MainRequest key={first.id} request={first} primary={primary} onOpen={onOpen} onReply={onReply} />
      </section>
    </Req>
  )
}
