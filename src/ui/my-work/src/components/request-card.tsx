import { displayTime } from '@/lib/display-time'
import { useEffect, useState } from 'react'
import { CheckIcon } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Terminal, TerminalContent } from '@/components/ai-elements/terminal'
import { EncryptedText } from '@/components/aceternity/encrypted-text'
import { GlowingEffect } from '@/components/aceternity/glowing-effect'
import { RunningFor } from '@/components/live-motion'
import { SaveButton } from '@/components/save-button'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isCardDeliverable } from '@/lib/deliverables'
import { PRODUCT_ICON } from '@/lib/product-icons'
import { Req } from '@/spec/req'
import { WAITING_FOR_LABEL, type Request } from '@/data'
import { requestById, useFreshlyUpdated, useStore, useWorkspace } from '@/store'
import { AgentIcon, FocusAreaChip, NextMove, ProductLink, ProgressMeter, StateBadge } from './bits'
import { MediaCountBadge, ObsMediaStrip } from './observation-media/ObsMedia'

/**
 * Decision 5: while a request has only agent data, the card shows the agent's own lines as a terminal,
 * with a corner spinner whose hover names the activity. When the title writer finishes, the lines
 * resolve into human text. The sample plays that transform on a timer; a live card plays it when a
 * newer model brings its first title. Reduced motion: the animation classes are motion-safe only.
 */
const FRESH_TITLE_FOR_MS = 4000
// While fresh, the title decrypts from scramble into its text (EncryptedText), paced to finish in the first
// half of the fresh window so it settles before the card turns back to plain text.
const DECRYPT_TITLE_IN_MS = FRESH_TITLE_FOR_MS / 2
function useAgentViewTransform(request: Request) {
  const [phase, setPhase] = useState<'agent' | 'translating' | 'fresh' | 'human'>(request.title ? 'human' : 'agent')
  const untitled = !request.title && !!request.resolvesTo
  useEffect(() => {
    if (!untitled) return
    const translate = setTimeout(() => setPhase('translating'), 5000)
    const resolve = setTimeout(() => setPhase('fresh'), 8000)
    const settle = setTimeout(() => setPhase('human'), 12000)
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

function ActivitySpinner({ word, settled }: { word: string; settled: boolean }) {
  const { t } = useI18n()
  const { mode } = useWorkspace()
  const label = settled ? t('Just updated') : mode === 'web' && word !== 'Translating' ? t('Working') : word === 'Translating' ? t('Translating') : word
  return (
    <Req ids={['D5']}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} aria-label={label} className="flex size-5 items-center justify-center">
            {settled
              ? <span className="size-1.5 rounded-full bg-shipped-foreground" />
              : <span className="size-3.5 rounded-full border-2 border-working-border border-t-working-foreground motion-safe:animate-spin" />}
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </Req>
  )
}

/** After ship (decision 4): the open Docs, Promo and Other follow-ups, each one actionable. Nothing renders when none are open. */
export function OpenFollowUps({ request, limit }: { request: Request; limit?: number }) {
  const { t } = useI18n()
  const open = request.followUps.filter((followUp) => !followUp.done)
  if (request.state !== 'shipped' || open.length === 0) return null
  const inStore = requestById(request.id) !== null
  // Finishing a follow-up moves the next step on to the next open one, so the card never names finished work.
  const finish = (text: string) => useStore.getState().updateSampleRequest(request.id, (current) => {
    const followUps = current.followUps.map((followUp) => followUp.text === text ? { ...followUp, done: true } : followUp)
    const stillOpen = followUps.find((followUp) => !followUp.done)
    return { ...current, followUps, next: stillOpen ? { who: 'human', text: stillOpen.text } : { who: 'bot', text: t('Nothing left after ship') } }
  })
  return (
    <Req ids={['R5.7']}>
      <div className="space-y-1">
        <p className="section-label">{interpolate(t('Open after ship · {count}'), { count: open.length })}</p>
        <ul className="divide-y divide-border/70">
          {open.slice(0, limit).map((followUp) => (
            <li key={followUp.text} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
              <span className="w-12 shrink-0 text-[11px] font-medium text-muted-foreground uppercase">{followUp.tag}</span>
              <span className="min-w-0 flex-1 truncate">{followUp.text}</span>
              {inStore && <SaveButton className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'h-11 shrink-0 text-xs md:h-7')} onClick={() => finish(followUp.text)}><CheckIcon />{t('Done')}</SaveButton>}
            </li>
          ))}
        </ul>
      </div>
    </Req>
  )
}

