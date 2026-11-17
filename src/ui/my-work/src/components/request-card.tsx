import { displayTime } from '@/lib/display-time'
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { BookOpenIcon, CheckIcon, MegaphoneIcon, TagIcon, TerminalIcon, Undo2Icon } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Terminal, TerminalContent, TerminalLines } from '@/components/ai-elements/terminal'
import { EncryptedText } from '@/components/aceternity/encrypted-text'
import { GlowingEffect } from '@/components/aceternity/glowing-effect'
import { RunningFor } from '@/components/live-motion'
import { DURATION_WORD } from '@/live/running-time'
import { SaveButton } from '@/components/save-button'
import { BadgeMore } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { deliverableName, isCardDeliverable } from '@/lib/deliverables'
import { PRODUCT_ICON } from '@/lib/product-icons'
import { Req } from '@/spec/req'
import { isSampleHref, needsYou, type LiveState, type Request } from '@/data'
import type { CardSize } from '@/live/card-groups'
import { requestById, useFreshlyUpdated, useStore, useWorkModel, useWorkspace } from '@/store'
import { AgentIcon, FocusAreaChip, NextMove, ProductLink, ProgressMeter, StateBadge, type Translate } from './bits'
import { MediaCountBadge, ObsMediaStrip } from './observation-media/ObsMedia'

/**
 * Decision 5: while a request has only agent data, the card shows the agent's own lines as a terminal, with the
 * activity's word beside its mark. When the title writer finishes, the lines resolve into human text. The sample plays
 * that transform on a timer; a live card plays it when a newer model brings its first title. Reduced motion: nothing
 * moves (each piece checks the preference itself).
 *
 * The fresh title's window, with its "Just updated" mark: 4 s, the window the store gives any changed card its "Just
 * updated" (store/slices/work-slice.ts FRESHLY_UPDATED_FOR_MS), so a card that just got its title reads like any other
 * just-updated card; it holds the title's fade (about 0.66 s) and stays under WCAG 2.2.2's 5 s, past which moving
 * content needs a pause control.
 */
const FRESH_TITLE_FOR_MS = 4000
// The just-written title fades in letter by letter over about half a second (c-aceternity-encrypted-text M: "over
// about half a second", in place of two seconds of symbols).
const DECRYPT_TITLE_IN_MS = 500
// The sample's demo only (no real data): the agent's lines for 5 s, "Writing the human title…" for 3 s, then the fresh
// title for the rest of its window. Each stage stays longer than the 2.4 s the home ticker allows a change to be read
// (bits.tsx SAMPLE_RUN_SHOWN_FOR_MS), so each can be seen and shot (plan Phase 5 checklist: the terminal card, the
// shimmer, the decrypting title).
const SAMPLE_TRANSLATES_AFTER_MS = 5000
const SAMPLE_RESOLVES_AFTER_MS = 8000
const SAMPLE_SETTLES_AFTER_MS = SAMPLE_RESOLVES_AFTER_MS + FRESH_TITLE_FOR_MS
function useAgentViewTransform(request: Request) {
  const [phase, setPhase] = useState<'agent' | 'translating' | 'fresh' | 'human'>(request.title ? 'human' : 'agent')
  const untitled = !request.title && !!request.resolvesTo
  useEffect(() => {
    if (!untitled) return
    const translate = setTimeout(() => setPhase('translating'), SAMPLE_TRANSLATES_AFTER_MS)
    const resolve = setTimeout(() => setPhase('fresh'), SAMPLE_RESOLVES_AFTER_MS)
    const settle = setTimeout(() => setPhase('human'), SAMPLE_SETTLES_AFTER_MS)
    return () => { clearTimeout(translate); clearTimeout(resolve); clearTimeout(settle) }
  }, [untitled])
  // Live: the title went from null to text between two models.
  const titled = !!request.title
  const [wasTitled, setWasTitled] = useState(titled)
  if (titled !== wasTitled) {
    setWasTitled(titled)
    setPhase(titled ? 'fresh' : 'agent')
  }
  useEffect(() => {
    if (phase !== 'fresh' || untitled) return
    const settle = setTimeout(() => setPhase('human'), FRESH_TITLE_FOR_MS)
    return () => clearTimeout(settle)
  }, [phase, untitled])
  const text = request.title ? { title: request.title, summary: request.summary } : phase === 'fresh' || phase === 'human' ? request.resolvesTo! : null
  const word = phase === 'translating' ? 'Translating' : request.activityWord
  return { phase, text, word }
}

