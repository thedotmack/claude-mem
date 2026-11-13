import { displayTime } from '@/lib/display-time'
import { useEffect, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { interpolate, useI18n } from '@/lib/i18n'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Terminal, TerminalContent } from '@/components/ai-elements/terminal'
import { EncryptedText } from '@/components/aceternity/encrypted-text'
import { GlowingEffect } from '@/components/aceternity/glowing-effect'
import { RunningFor } from '@/components/live-motion'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { isDoneState, needsYou, type Request } from '@/data'
import { useFreshlyUpdated, useWorkspace } from '@/store'
import { AgentIcon, NextMove, ProgressMeter, StateBadge } from './bits'
import { Deliverables, OpenFollowUps } from './request-sections'
import { ChatLinks, useRequestChatLinks } from './thread-list'
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
  return { phase, text }
}

/** The agent's own activity word is no longer recorded, so a card at work says Working. */
function ActivitySpinner({ translating, settled }: { translating: boolean; settled: boolean }) {
  const { t } = useI18n()
  const label = t(settled ? 'Just updated' : translating ? 'Translating' : 'Working')
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

/** One request of a focus as a portrait card. It sits inside its focus, so it does not name the focus again. */
export function RequestCard({ request, onOpen }: { request: Request; onOpen: () => void }) {
  const { t } = useI18n()
  const { team } = useWorkspace()
  const { phase, text } = useAgentViewTransform(request)
  // The spinner means an agent is on it: an idle card still waiting on its title (or one whose title writer
  // is unavailable) shows no spinner, only its badge.
  const fresh = phase === 'fresh'
  const reduceMotion = useReducedMotion()
  // Its recorded content changed in the update just applied (decision 5's "Just updated" dot).
  const contentJustUpdated = useFreshlyUpdated(request.id)
  // Only a card that needs you gets the edge glow that follows the pointer, so it reads as "this one" (R10.2).
  const waitingOnYou = needsYou(request)
  const links = useRequestChatLinks(request)
  // The agent's question is the next step while it waits for an answer, as on the thread row.
  const next = { ...request.next, text: t(request.question?.text ?? request.next.text) }
  const reviewed = request.progress.readings > 0 || !!request.progress.completedAt
  return (
    <Req ids={['R1.1', 'R2.1', 'R4.1', 'R3.3', 'R10.2']}>
      <div className="relative h-full rounded-xl">
      {waitingOnYou && <GlowingEffect spread={40} glow proximity={64} inactiveZone={0.01} borderWidth={2} disabled={!!reduceMotion} />}
      <Card className={cn('h-full gap-3 py-4 transition-[border-color] duration-500 md:py-5', contentJustUpdated && 'just-updated border-primary/50')}>
        <CardHeader className="flex flex-row items-center justify-between gap-2 px-4 md:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <AgentIcon agentId={request.agentId} />
            <Req ids={['R5.2', 'R9.3']}>
              <span className={cn('truncate text-xs text-muted-foreground', !team && 'sr-only')}>{interpolate(t('asked by {askedBy}'), { askedBy: request.askedBy })}</span>
            </Req>
          </div>
          <div className="flex items-center gap-1.5">
            {/* A status change cross-fades the badge, so the move is seen, not just the result. */}
            <span key={request.state} className="motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-500"><StateBadge state={request.state} next={request.next} /></span>
            {request.media && <MediaCountBadge media={{ version: 1, attachments: request.media.preview }} count={request.media.count} />}
            {((phase !== 'human' && request.state === 'working') || fresh || contentJustUpdated) && <ActivitySpinner translating={phase === 'translating'} settled={fresh || contentJustUpdated} />}
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
          {!(request.state === 'shipped' && request.followUps.some((followUp) => !followUp.done)) && <NextMove next={next} />}

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
                  <div className="flex gap-1"><dt>{isDoneState(request.state) ? t('Took') : t('Running')}</dt><dd className="tabular-nums"><RunningFor request={request} /></dd></div>
                </dl>
              </Req>
              {links && <span className="-my-2 ml-auto md:-my-1"><ChatLinks chat={links} showTranscript /></span>}
            </div>
          </div>
        </CardContent>
      </Card>
      </div>
    </Req>
  )
}