/** The card is a portrait tile: three chips fill one row at phone width, so any more open the drawer's full list. */
const CARD_DELIVERABLES = 3

/**
 * Deliverables, on the front of the card (R5.12): a deck, a
 * report, a page, a PR, each one click away. Bucket copies claude-mem kept are
 * marked as deliverables by the mapper; the drawer keeps the full list with
 * commits and branches.
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
      <div className="space-y-1">
        <p className="section-label">{interpolate(t('Deliverables · {count}'), { count })}</p>
        <ul className="flex flex-wrap gap-1.5">
          {shown.map((product, index) => {
            const Icon = PRODUCT_ICON[product.kind]
            return (
              <li key={`${index}-${product.label}`} className="min-w-0 max-w-full">
                <ProductLink href={product.href} className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs hover:bg-surface">
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{product.label}</span>
                </ProductLink>
              </li>
            )
          })}
          {hidden > 0 && (
            <li>
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onOpen} aria-label={interpolate(t('Open the request to see {count} more deliverables'), { count: hidden })}>{interpolate(t('+{count} more'), { count: hidden })}</Button>
            </li>
          )}
        </ul>
      </div>
    </Req>
  )
}

export function RequestCard({ request, onOpen, onOpenFocus }: { request: Request; onOpen: () => void; onOpenFocus: (focusAreaId: string) => void }) {
  const { t } = useI18n()
  const { team } = useWorkspace()
  const { phase, text, word } = useAgentViewTransform(request)
  // The spinner means an agent is on it: an idle card still waiting on its title (or one whose title writer
  // is unavailable) shows no spinner, only its badge.
  const fresh = phase === 'fresh'
  const reduceMotion = useReducedMotion()
  // Its recorded content changed in the update just applied (decision 5's "Just updated" dot).
  const contentJustUpdated = useFreshlyUpdated(request.id)
  // Only a card that needs you gets the edge glow that follows the pointer, so it reads as "this one" (R10.2).
  const waitingOnYou = request.state === 'your-move' || request.state === 'needs-check'
  const reviewed = request.progress.readings > 0 || !!request.progress.completedAt
  return (
    <Req ids={['R1.1', 'R2.1', 'R4.1', 'R3.3', 'R10.2']}>
      <div className="relative h-full rounded-xl">
      {waitingOnYou && <GlowingEffect spread={40} glow proximity={64} inactiveZone={0.01} borderWidth={2} disabled={!!reduceMotion} />}
      <Card className={cn('h-full gap-3 py-4 transition-[border-color] duration-500 md:py-5', contentJustUpdated && 'just-updated border-primary/50')}>
        <CardHeader className="flex flex-row items-center justify-between gap-2 px-4 md:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <AgentIcon agentId={request.agentId} />
            {/* Where it belongs, up front beside who is on it. */}
            <FocusAreaChip focusAreaId={request.focusAreaId} onOpen={onOpenFocus} />
            <Req ids={['R5.2', 'R9.3']}>
              <span className={cn('truncate text-xs text-muted-foreground', !team && 'sr-only')}>{interpolate(t('asked by {askedBy}'), { askedBy: request.askedBy })}</span>
            </Req>
          </div>
          <div className="flex items-center gap-1.5">
            {/* A status change cross-fades the badge, so the move is seen, not just the result. */}
            <span key={request.state} className="motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-500"><StateBadge state={request.state} /></span>
            {request.media && <MediaCountBadge media={{ version: 1, attachments: request.media.preview }} count={request.media.count} />}
            {((phase !== 'human' && request.state === 'working') || fresh || contentJustUpdated) && <ActivitySpinner word={word} settled={fresh || contentJustUpdated} />}
          </div>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col gap-3 px-4 md:px-5">
          {text ? (
            <button type="button" onClick={onOpen} className={cn('-mx-1 space-y-1 rounded-md px-1 text-left focus-visible:outline-2 focus-visible:outline-ring', fresh && 'motion-safe:animate-in motion-safe:fade-in motion-safe:blur-in-sm motion-safe:duration-300')}>
              <Req ids={['R2.6', 'R10.5']}>
                <h3 className="text-[1.06rem] leading-snug font-semibold tracking-tight">
                  {fresh && !reduceMotion ? <><span className="sr-only">{text.title}</span><span aria-hidden="true"><EncryptedText text={text.title} revealDelayMs={DECRYPT_TITLE_IN_MS / Math.max(1, text.title.length)} /></span></> : text.title}
                </h3>
              </Req>
              <p className="line-clamp-2 text-sm text-muted-foreground">{text.summary}</p>
            </button>
          ) : (
            <Req ids={['D5']}>
              <button type="button" onClick={onOpen} className="text-left" aria-label={t('Open this request; its title is still being written')}>
                <Terminal output={request.terminal.join('\n')} isStreaming className="border-dashed border-terminal-border bg-terminal text-terminal-foreground">
                  <TerminalContent className="max-h-28 p-3.5 text-[11px] leading-relaxed">
                    <pre className="whitespace-pre-wrap text-terminal-foreground">{request.terminal.slice(-4).join('\n')}</pre>
                    {phase === 'translating' && <Shimmer as="span" className="text-[11px] [--color-background:var(--foreground)] [--color-muted-foreground:var(--terminal-foreground)]">{t('Writing the human title…')}</Shimmer>}
                  </TerminalContent>
                </Terminal>
              </button>
            </Req>
          )}

          {/* What happens next comes straight after what it is: the one line most people read a card for. Shipped
              work's next moves are its open follow-ups, so the card lists those instead of repeating one. */}
          {!(request.state === 'shipped' && request.followUps.some((followUp) => !followUp.done)) && <NextMove next={request.next} />}

          <Deliverables request={request} onOpen={onOpen} />

          {/* The request's images: its first few, with "+N" opening the drawer that holds every one. */}
          {request.media && <ObsMediaStrip media={{ version: 1, attachments: request.media.preview }} total={request.media.count} title={text?.title ?? 'Untitled request'} onMore={onOpen} />}

          <OpenFollowUps request={request} limit={3} />

          <div className="mt-auto space-y-2.5 border-t border-border/70 pt-3">
            {/* An empty bar says nothing, so an unreviewed request says so in words instead. */}
            {reviewed ? <ProgressMeter request={request} /> : <Req ids={['R5.9']}><p className="text-xs text-muted-foreground">{t('Not reviewed yet')}</p></Req>}
            {/* Stage, start and running time on one quiet line instead of a three-column grid. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <Req ids={['R5.3', 'R5.4', 'R5.5']}>
                <dl className="flex flex-wrap items-center gap-x-2 gap-y-0.5 [&>div+div]:before:mr-1 [&>div+div]:before:content-['·']">
                  <div className="flex gap-1"><dt className="sr-only">{t('Stage')}</dt><dd className="font-medium text-foreground/85" title={request.stageNote}>{t(request.stage)}</dd></div>
                  <div className="flex gap-1"><dt>{t('Started')}</dt><dd><time dateTime={request.startedAtIso}>{displayTime(request.startedAt)}</time></dd></div>
                  <div className="flex gap-1"><dt>{request.state === 'shipped' ? t('Took') : t('Running')}</dt><dd className="tabular-nums"><RunningFor request={request} /></dd></div>
                </dl>
              </Req>
              <WaitingForLabel request={request} />
            </div>
          </div>
                </CardContent>
      </Card>
      </div>
    </Req>
  )
}

/** What the agent said its latest finished turn waits for (R5.13). Its own word, not a status: shipped work owes nothing more. */
export function WaitingForLabel({ request }: { request: Request }) {
  const { t } = useI18n()
  const label = request.waitingFor && request.state !== 'shipped' ? WAITING_FOR_LABEL[request.waitingFor] : null
  return label ? <Req ids={['R5.13']}><span>{t(label)}</span></Req> : null
}