/**
 * The activity words the mapper and the sample write (live/to-work-model.ts: Working or Translating; the sample's
 * Editing and Searching), in the reader's language. Any other word is the agent's own and shows as written.
 */
const ACTIVITY_WORDS: Record<string, (t: Translate) => string> = {
  Working: (t) => t('Working'),
  Translating: (t) => t('Translating'),
  Searching: (t) => t('Searching'),
  Editing: (t) => t('Editing'),
}

/**
 * What the agent is doing, in words beside its mark (c-request-card-activity-spinner M): the word always shows, so a
 * phone sees it too (it was a hover tooltip), and "Just updated" is a dot with its words (it was a 6px dot alone). The
 * words are a polite status, so the move from the turning ring to "Just updated" is announced once. It stays a Tab stop
 * (the review's Keep) and is at least 24px tall (it was 21×21). The ring turns only when motion is allowed.
 */
function ActivityMark({ word, settled }: { word: string; settled: boolean }) {
  const { t } = useI18n()
  const { mode } = useWorkspace()
  const words = settled ? t('Just updated') : mode === 'web' && word !== 'Translating' ? t('Working') : ACTIVITY_WORDS[word]?.(t) ?? word
  return (
    <Req ids={['D5']}>
      <span role="status" tabIndex={0} data-activity-mark={settled ? 'settled' : 'working'}
        className="inline-flex min-h-6 items-center gap-1.5 rounded-sm text-xs whitespace-nowrap text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        {settled
          ? <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-shipped-foreground" />
          : <span aria-hidden="true" className="size-3.5 shrink-0 rounded-full border-2 border-working-border border-t-working-foreground motion-safe:animate-spin" />}
        {words}
      </span>
    </Req>
  )
}

type FollowUp = Request['followUps'][number]

/** Each follow-up tag as a small chip with its own mark (c-request-card-open-follow-ups M), sized to its words. */
const FOLLOW_UP_TAG: Record<FollowUp['tag'], { words: (t: Translate) => string; Icon: typeof BookOpenIcon }> = {
  Docs: { words: (t) => t('Docs'), Icon: BookOpenIcon },
  Promo: { words: (t) => t('Promo'), Icon: MegaphoneIcon },
  Other: { words: (t) => t('Other'), Icon: TagIcon },
}

function FollowUpTag({ tag }: { tag: FollowUp['tag'] }) {
  const { t } = useI18n()
  const { words, Icon } = FOLLOW_UP_TAG[tag]
  return (
    <span className="inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-md border border-control-edge px-2 text-xs text-muted-foreground">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {words(t)}
    </span>
  )
}

/**
 * After ship (decision 4): the open Docs, Promo and Other follow-ups, each one actionable. Nothing renders when none
 * are open. The words wrap (c-request-card-open-follow-ups: one cut line). "Done" saves through the store's one path
 * for follow-ups, which is the sample's (`updateSampleRequest`); live work has no follow-up save path, so live rows say
 * so instead of offering a button that cannot save. A row marked done stays in place, struck through, with "Saved"
 * and Undo, until the next data refresh brings this request again: no timer (plan Phase 5). `limit` holds a card to
 * its first rows, and the rest are counted, with `onShowAll` opening them.
 *
 * The pressed button goes away with its row's state (Done becomes Undo, Undo becomes Done), so focus moves to the
 * button that took its place instead of falling to the page, and "Saved" is said once, by the row's own status region,
 * which is there before the save so its change is what a screen reader announces (Q7).
 */
