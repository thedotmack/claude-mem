import { useEffect, useState } from 'react'
import { CheckIcon } from 'lucide-react'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Terminal, TerminalContent } from '@/components/ai-elements/terminal'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { isCardDeliverable } from '@/lib/deliverables'
import { PRODUCT_ICON } from '@/lib/product-icons'
import { Req } from '@/spec/req'
import { requestById, updateRequest, useFreshlyUpdated, type Request } from '@/data'
import { AgentIcon, FocusAreaChip, NextMove, ProductLink, ProgressMeter, StateBadge, useWorkspace } from './bits'

/**
 * Decision 5: while a request has only agent data, the card shows the agent's own lines as a terminal,
 * with a corner spinner whose hover names the activity. When the title writer finishes, the lines
 * resolve into human text. The sample plays that transform on a timer; a live card plays it when a
 * newer model brings its first title. Reduced motion: the animation classes are motion-safe only.
 */
const FRESH_TITLE_FOR_MS = 4000
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
  const { mode } = useWorkspace()
  const label = settled ? 'Just updated' : mode === 'web' && word !== 'Translating' ? 'Working' : word
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
  const open = request.followUps.filter((followUp) => !followUp.done)
  if (request.state !== 'shipped' || open.length === 0) return null
  const inStore = requestById(request.id) !== null
  // Finishing a follow-up moves the next step on to the next open one, so the card never names finished work.
  const finish = (text: string) => updateRequest(request.id, (current) => {
    const followUps = current.followUps.map((followUp) => followUp.text === text ? { ...followUp, done: true } : followUp)
    const stillOpen = followUps.find((followUp) => !followUp.done)
    return { ...current, followUps, next: stillOpen ? { who: 'human', text: stillOpen.text } : { who: 'bot', text: 'Nothing left after ship' } }
  })
  return (
    <Req ids={['R5.7']}>
      <div className="space-y-1">
        <p className="section-label">Open after ship · {open.length}</p>
        <ul className="divide-y divide-border/70">
          {open.slice(0, limit).map((followUp) => (
            <li key={followUp.text} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
              <span className="w-12 shrink-0 text-[11px] font-medium text-muted-foreground uppercase">{followUp.tag}</span>
              <span className="min-w-0 flex-1 truncate">{followUp.text}</span>
              {inStore && <Button variant="ghost" size="sm" className="h-11 shrink-0 text-xs md:h-7" onClick={(event) => { event.stopPropagation(); finish(followUp.text) }}><CheckIcon />Done</Button>}
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
  const products = request.workProduct.filter(isCardDeliverable)
  if (products.length === 0) return null
  const shown = products.slice(0, CARD_DELIVERABLES)
  const hidden = products.length - shown.length
  return (
    <Req ids={['R5.12', 'R5.10']}>
      <div className="space-y-1">
        <p className="section-label">Deliverables · {products.length}</p>
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
              <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onOpen} aria-label={`Open the request to see ${hidden} more deliverables`}>+{hidden} more</Button>
            </li>
          )}
        </ul>
      </div>
    </Req>
  )
}

export function RequestCard({ request, onOpen, onOpenFocus }: { request: Request; onOpen: () => void; onOpenFocus: (focusAreaId: string) => void }) {
  const { team } = useWorkspace()
  const { phase, text, word } = useAgentViewTransform(request)
  const fresh = phase === 'fresh'
  // Its recorded content changed in the update just applied (decision 5's "Just updated" dot).
  const contentJustUpdated = useFreshlyUpdated(request.id)
  return (
    <Req ids={['R1.1', 'R2.1', 'R4.1', 'R3.3', 'R10.2']}>
      <Card className="h-full gap-3 py-4 md:py-5">
        <CardHeader className="flex flex-row items-center justify-between gap-2 px-4 md:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <AgentIcon agentId={request.agentId} />
            <Req ids={['R5.2', 'R9.3']}>
              <span className={cn('truncate text-xs text-muted-foreground', !team && 'sr-only')}>asked by {request.askedBy}</span>
            </Req>
          </div>
          <div className="flex items-center gap-1.5">
            <StateBadge state={request.state} />
            {(phase !== 'human' || fresh || contentJustUpdated) && <ActivitySpinner word={word} settled={fresh || contentJustUpdated} />}
          </div>
        </CardHeader>

        <CardContent className="flex flex-1 flex-col gap-3 px-4 md:px-5">
          {text ? (
            <button type="button" onClick={onOpen} className={cn('-mx-1 space-y-1 rounded-md px-1 text-left focus-visible:outline-2 focus-visible:outline-ring', fresh && 'motion-safe:animate-in motion-safe:fade-in motion-safe:blur-in-sm motion-safe:duration-300')}>
              <Req ids={['R2.6', 'R10.5']}>
                <h3 className="text-[1.06rem] leading-snug font-semibold tracking-tight">{text.title}</h3>
              </Req>
              <p className="line-clamp-2 text-sm text-muted-foreground">{text.summary}</p>
            </button>
          ) : (
            <Req ids={['D5']}>
              <button type="button" onClick={onOpen} className="text-left" aria-label="Open this request; its title is still being written">
                <Terminal output={request.terminal.join('\n')} isStreaming className="border-dashed border-terminal-border bg-terminal text-terminal-foreground">
                  <TerminalContent className="max-h-28 p-3.5 text-[11px] leading-relaxed">
                    <pre className="whitespace-pre-wrap text-terminal-foreground">{request.terminal.slice(-4).join('\n')}</pre>
                    {phase === 'translating' && <Shimmer as="span" className="text-[11px] [--color-background:var(--foreground)] [--color-muted-foreground:var(--terminal-foreground)]">Writing the human title…</Shimmer>}
                  </TerminalContent>
                </Terminal>
              </button>
            </Req>
          )}

          <Deliverables request={request} onOpen={onOpen} />

          {/* Shipped work's next moves are its open follow-ups, so the card lists those instead of repeating one. */}
          {!(request.state === 'shipped' && request.followUps.some((followUp) => !followUp.done)) && <NextMove next={request.next} />}
          <OpenFollowUps request={request} limit={3} />

          <div className="mt-auto space-y-3 border-t border-border/70 pt-3">
            <FocusAreaChip focusAreaId={request.focusAreaId} onOpen={onOpenFocus} />
            <Req ids={['R5.3', 'R5.4', 'R5.5']}>
              <dl className="grid grid-cols-3 gap-2 text-xs">
                <div><dt className="text-muted-foreground">Stage</dt><dd className="mt-0.5 font-medium" title={request.stageNote}>{request.stage}</dd></div>
                <div><dt className="text-muted-foreground">Started</dt><dd className="mt-0.5">{request.startedAt}</dd></div>
                <div><dt className="text-muted-foreground">Running</dt><dd className="mt-0.5">{request.runningFor}</dd></div>
              </dl>
            </Req>
            <ProgressMeter request={request} />
          </div>
        </CardContent>
      </Card>
    </Req>
  )
}