export function OpenFollowUps({ request, limit, onShowAll }: { request: Request; limit?: number; onShowAll?: () => void }) {
  const { t } = useI18n()
  const { sourceKind } = useWorkModel()
  const canSave = sourceKind === 'sample'
  // Rows marked done here, with the version of the request their save produced. A newer version from anywhere else is
  // the next data refresh, and the rows go; this view's own saves carry them forward.
  const [finished, setFinished] = useState<{ text: string; savedIn: Request }[]>([])
  const stillShown = finished.filter((row) => row.savedIn === request)
  if (stillShown.length !== finished.length) setFinished(stillShown)
  // Each row's one button (Done, or Undo once saved), by the follow-up's words, and the row whose button takes focus
  // once the save that swapped it has drawn.
  const actionButtons = useRef(new Map<string, HTMLButtonElement>())
  const focusAfterSave = useRef<string | null>(null)
  useEffect(() => {
    const button = focusAfterSave.current === null ? undefined : actionButtons.current.get(focusAfterSave.current)
    if (!button) return
    focusAfterSave.current = null
    button.focus()
  })
  const actionRef = (text: string) => (button: HTMLButtonElement | null) => {
    if (button) actionButtons.current.set(text, button)
    else actionButtons.current.delete(text)
  }
  const isFinishedHere = (followUp: FollowUp) => stillShown.some((row) => row.text === followUp.text)
  const rows = request.followUps.filter((followUp) => !followUp.done || isFinishedHere(followUp))
  const openCount = rows.filter((followUp) => !followUp.done).length
  if (request.state !== 'shipped' || rows.length === 0) return null
  const shown = rows.slice(0, limit)
  // Every save here goes through the sample's one writer; the version it produced is what the rows remember.
  const saveFollowUps = (change: (followUps: FollowUp[]) => FollowUp[], keep: (rows: { text: string }[]) => { text: string }[]) => {
    useStore.getState().updateSampleRequest(request.id, (current) => {
      const followUps = change(current.followUps)
      // Finishing a follow-up moves the next step on to the next open one, so the card never names finished work.
      const stillOpen = followUps.find((followUp) => !followUp.done)
      return { ...current, followUps, next: stillOpen ? { who: 'human', text: stillOpen.text } : { who: 'bot', text: t('Nothing left after ship') } }
    })
    const savedIn = requestById(request.id)
    if (!savedIn) throw new Error(`Request ${request.id} left the model while its follow-up was saved`)
    setFinished((current) => keep(current).map((row) => ({ text: row.text, savedIn })))
  }
  const markDone = (text: string) => {
    focusAfterSave.current = text
    saveFollowUps(
      (followUps) => followUps.map((followUp) => followUp.text === text ? { ...followUp, done: true } : followUp),
      (current) => [...current, { text }],
    )
  }
  const undo = (text: string) => {
    focusAfterSave.current = text
    saveFollowUps(
      (followUps) => followUps.map((followUp) => followUp.text === text ? { ...followUp, done: false } : followUp),
      (current) => current.filter((row) => row.text !== text),
    )
  }
  return (
    <Req ids={['R5.7']}>
      <div className="space-y-1">
        <p className="section-label">{interpolate(t('Open after ship · {count}'), { count: openCount })}</p>
        <ul className="divide-y divide-border/70">
          {shown.map((followUp) => (
            // Tag, words (they wrap), then the row's status and its one button at the right end.
            <li key={followUp.text} data-follow-up={followUp.done ? 'saved' : 'open'}
              className="grid min-h-11 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-1.5 text-sm">
              <FollowUpTag tag={followUp.tag} />
              <span className={cn('[overflow-wrap:anywhere]', followUp.done && 'text-muted-foreground line-through')}>{followUp.text}</span>
              <span className="flex items-center gap-2">
                <span role="status" className={cn('inline-flex items-center gap-1.5 text-xs text-shipped-foreground', !followUp.done && 'sr-only')}>
                  {followUp.done && <><CheckIcon aria-hidden="true" className="size-3.5" />{t('Saved')}</>}
                </span>
                {followUp.done ? (
                  <SaveButton key="undo" ref={actionRef(followUp.text)} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'shrink-0')} icon={<Undo2Icon />} onClick={() => undo(followUp.text)}>{t('Undo')}</SaveButton>
                ) : canSave && (
                  <SaveButton key="done" ref={actionRef(followUp.text)} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')} icon={<CheckIcon />} onClick={() => markDone(followUp.text)}>{t('Done')}</SaveButton>
                )}
              </span>
            </li>
          ))}
        </ul>
        {rows.length > shown.length && (
          <BadgeMore hiddenCount={rows.length - shown.length} onShowAll={onShowAll}
            aria-label={interpolate(t('Open the request to see {count} more follow-ups'), { count: rows.length - shown.length })} />
        )}
        {!canSave && <p className="text-xs text-muted-foreground">{t('These can’t be marked done from My Work yet.')}</p>}
      </div>
    </Req>
  )
}

/**
 * The card is a portrait tile, so it shows its first three deliverables and counts the rest, which the drawer lists in
 * full (the review's constraint: three chips and "+N more" stay).
 */
const CARD_DELIVERABLES = 3

/**
 * One deliverable chip (c-request-card-deliverables M): its kind as a word and its real name ("PR · claude-mem #6229"),
 * wrapping to two lines inside a width cap, so one long name no longer makes a 324px chip beside 77px ones. 36px on a
 * desktop, 44px on touch (the shared touch rule; the 36px minimum applies only where that rule does not, since a plain
 * min-h utility comes after touch-target-size in the stylesheet and beat its 44px, V4), with the ≥3:1 control edge.
 * Its full words open on hover and keyboard focus (G10), for a name the two lines cut; a tap follows the link, and the
 * drawer's Deliverables list shows every name in full. A fixture link keeps its own "sample" tooltip instead.
 */
function DeliverableChip({ product }: { product: Request['workProduct'][number] }) {
  const { t } = useI18n()
  const Icon = PRODUCT_ICON[product.kind]
  const words = `${t(product.kind)} · ${deliverableName(product)}`
  const chip = (
    <ProductLink href={product.href} data-deliverable-chip=""
      className="relative inline-flex max-w-[16rem] items-center gap-1.5 rounded-lg border border-control-edge bg-card px-2.5 py-1 text-[0.8125rem] leading-snug outline-none touch-target-size hover:bg-surface focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:not-pointer-coarse:min-h-9">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
        <span className="text-muted-foreground">{t(product.kind)} · </span>{deliverableName(product)}
      </span>
    </ProductLink>
  )
  if (product.href !== undefined && isSampleHref(product.href)) return chip
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>{words}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Deliverables, on the front of the card (R5.12): a deck, a report, a page, a PR, each one click away. Bucket copies
 * claude-mem kept are marked as deliverables by the mapper; the drawer keeps the full list with commits and branches.
 * Chips wrap to more lines first; past three, "+N more" counts the rest and opens the drawer (D b3 M71).
 */
export function Deliverables({ request, onOpen }: { request: Request; onOpen: () => void }) {
  const { t } = useI18n()
  const products = request.workProduct.filter(isCardDeliverable)
  const count = request.detailLoaded === false ? request.detailCounts?.workProduct ?? products.length : products.length
  if (count === 0) return null
  const shown = products.slice(0, CARD_DELIVERABLES)
  const hidden = Math.max(0, count - shown.length)
  return (
    <Req ids={['R5.12', 'R5.10']}>
      <div className="space-y-1.5">
        <p className="section-label">{interpolate(t('Deliverables · {count}'), { count })}</p>
        <ul className="flex flex-wrap items-center gap-1.5">
          {shown.map((product, index) => (
            <li key={`${index}-${product.label}`} className="min-w-0 max-w-full"><DeliverableChip product={product} /></li>
          ))}
          {hidden > 0 && (
            // 36px on a desktop like the chips; on touch the Badge primitive's own touch rule makes it 44px (V4, fix
            // round R3). A flex list item, so the item is the badge's height with no line box around it.
            <li className="flex">
              <BadgeMore hiddenCount={hidden} onShowAll={onOpen} className="min-h-9 px-3 text-[0.8125rem]"
                aria-label={interpolate(t('Open the request to see {count} more deliverables'), { count: hidden })} />
            </li>
          )}
        </ul>
      </div>
    </Req>
  )
}

/**
 * A shipped card lists its first three open follow-ups, so it stays near its row's other cards; the rest are counted
 * ("+N more", which opens the drawer that lists every one), never dropped unsaid (plan rule 5).
 */
const CARD_FOLLOW_UPS = 3

/**
 * The always-on mark of a card that needs you is its state's own colour (c-aceternity-glowing-effect): your move's
 * red-pink, done-not-checked's amber. Which cards carry it is needsYou's one rule (data.ts); every state has its colour
 * here, its text colour, so a new state fails the typecheck until it has one.
 */
const STATE_EDGE_COLOR: Record<LiveState, string> = {
  'your-move': 'var(--attention-foreground)',
  'needs-check': 'var(--review-foreground)',
  working: 'var(--working-foreground)',
  idle: 'var(--idle-foreground)',
  shipped: 'var(--shipped-foreground)',
}

/** The card's lines that would be a control themselves: a press there is theirs, not the card's. */
const CARD_CONTROLS = 'a, button, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])'

/**
 * The agent's last lines on an untitled card: two commands and what each printed, as the review's terminal mockup draws
 * them (after/c-ai-terminal.png). The box has no inner scroll; the request's own records are in its drawer.
 */
const TERMINAL_LINES_SHOWN = 4

/**
 * One request as a card. `size` (c-work-cards-view, live/card-groups.ts CARD_SIZE): `full` shows everything; `medium`
 * (a working request on the Cards board) holds the title to two lines and the summary to one and leaves the image strip
 * to the drawer (its count stays on the badge), so cards in a row keep close heights. `actions`: the caller's buttons
 * for this card, at its foot (the board's Reply and Open on a card that needs you, G2).
 *
 * The whole card answers the pointer (D b5 M115, Card `interactive`): the hand cursor, the brighter edge on hover, and a
 * click anywhere that is not one of its own controls opens the request. Its role and its one Tab stop are the title's
 * button, so Enter on it opens the request: the card holds other controls (the area link, chips, buttons), which a
 * card-wide button could not contain. Keyboard focus on the title draws the orange ring around the whole card. The
 * footer (CardFooter) sits on the card's bottom edge, so cards stretched to one row height end level (M116).
 */
export function RequestCard({ request, onOpen, onOpenFocus, size = 'full', actions }: {
  request: Request; onOpen: () => void; onOpenFocus: (focusAreaId: string) => void
  size?: Exclude<CardSize, 'line'>; actions?: ReactNode
}) {
  const medium = size === 'medium'
  const { t } = useI18n()
  const { team } = useWorkspace()
  const { phase, text, word } = useAgentViewTransform(request)
  const fresh = phase === 'fresh'
  const reduceMotion = useReducedMotion()
  // Its recorded content changed in the update just applied (decision 5's "Just updated" dot).
  const contentJustUpdated = useFreshlyUpdated(request.id)
  // Only a card that needs you gets the always-on edge and the brightening near the pointer (R10.2).
  const needsYouEdge = needsYou(request) ? STATE_EDGE_COLOR[request.state] : undefined
  const reviewed = request.progress.readings > 0 || !!request.progress.completedAt
  // The activity mark means an agent is on it. While the sample writes its title, the shimmer line says so with its own
  // ring, so the corner mark steps aside: two moving things at most (plan rule 8).
  const showsActivity = ((phase !== 'human' && phase !== 'translating' && request.state === 'working') || fresh || contentJustUpdated)
  const openFromCard = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest(CARD_CONTROLS) !== null) return
    // A drag that selected words is reading, not opening.
    if (window.getSelection()?.toString()) return
    onOpen()
  }
  return (
    <Req ids={['R1.1', 'R2.1', 'R4.1', 'R3.3', 'R10.2']}>
      <div className="relative h-full rounded-xl">
      {/* The pointer layer's distances are Aceternity's documented example for cards (kept since #5136): spread 40, a
          bright arc of 80° (spread is half of it), so the light sits on the side the pointer is near; proximity 64px,
          so the light comes on as the pointer nears the card, across the board's 17px gap from the card beside it;
          inactiveZone 0.01, so only the very centre stays dark (the vendor default, 0.7, darkened most of a card).
          GlowingEffect also turns its pointer layer off under reduced motion itself. */}
      {needsYouEdge && <GlowingEffect color={needsYouEdge} spread={40} glow proximity={64} inactiveZone={0.01} borderWidth={2} disabled={!!reduceMotion} />}
      <Card interactive tabIndex={-1} onClick={openFromCard} data-request-card={request.state}
        className={cn('h-full gap-3 py-4 transition-[border-color] duration-500 md:py-5',
          // The card's own outline-none (interactive) sets the outline style to none, so the ring names its style too.
          'has-[[data-request-card-open]:focus-visible]:outline-solid has-[[data-request-card-open]:focus-visible]:outline-2 has-[[data-request-card-open]:focus-visible]:outline-offset-2 has-[[data-request-card-open]:focus-visible]:outline-ring',
          contentJustUpdated && 'just-updated border-primary/50')}>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-2 gap-y-1.5 px-4 md:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <AgentIcon agentId={request.agentId} />
            {/* Where it belongs, up front beside who is on it. */}
            <FocusAreaChip focusAreaId={request.focusAreaId} onOpen={onOpenFocus} />
            <Req ids={['R5.2', 'R9.3']}>
              <span className={cn('truncate text-xs text-muted-foreground', !team && 'sr-only')}>{interpolate(t('asked by {askedBy}'), { askedBy: request.askedBy })}</span>
            </Req>
          </div>
          {/* The status never gives way: squeezed, its badge wrapped one word over three lines once the agent's name
              joined the left side (c-bits-agent-icon). With the activity's words beside it, a narrow card moves the
              whole group to its own line at the right instead. The pill is the mockup's 28px (1.75rem). */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5 [&_[data-state-badge]]:min-h-7">
            {/* A status change cross-fades the badge, so the move is seen, not just the result. */}
            <span key={request.state} className="motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-500"><StateBadge state={request.state} /></span>
            {request.media && <MediaCountBadge media={{ version: 1, attachments: request.media.preview }} count={request.media.count} />}
            {showsActivity && <ActivityMark word={word} settled={fresh || contentJustUpdated} />}
          </div>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col gap-3 px-4 md:px-5">
          {text ? (
            <div className="space-y-1">
              <Req ids={['R2.6', 'R10.5']}>
                <h3 className="text-[1.06rem] leading-snug font-semibold tracking-tight">
                  <Button variant="bare" data-request-card-open="" onClick={onOpen} className="focus-visible:border-transparent focus-visible:ring-0">
                    <span className={cn(medium && 'line-clamp-2')}>
                      {fresh && !reduceMotion ? <><span className="sr-only">{text.title}</span><span aria-hidden="true"><EncryptedText text={text.title} revealDelayMs={DECRYPT_TITLE_IN_MS / Math.max(1, Array.from(text.title).length)} /></span></> : text.title}
                    </span>
                  </Button>
                </h3>
              </Req>
              <p className={cn('text-sm text-muted-foreground', medium ? 'line-clamp-1' : 'line-clamp-2')}>{text.summary}</p>
            </div>
          ) : (
            <Req ids={['D5']}>
              <div className="space-y-2">
                {/* What the box is, before the box (c-ai-terminal M): the card's headline is the agent's raw output until a title comes. */}
                <p className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
                  <TerminalIcon aria-hidden="true" className="size-4 shrink-0" />{t('What the agent is doing · title coming')}
                </p>
                <Button variant="bare" data-request-card-open="" onClick={onOpen} aria-label={t('Open this request; its title is still being written')}
                  className="w-full focus-visible:border-transparent focus-visible:ring-0">
                  <Terminal output={request.terminal.join('\n')} className="w-full border-control-edge bg-terminal text-terminal-foreground">
                    <TerminalContent className="max-h-none space-y-1 overflow-visible p-3.5 text-[0.8125rem] leading-relaxed">
                      <TerminalLines lines={request.terminal.slice(-TERMINAL_LINES_SHOWN)} />
                      {phase === 'translating' && <Shimmer as="span" className="text-[0.8125rem] [--color-background:var(--foreground)] [--color-muted-foreground:var(--terminal-foreground)]">{t('Writing the human title…')}</Shimmer>}
                    </TerminalContent>
                  </Terminal>
                </Button>
              </div>
            </Req>
          )}

          {/* What happens next comes straight after what it is: the one line most people read a card for. Shipped
              work's next moves are its open follow-ups, so the card lists those instead of repeating one. */}
          {!(request.state === 'shipped' && request.followUps.some((followUp) => !followUp.done)) && <NextMove next={request.next} />}

          <Deliverables request={request} onOpen={onOpen} />

          {/* The request's images: its first few, with "+N" opening the drawer that holds every one. */}
          {request.media && !medium && <ObsMediaStrip media={{ version: 1, attachments: request.media.preview }} total={request.media.count} title={text?.title ?? t('Untitled request')} onMore={onOpen} />}

          <OpenFollowUps request={request} limit={CARD_FOLLOW_UPS} onShowAll={onOpen} />
        </CardContent>

        <CardFooter className="flex-col items-stretch gap-2.5 border-border/70 bg-transparent px-4 pt-3 pb-4 md:px-5 md:pb-5">
          {/* An empty bar says nothing, so an unreviewed request says so in words instead. */}
          {reviewed ? <ProgressMeter request={request} /> : <Req ids={['R5.9']}><p className="text-xs text-muted-foreground">{t('Not reviewed yet')}</p></Req>}
          {/* Stage and start on the left, the duration at the right end in monospace (c-live-motion-running-for), so
              durations line up from card to card. The last group drops its "·" separator. 13px on a phone, where 12px
              was the smallest text on the card (c-request-card F). */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-muted-foreground md:text-xs">
            <Req ids={['R5.3', 'R5.4', 'R5.5']}>
              <dl className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 [&>div+div]:before:mr-1 [&>div+div]:before:content-['·'] [&>div:last-child]:ml-auto [&>div:last-child]:before:content-none">
                <div className="flex gap-1"><dt className="sr-only">{t('Stage')}</dt><dd className="font-medium text-foreground/85" title={request.stageNote}>{t(request.stage)}</dd></div>
                <div className="flex gap-1"><dt>{t('Started')}</dt><dd><time dateTime={request.startedAtIso} className="tabular">{displayTime(request.startedAt)}</time></dd></div>
                <div className="flex items-center gap-1"><dt>{t(DURATION_WORD[request.state])}</dt><dd><RunningFor request={request} /></dd></div>
              </dl>
            </Req>
          </div>
          {actions && <div data-slot="request-card-actions" className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">{actions}</div>}
        </CardFooter>
      </Card>
      </div>
    </Req>
  )
}
