// My Work as a plain list of threads: one row per request, hairline dividers, no card chrome. Each row says what
// was asked, how risky it is, what happens next and who that waits on, and lets a person make their move from the row.
import { useEffect, useRef, useState } from 'react'
import { ObsMediaStrip } from './observation-media/ObsMedia'
import { CheckIcon, ChevronRightIcon, GripVerticalIcon, MessageSquareIcon, SendIcon, TerminalIcon } from 'lucide-react'
import { Reorder, useDragControls } from 'motion/react'
import { interpolate, useI18n } from '@/lib/i18n'
import { SaveButton } from '@/components/save-button'
import { Button, buttonVariants } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { Req } from '@/spec/req'
import { isSampleHref, OTHER_FOCUS_AREA_ID, SAMPLE_PEOPLE, type FocusArea, type Request, type RequestStage } from '@/data'
import { STATE_DOT, STATE_SURFACE } from './bits'
import { SplitFlapText } from './split-flap'
import { riskDot, riskLabel } from '@/live/risk'
import { NEED_LABEL, statusCounts, statusLabel, statusTone, type CountBucket } from '@/live/status-label'
import { agentById, useFreshlyUpdated, useStore, useWorkModel, useWorkspace } from '@/store'
import { SOLO_REQUESTER } from '@/live/work-view-overview'
import { NEXT_STEP_NOT_RECORDED, NO_WORK_YET, UNRECORDED_AGENT } from '@/live/to-work-model'
import { chatLinks, requestChat, type ChatLinks as ChatLinkSet } from '@/live/chat-links'
import { focusSections, gripKeyMove, isOrderable, mergeInitiatives, moveOwner, moveToInitiative, placeInOrder, sortThreads, threadAction, threadGroups, type FocusArrangement, type FocusSection, type ThreadAction, type ThreadGroup } from '@/live/thread-groups'
import { InitiativeHeading, InitiativeMenu, type HeadingCarry, type InitiativeChoice } from './initiative-controls'
import { MoveToFocus } from './move-to-focus'
import { ThreadBoard } from './thread-board'
import { RequestCards } from './request-cards'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FOCUS_THREAD_VIEWS, type FocusThreadView } from '@/store/store-types'
import { useCheckSave, useSuggestionSave } from './use-request-saves'
import { useFocusChanges, type FocusChanges } from './focus-changes'
import { byFocusPriority } from '@/live/to-focus-model'
import { MAX_ANSWER_CHARS, type AnswerRunState } from '../../../../services/work-view/owner-runs.mjs'
import { FocusNotes } from './focus-notes'
import { FocusIconMenu, FocusIconProblem, useFocusIconControl } from './focus-icon'
import { PlanButton, PlanProposals } from './focus-plan'
import { STAGE_STATE, useStageGenerate } from './request-stages'
import { StageReader } from './stage-reader'
import { ProductLink } from './bits'
import { Spinner } from '@/components/ui/spinner'
import { answerDelivery, backgroundFor, type KeptBackground } from '@/live/answer-line'
import { stageCell } from '@/live/stage-reader'
import { requestDetailKey } from '@/live/request-detail-state'
import { ageSentence, requestAge } from '@/live/request-age'
import { useNow } from '@/lib/use-now'
import { displayTime } from '@/lib/display-time'

const DOT_FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/** A dot that says what it stands for: on hover, on keyboard focus, and by name to a screen reader. */
function LabelledDot({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <Req ids={['R19.22']}>
      <Tooltip>
        <TooltipTrigger asChild><span role="img" tabIndex={0} aria-label={label} className={cn('rounded-sm', DOT_FOCUS, className)}>{children}</span></TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </Req>
  )
}

/** How risky the request is, as the dot that leads its row or board card. Its status is said in words beside it. */
export function RiskDot({ request }: { request: Pick<Request, 'risk'> }) {
  const { t } = useI18n()
  return (
    <Req ids={['R19.5']}>
      <LabelledDot label={riskLabel(request.risk, t)} className="mt-[0.4rem] size-2 shrink-0"><span className={cn('block size-2 rounded-full', riskDot(request.risk))} /></LabelledDot>
    </Req>
  )
}

/**
 * Where the request stands, on the split-flap tiles the List had: the status in the one table's words, in its state's
 * colours. What a person owes is on a second line ("Needs you" over "review"), so the column stays narrow.
 */
function StatusFlap({ request }: { request: Pick<Request, 'state' | 'next'> }) {
  const { t } = useI18n()
  return (
    <Req ids={['R4.4', 'R19.22']}>
      <span className="col-start-2 flex min-w-0 flex-col items-start gap-0.5 lg:col-start-auto">
        {statusLabel(request, t).split(' · ').map((line) => <SplitFlapText key={line} text={line} tileClassName={STATE_SURFACE[statusTone(request)]} />)}
      </span>
    </Req>
  )
}

/** The focus line's dot for each count. Done is one quiet dot for everything that rests. */
const COUNT_DOT: Record<CountBucket, string> = {
  'your-move': STATE_DOT['your-move'], 'needs-check': STATE_DOT['needs-check'], working: STATE_DOT.working, idle: STATE_DOT.idle,
  done: 'bg-shipped-foreground/50',
}

/** Who the next step waits on: a person and what it needs from them, or the agent that has it. */
function WaitingOn({ request }: { request: Request }) {
  const { t } = useI18n()
  const { team } = useWorkspace()
  const { sourceKind } = useWorkModel()
  // An agent nobody recorded has no name worth a label.
  if (request.next.who === 'bot') return request.agentId === UNRECORDED_AGENT.id ? null : <span className="text-muted-foreground">{agentById(request.agentId).name}</span>
  // The sample has no signed-in person, so its first person stands in for the reader.
  const reader = sourceKind === 'sample' ? SAMPLE_PEOPLE[0] : SOLO_REQUESTER
  const who = moveOwner(request, { team, name: reader }) ?? t('You')
  return <span className="font-semibold text-attention-foreground">{interpolate(t('{who} · {need}'), { who, need: t(NEED_LABEL[request.next.need]) })}</span>
}

/**
 * How long ago the request was asked, in a few quiet characters ("5m", "3h", "2w"). Hover or keyboard focus says it
 * in words with the date and time. `now` comes from the page's one clock, so every age on screen moves together.
 */
export function AskedAge({ request, now, className }: { request: Pick<Request, 'startedAt' | 'startedAtIso'>; now: number; className?: string }) {
  const { t } = useI18n()
  const age = requestAge(request.startedAtIso, now)
  if (!age) return null
  const said = interpolate(t(ageSentence(age)), { count: age.count })
  return (
    <Req ids={['R19.24']}>
      <Tooltip>
        <TooltipTrigger asChild><time dateTime={request.startedAtIso} tabIndex={0} aria-label={said} className={cn('shrink-0 rounded-sm text-xs text-muted-foreground/80 tabular-nums', DOT_FOCUS, className)}>{age.unit === 'now' ? t('now') : age.short}</time></TooltipTrigger>
        <TooltipContent>{`${said} · ${displayTime(request.startedAt)}`}</TooltipContent>
      </Tooltip>
    </Req>
  )
}

const CONTROL = 'h-11 shrink-0 md:h-7'
/** One grid for the column names and every row, so request, status, next step and why line up down the page and wrap inside their own column. The columns need a wide window; below it a row stacks, status under the title. */
const ROW = 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1.5 px-4 lg:grid-cols-[auto_minmax(0,4fr)_8.5rem_minmax(0,4fr)_minmax(0,2fr)_minmax(0,3fr)_13rem] lg:gap-x-4 lg:px-6'

/** A chat link. A sample has no transcript behind it, so it says so instead of opening a blank page (as ProductLink does). */
function ChatAnchor({ href, label, className, children }: { href: string; label?: string; className?: string; children: React.ReactNode }) {
  const { t } = useI18n()
  if (!isSampleHref(href)) return <a href={href} {...(href.startsWith('/') ? { target: '_blank', rel: 'noreferrer' } : {})} aria-label={label} title={label} className={className}>{children}</a>
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0} role="link" aria-disabled="true" aria-label={label} className={cn('cursor-help', className)}>{children}</span></TooltipTrigger>
      <TooltipContent>{t('Sample link. The real page attaches when the agent records it.')}</TooltipContent>
    </Tooltip>
  )
}

type CopyState = 'idle' | 'copied' | 'failed'
const COPY_SHOWN_FOR_MS = 2000

/** Copies the command that reopens the session in its tool, and says so. */
export function CopyResumeCommand({ command }: { command: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<CopyState>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const reset = setTimeout(() => setState('idle'), COPY_SHOWN_FOR_MS)
    return () => clearTimeout(reset)
  }, [state])
  const copy = () => navigator.clipboard.writeText(command).then(() => setState('copied'), () => setState('failed'))
  const label = interpolate(t('Copy the command that resumes this chat: {command}'), { command })
  return (
    <Button variant="ghost" size="sm" className={cn(CONTROL, 'min-w-11 px-2 text-xs text-muted-foreground md:min-w-7')} onClick={copy} aria-label={label} title={label}>
      {state === 'copied' ? <CheckIcon /> : <TerminalIcon />}
      <span role="status">{state === 'copied' ? t('Copied') : state === 'failed' ? t('Couldn’t copy') : ''}</span>
    </Button>
  )
}

/** The request's conversation, opened in its own tool where that tool has a link, else as the recorded transcript. */
export function ChatLinks({ chat, showTranscript }: { chat: ChatLinkSet; showTranscript: boolean }) {
  const { t } = useI18n()
  const href = chat.openHref ?? chat.transcriptHref
  const label = interpolate(t(chat.openHref ? 'Open in {tool}' : 'Open the recorded chat ({tool})'), { tool: chat.tool })
  return (
    <Req ids={['R19.2']}>
      <span className="inline-flex items-center">
        {showTranscript && href !== undefined && (
          <ChatAnchor href={href} label={label} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), CONTROL, 'min-w-11 px-2 text-muted-foreground md:min-w-7')}><MessageSquareIcon /></ChatAnchor>
        )}
      </span>
    </Req>
  )
}

/**
 * Stage: what there is to look at for this review, said as it is. A ready stage is named by its format and opens in
 * the reader. One being made says so; a failed one says why and can be made again. With no stage the cell offers to
 * make the default one (one click, one run) beside the review's own deliverable, when it has one. Nothing is named
 * that does not exist.
 */
function StageCell({ request, onOpen }: { request: Request; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const { stageFormats = [], autoStageFormat } = useWorkModel()
  const run = useStageGenerate(request)
  const [reading, setReading] = useState<string | null>(null)
  // A run started from this row is followed through the request's detail, since the row's own record says only which stages are ready.
  const [started, setStarted] = useState<string | null>(null)
  const [followed, setFollowed] = useState<RequestStage[] | null>(null)
  const revision = requestDetailKey(request)
  useEffect(() => {
    if (!started || request.stages) return
    let current = true
    void useStore.getState().loadRequestDetail(request).then((detail) => { if (current) setFollowed(detail.stages ?? []) }, () => {})
    return () => { current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, revision])
  const beingMade: RequestStage | null = started && !followed?.some((stage) => stage.formatId === started) ? { formatId: started, state: 'generating', startedAt: '', generatedAt: null, reviewedThrough: null, error: null, trigger: 'owner', outdated: false } : null
  const stages = request.stages ?? (started ? [...(followed ?? []), ...(beingMade ? [beingMade] : [])] : undefined)
  const { stage, product } = stageCell({ ...request, stages }, stageFormats, autoStageFormat)
  const generate = async (formatId: string) => { setFollowed(null); if (await run.generate(formatId)) setStarted(formatId) }
  const LINK = 'block max-w-full truncate rounded-sm text-left text-sm underline decoration-border underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring'
  const generateButton = stage && (stage.kind === 'none' || stage.kind === 'failed') && (
    <Button variant="ghost" size="sm" className={cn(CONTROL, '-ml-2 px-2 text-xs text-muted-foreground')} disabled={run.starting !== null} onClick={() => void generate(stage.formatId)}>
      {interpolate(t('Generate {format}'), { format: t(stage.label).toLocaleLowerCase() })}
    </Button>
  )
  return (
    <Req ids={['R19.7']}>
      <div className="col-start-2 min-w-0 space-y-1 lg:col-start-auto">
        {stage?.kind === 'ready' && <button type="button" onClick={() => setReading(stage.formatId)} className={LINK}>{t(stage.label)}</button>}
        {stage?.kind === 'making' && <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner className="size-3.5" />{t(STAGE_STATE.generating)}</p>}
        {stage?.kind === 'failed' && <p role="status" className="text-xs text-attention-foreground">{t(STAGE_STATE.failed)}{stage.error ? `: ${stage.error}` : ''}</p>}
        {product && (product.href !== undefined ? <ProductLink href={product.href} className={LINK}>{product.label}</ProductLink> : <button type="button" onClick={() => onOpen(request)} className={LINK}>{product.label}</button>)}
        {generateButton}
        {run.refusal && <p role="alert" className="text-xs text-attention-foreground">{run.refusal}</p>}
        {request.media && <ObsMediaStrip media={{ version: 1, attachments: request.media.preview.slice(0, 2) }} total={request.media.count} title={request.title ?? t('Untitled request')} onMore={() => onOpen(request)} />}
        <StageReader request={request} formatId={reading} onClose={() => setReading(null)} />
      </div>
    </Req>
  )
}

const ANSWER_STATE: Record<AnswerRunState, string> = { answering: 'Sending…', delivered: 'Delivered', failed: 'Not delivered' }

function CopyText({ text }: { text: string }) {
  const { t } = useI18n()
  const [state, setState] = useState<CopyState>('idle')
  const copy = () => navigator.clipboard.writeText(text).then(() => setState('copied'), () => setState('failed'))
  return <Button variant="outline" size="sm" className={CONTROL} onClick={() => void copy()}><span role="status">{t(state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy')}</span></Button>
}

/**
 * How the last answer's delivery went, on the row and on the request page. It is its own line, not part of the answer
 * box: the box goes once the tool takes the answer, and the tool can still fail after that. A failed delivery keeps
 * the answer this page sent, to copy, beside the chat it was meant for.
 */
export function AnswerDeliveryLine({ request, className }: { request: Request; className?: string }) {
  const { t } = useI18n()
  const sentText = useStore((state) => state.work.sentAnswers[request.id])
  const links = useRequestChatLinks(request)
  const delivery = answerDelivery(request, sentText)
  if (!delivery) return null
  const failed = delivery.state === 'failed'
  const href = links?.openHref ?? links?.transcriptHref
  return (
    <Req ids={['R19.12']}>
      <div className={cn('space-y-1.5', className)}>
        <p role="status" className={cn('flex items-start gap-1.5 text-xs text-muted-foreground', failed && 'text-attention-foreground')}>
          {delivery.state === 'answering' && <Spinner className="mt-px size-3.5 shrink-0" />}
          <span><span className="font-medium">{t('Your answer')}</span> · {t(ANSWER_STATE[delivery.state])}{failed && delivery.error ? `: ${delivery.error}` : ''}</span>
        </p>
        {failed && (
          <>
            {delivery.text && <blockquote className="max-w-2xl border-l-2 pl-3 text-sm whitespace-pre-wrap text-muted-foreground">{delivery.text}</blockquote>}
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {delivery.text && <CopyText text={delivery.text} />}
              {href !== undefined && <ChatAnchor href={href} className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-foreground md:min-h-7">{t('Open chat')}</ChatAnchor>}
              {t('Nothing is sent again by itself.')}
            </p>
          </>
        )}
      </div>
    </Req>
  )
}

/**
 * Answer the agent from the row: Send hands the answer to the request's own session, and the row says how that went
 * on the line under it (AnswerDeliveryLine). A session the worker cannot send to refuses; the answer is then copied,
 * to paste into the chat.
 */
function AnswerLine({ request, chatHref }: { request: Request; chatHref: string | undefined }) {
  const { t } = useI18n()
  const [answer, setAnswer] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<{ text: string; openChat?: true } | null>(null)
  // Kept for the question it was read for; a live update that asks another starts over (live/answer-line.ts).
  const [kept, setKept] = useState<KeptBackground | null>(null)
  const background = backgroundFor(kept, request)
  const run = request.answer
  const send = async () => {
    const text = answer.trim()
    if (!text) { setNotice({ text: t('Write an answer first.') }); return }
    setSending(true)
    setNotice(null)
    try {
      const started = await useStore.getState().answerRequest(request.id, text)
      if (started.outcome !== 'refused') { setAnswer(''); return }
      const copied = await navigator.clipboard.writeText(text).then(() => true, () => false)
      setNotice({ text: `${started.reason} ${t(copied ? 'Answer copied. Paste it into the chat.' : 'Couldn’t copy your answer. Copy it, then open the chat.')}`, openChat: true })
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : String(error) })
    } finally { setSending(false) }
  }
  // Offered only when something was gathered for the question: on the row itself, or waiting in its detail.
  const hasBackground = !!(background.items ? background.items.length : request.question?.hasBackground)
  const showBackground = async () => {
    if (background.open) { setKept({ ...background, open: false }); return }
    if (background.items || request.detailLoaded !== false) { setKept({ ...background, open: true }); return }
    // The answer belongs to the question the read was started for, whatever the row asks by the time it lands.
    const { version } = background
    try {
      const detail = await useStore.getState().loadRequestDetail(request)
      setKept({ version, open: true, items: detail.question?.background ?? [] })
    } catch (error) {
      setKept({ version, open: true, items: [], error: error instanceof Error ? error.message : String(error) })
    }
  }
  return (
    <Req ids={['R19.8']}>
      <div className="col-start-2 space-y-1.5 lg:col-span-6">
        <form className="flex max-w-2xl items-center gap-2" onSubmit={(event) => { event.preventDefault(); void send() }}>
          <input value={answer} onChange={(event) => { setAnswer(event.target.value); setNotice(null) }} aria-label={t('Your answer')} placeholder={t('Your answer')} maxLength={MAX_ANSWER_CHARS}
            className="h-11 min-w-0 flex-1 rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-8" />
          <Button type="submit" variant="outline" size="sm" className={CONTROL} disabled={sending || run?.state === 'answering'}><SendIcon />{t('Send')}</Button>
          {hasBackground && <Button type="button" variant="ghost" size="sm" className={cn(CONTROL, 'text-muted-foreground')} aria-expanded={background.open} onClick={() => void showBackground()}>{t('What you may need')}</Button>}
        </form>
        {notice && (
          <p role="status" className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            {notice.text}
            {notice.openChat && chatHref !== undefined && <ChatAnchor href={chatHref} className="underline underline-offset-4 hover:text-foreground">{t('Open chat')}</ChatAnchor>}
          </p>
        )}
        {background.open && (background.error ? <p role="alert" className="text-xs text-muted-foreground">{background.error}</p>
          : !!background.items?.length && <ul className="max-w-2xl list-disc space-y-0.5 pl-5 text-sm text-foreground/85">{background.items.map((item, index) => <li key={index}>{item.text}</li>)}</ul>)}
      </div>
    </Req>
  )
}

/** The links to a request's chat. A sample session exists nowhere, so its link says so and opens nothing. */
export function useRequestChatLinks(request: Parameters<typeof requestChat>[0]): ChatLinkSet | undefined {
  const sample = useWorkModel().sourceKind === 'sample'
  const chat = requestChat(request)
  return chat && (sample ? { ...chatLinks(chat), openHref: '#' } : chatLinks(chat))
}

/** A row's quiet control: there when the row is pointed at or holds the keyboard, and always on a touch screen. */
const QUIET_ON_ROW = 'opacity-0 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100'

/** `unfiled`: the row is under Other or not sorted yet, where filing it is the one useful thing to do, so Move to focus always shows. */
function ThreadRow({ request, unfiled, now, onOpen }: { request: Request; unfiled: boolean; now: number; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const fresh = useFreshlyUpdated(request.id)
  const check = useCheckSave(request)
  const suggestion = useSuggestionSave(request.suggestion)
  const notice = check.notice ?? suggestion.notice
  const action = threadAction(request)
  const links = useRequestChatLinks(request)
  const href = links?.openHref ?? links?.transcriptHref
  const answering = request.next.who === 'human' && request.next.need === 'answer'
  const reviewing = request.next.who === 'human' && request.next.need === 'review'
  const controls: Record<ThreadAction, React.ReactNode> = {
    none: null,
    'mark-checked': <SaveButton className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), CONTROL)} onClick={() => check.save(true)} disabled={check.saving}><CheckIcon />{t('Mark checked')}</SaveButton>,
    'open-request': <Button variant="outline" size="sm" className={CONTROL} onClick={() => onOpen(request)}>{t('Open request')}</Button>,
    'answer-suggestion': (
      <>
        <SaveButton className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), CONTROL)} onClick={() => suggestion.save('join')} disabled={suggestion.saving} title={request.suggestion && interpolate(t('Join “{title}”'), { title: request.suggestion.requestTitle })}>{t('Join')}</SaveButton>
        <SaveButton className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), CONTROL)} onClick={() => suggestion.save('not-this')} disabled={suggestion.saving}>{t('Not this')}</SaveButton>
      </>
    ),
    // An answer is given on the line below; an approval with nothing to save here is said in the chat.
    'open-chat': !answering && href !== undefined && (
      <ChatAnchor href={href} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), CONTROL)}><MessageSquareIcon />{t('Open chat')}</ChatAnchor>
    ),
  }
  // A checked or closed thread has no next step and waits on nobody: its cell says only when it was checked.
  const resting = request.state === 'checked' || request.state === 'closed'
  const next = request.question?.text ?? request.next.text
  const nextRecorded = next !== NEXT_STEP_NOT_RECORDED && next !== NO_WORK_YET
  return (
    <Req ids={['R19.1']}>
      <li className={cn(ROW, 'group/row items-start py-3 transition-colors hover:bg-surface', fresh && 'just-updated')}>
        <RiskDot request={request} />
        <Req ids={['R2.6', 'R10.5']}>
          <button type="button" onClick={() => onOpen(request)} className={cn('min-w-0 rounded-sm text-left text-[0.95rem] leading-snug font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring lg:text-sm', !request.title && 'text-muted-foreground')}>
            {request.title ?? request.resolvesTo?.title ?? t('New request, title being written')}
          </button>
        </Req>
        <StatusFlap request={request} />
        <Req ids={['R19.3', 'R5.8', 'R9.3']}>
          {resting
            ? <p className="col-start-2 min-w-0 text-sm leading-snug text-muted-foreground/70 lg:col-start-auto">{request.state === 'checked' && request.checkedAt ? interpolate(t('Checked {checkedAt}.'), { checkedAt: request.checkedAt }) : ''}</p>
            : <p className={cn('col-start-2 min-w-0 text-sm leading-snug lg:col-start-auto', !request.question && 'lg:line-clamp-2')} title={next}><WaitingOn request={request} /> <span className={nextRecorded ? 'text-foreground/85' : 'text-muted-foreground/70'}>{t(next)}</span></p>}
        </Req>
        <Req ids={['R19.6']}>
          <p className="col-start-2 min-w-0 text-sm leading-snug text-muted-foreground lg:col-start-auto lg:line-clamp-2" title={request.why}>{request.why}</p>
        </Req>
        {reviewing ? <StageCell request={request} onOpen={onOpen} /> : <span className="hidden lg:block" />}
        <span className="col-start-2 inline-flex items-center gap-1 lg:col-start-auto lg:justify-end">
          <Req ids={['R19.4', 'R6.3']}>{controls[action]}</Req>
          {links && <ChatLinks chat={links} showTranscript={action !== 'open-chat' || answering} />}
          {/* Last before the move control, whose place is always kept, so the ages line up down the list. */}
          <AskedAge request={request} now={now} className="w-8 text-right" />
          <MoveToFocus request={request} variant="row" className={unfiled ? undefined : QUIET_ON_ROW} />
        </span>
        {answering && <AnswerLine request={request} chatHref={href} />}
        <AnswerDeliveryLine request={request} className="col-start-2 lg:col-span-6" />
        {notice && <p role="status" className={cn('col-start-2 text-xs lg:col-span-6', notice.tone === 'problem' ? 'font-medium text-foreground' : 'text-muted-foreground')}>{t(notice.message)}</p>}
      </li>
    </Req>
  )
}

function Rows({ requests, unfiled = false, onOpen }: { requests: Request[]; unfiled?: boolean; onOpen: (request: Request) => void }) {
  const now = useNow()
  return <ul className="divide-y divide-border/80">{requests.map((request) => <ThreadRow key={request.id} request={request} unfiled={unfiled} now={now} onOpen={onOpen} />)}</ul>
}

const FOCUS_THREAD_VIEW: Record<FocusThreadView, string> = { threads: 'Threads', board: 'Board', cards: 'Cards' }

/** Rows, columns or cards for one focus's threads. One choice for every focus, remembered per viewer. */
export function FocusThreadViewSwitch({ className }: { className?: string }) {
  const { t } = useI18n()
  const view = useStore((state) => state.view.focusThreadView)
  return (
    <Req ids={['R19.10']}>
      <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={view} onValueChange={(next) => next && useStore.getState().setFocusThreadView(next as FocusThreadView)} aria-label={t('View')} className={className}>
        {FOCUS_THREAD_VIEWS.map((value) => <ToggleGroupItem key={value} value={value} className="h-11 px-3 text-xs md:h-7">{t(FOCUS_THREAD_VIEW[value])}</ToggleGroupItem>)}
      </ToggleGroup>
    </Req>
  )
}

/**
 * One focus's threads the way the viewer chose: `rows` as the list or as cards, or `requests` (what the focus line
 * counts, Done included) as the board, whose Done column is folded unless `showDone`.
 */
export function FocusThreads({ requests, rows, unfiled = false, showDone, onOpen }: { requests: Request[]; rows: Request[]; unfiled?: boolean; showDone: boolean; onOpen: (request: Request) => void }) {
  const { t } = useI18n()
  const view = useStore((state) => state.view.focusThreadView)
  const shown = view === 'board' ? requests : rows
  if (shown.length === 0) return <p className="px-2 text-sm text-muted-foreground">{t('Nothing here')}</p>
  const views: Record<FocusThreadView, () => React.ReactNode> = {
    // The List's look: one bordered panel, a header line of column names, hairlines between rows.
    threads: () => <div className="mx-2 overflow-hidden rounded-xl border bg-card shadow-panel"><ColumnNames /><Rows requests={rows} unfiled={unfiled} onOpen={onOpen} /></div>,
    board: () => <div className="px-2"><ThreadBoard requests={requests} showDone={showDone} onOpen={onOpen} /></div>,
    cards: () => <Req ids={['R4.1']}><div className="px-2 pt-1"><RequestCards requests={rows} showDone={showDone} onOpen={onOpen} /></div></Req>,
  }
  return views[view]()
}

function ColumnNames() {
  const { t } = useI18n()
  return (
    <div aria-hidden="true" className={cn(ROW, 'hidden h-12 items-center border-b border-border/80 bg-surface/60 text-[0.82rem] font-medium text-muted-foreground lg:grid')}>
      <span className="size-2" /><span>{t('Request')}</span><span>{t('Status')}</span><span>{t('Next step')}</span><span>{t('Why')}</span><span>{t('Stage')}</span><span />
    </div>
  )
}

const QUIET_UNTIL_USED = 'opacity-0 transition-opacity group-focus-within/focus:opacity-100 group-hover/focus:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100'

/** How a focus line is moved among its peers: the grip starts a drag, and its arrow keys move it one place. */
interface FocusGrip { onPointerDown: (event: React.PointerEvent) => void; onKey: (key: string) => boolean }
/** What a focus line needs from its section: the saves, whether a grip is worth showing (a focus alone has nowhere to
 * go), and, when the list is arranged by initiative, the headings it can be filed under. */
interface FocusMoves { movable: boolean; changes: FocusChanges; initiatives?: readonly InitiativeChoice[] }

interface FocusLineProps { group: ThreadGroup; open: boolean; onToggle: () => void; onOpenFocus: (focusAreaId: string) => void; grip?: FocusGrip; nested: boolean; moves: FocusMoves }

/** A focus area's line: its icon's place is the icon menu, and a reason is said under the line when an icon action failed. */
function AreaFocusLine({ area, ...props }: FocusLineProps & { area: FocusArea }) {
  const icon = useFocusIconControl(area)
  return <FocusLineRow {...props} icon={<FocusIconMenu control={icon} size="line" />} below={<FocusIconProblem control={icon} className="pr-2 pb-2 pl-[8.25rem] md:pl-[6.25rem]" />} />
}

/** Other and Sorting… are not the owner's areas and carry no icon; they keep the icon's place so the names stay in one column. */
function FocusLine(props: FocusLineProps) {
  return props.group.kind === 'area' ? <AreaFocusLine {...props} area={props.group.area} /> : <FocusLineRow {...props} icon={<span aria-hidden="true" className="size-11 shrink-0 md:size-7" />} />
}

/**
 * One focus, closed: its name (the goal is its hover text), how many chats it holds in each state, and its place in
 * the owner's order. A kept or suggested focus is moved by its grip: dragged, or with the arrow keys while the grip
 * has the focus. A suggested one says so in one quiet word, since moving it keeps it.
 */
function FocusLineRow({ group, open, onToggle, onOpenFocus, grip, nested, moves, icon, below }: FocusLineProps & { icon: React.ReactNode; below?: React.ReactNode }) {
  const { t } = useI18n()
  const name = group.kind === 'area' ? group.area.name : group.kind === 'other' ? t('Other') : t('Sorting…')
  const focusAreaId = group.kind === 'area' ? group.area.id : group.kind === 'other' ? OTHER_FOCUS_AREA_ID : null
  // Under an initiative's heading the focus names are one level down.
  const Name = nested ? 'h3' : 'h2'
  const GRIP = '-mx-1 flex h-11 w-5 shrink-0 items-center justify-center text-muted-foreground/70 md:h-7'
  return (
    <div className="border-b">
    <div className="group/focus flex items-center gap-2 px-2 py-2">
      {/* Every line keeps the grip's place, so chevrons, icons and names stay in one column. */}
      <Req ids={['R19.18']}>
        {grip
          // Quiet until the line is pointed at or holds the keyboard focus; a touch screen has no hover, so there it always shows.
          ? <button type="button" data-focus-grip={group.key} aria-label={interpolate(t('Reorder {name}. Drag it, or press Arrow Up or Arrow Down to move it.'), { name })} title={t('Drag to reorder')}
              onPointerDown={grip.onPointerDown} onKeyDown={(event) => { if (grip.onKey(event.key)) event.preventDefault() }}
              className={cn(GRIP, 'cursor-grab touch-none rounded-sm select-none focus-visible:outline-2 focus-visible:outline-ring active:cursor-grabbing', QUIET_UNTIL_USED)}>
              <GripVerticalIcon className="size-4" />
            </button>
          : <span aria-hidden="true" className={GRIP} />}
      </Req>
      <Button variant="ghost" size="sm" className="size-11 shrink-0 p-0 text-muted-foreground md:size-7" aria-expanded={open} aria-label={interpolate(t(open ? 'Hide the chats in {name}' : 'Show the chats in {name}'), { name })} onClick={onToggle}>
        <ChevronRightIcon className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
      </Button>
      {icon}
      <Name className="min-w-0 flex-1 text-sm font-semibold tracking-tight">
        {focusAreaId ? <button type="button" onClick={() => onOpenFocus(focusAreaId)} title={group.kind === 'area' ? group.area.goal || undefined : undefined} className="rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring">{name}</button> : name}
        {group.kind === 'area' && group.area.status === 'suggested' && <span className="ml-2 text-xs font-normal text-muted-foreground/70">{t('suggested')}</span>}
      </Name>
      {group.kind === 'area' && moves.initiatives && <InitiativeMenu area={group.area} choices={moves.initiatives} changes={moves.changes} className={QUIET_UNTIL_USED} />}
      <Req ids={['R19.9']}>
        <ul className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground tabular-nums">
          {statusCounts(group.requests, t).map(({ bucket, count, label }) => (
            <li key={bucket} className={cn(bucket === 'done' && 'text-muted-foreground/70')}>
              <LabelledDot label={label} className="inline-flex items-center gap-1.5"><span className={cn('size-2 rounded-full', COUNT_DOT[bucket])} />{count}</LabelledDot>
            </li>
          ))}
        </ul>
      </Req>
    </div>
    {below}
    </div>
  )
}

interface FocusGroupProps { group: ThreadGroup; open: boolean; onToggle: () => void; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void; moves: FocusMoves; nested: boolean; showDone: boolean }

/** A focus line and, when opened, what is under it: the owner's notes and plan for an area, then its threads. */
function FocusGroup({ group, open, onToggle, onOpen, onOpenFocus, moves, nested, showDone, grip }: FocusGroupProps & { grip?: FocusGrip }) {
  return (
    <Req ids={['R16.5']}>
      <FocusLine group={group} open={open} onToggle={onToggle} onOpenFocus={onOpenFocus} grip={grip} nested={nested} moves={moves} />
      {open && (
        <div className="pt-2 pb-4">
          <div className="flex flex-wrap items-start justify-end gap-x-4 gap-y-1 px-2 pb-2">
            {group.kind === 'area' && <div className="min-w-0 flex-1 basis-64"><FocusNotes area={group.area} changes={moves.changes} /></div>}
            <FocusThreadViewSwitch />
            {group.kind === 'area' && <PlanButton focusAreaId={group.area.id} />}
          </div>
          {group.kind === 'area' && <PlanProposals focusAreaId={group.area.id} changes={moves.changes} className="px-2 pb-2" />}
          <FocusThreads requests={group.requests} rows={group.rows} unfiled={group.kind !== 'area'} showDone={showDone} onOpen={onOpen} />
        </div>
      )}
    </Req>
  )
}

/** A drag as its section hears of it: where the pointer is while it is carried (page coordinates), then that it was let go. */
interface DragReport { onStart: () => void; onMove: (point: { x: number; y: number }) => void; onEnd: () => void }

/** A kept or suggested focus, which its grip drags to another place among its peers. It closes while it is carried, so a long list of threads is not dragged along. */
function DraggableFocusGroup({ drag, dragging, onGripKey, ...props }: FocusGroupProps & { dragging: boolean; drag: DragReport; onGripKey: (key: string) => boolean }) {
  const controls = useDragControls()
  const startDrag = (event: React.PointerEvent) => {
    if (props.moves.changes.saving) return
    // Otherwise the drag selects the text it passes over.
    event.preventDefault()
    controls.start(event)
  }
  return (
    <Reorder.Item as="section" value={props.group.key} layout="position" dragListener={false} dragControls={controls} onDragStart={drag.onStart} onDrag={(_event, info) => drag.onMove(info.point)} onDragEnd={drag.onEnd}
      className={cn('relative', dragging && 'z-10 rounded-md bg-background shadow-md')}>
      <FocusGroup {...props} open={props.open && !dragging} grip={props.moves.movable ? { onPointerDown: startDrag, onKey: onGripKey } : undefined} />
    </Reorder.Item>
  )
}

const sameMembers = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id))

const SECTION_ATTRIBUTE = 'data-focus-section'
/** The section under a point of the page, by its key; null between sections or off the list. */
function sectionAt(point: { x: number; y: number }): string | null {
  const y = point.y - window.scrollY
  for (const element of document.querySelectorAll<HTMLElement>(`[${SECTION_ATTRIBUTE}]`)) {
    const box = element.getBoundingClientRect()
    if (y >= box.top && y <= box.bottom) return element.getAttribute(SECTION_ATTRIBUTE)
  }
  return null
}

/** Arranged by project: the headings a focus can be filed under, the heading a carried line or heading is over, and the heading being carried. */
interface InitiativeMoves { choices: readonly InitiativeChoice[]; sections: readonly FocusSection[]; over: string | null; onOver: (key: string | null) => void; carried: string | null; onCarry: (key: string | null) => void }

/**
 * One run of focus lines, under its project's name when the list is arranged that way. Its kept and suggested
 * focuses can be dragged among themselves: the list shows the new order at once, one `reorder` saves it (keeping a
 * suggested focus that was moved, at the place it was put), and a refused save puts the lines back. Let go over
 * another project's section, a focus is filed under that project instead and keeps its place in the owner's order.
 * A project's heading let go over another project's section merges the first into the second.
 */
function FocusSectionView({ section, order, changes, opened, onToggle, onOpen, onOpenFocus, initiatives, showDone }: { section: FocusSection; order: string[]; changes: FocusChanges; opened: ReadonlySet<string>; onToggle: (key: string) => void; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void; initiatives?: InitiativeMoves; showDone: boolean }) {
  const { t } = useI18n()
  const { focusAreas } = useWorkModel()
  const orderable = section.groups.filter((group) => group.kind === 'area' && isOrderable(group.area))
  const peers = orderable.map((group) => group.key)
  const [draft, setDraft] = useState<string[] | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  // A model that arrived mid-drag with other focuses wins over the order being dragged.
  const shown = draft && sameMembers(draft, peers) ? draft : peers
  const headed = section.kind !== 'plain'
  const elsewhere = headed && initiatives ? initiatives.sections.filter((entry) => entry.kind !== 'plain' && entry.key !== section.key) : []
  const moves: FocusMoves = { movable: shown.length > 1 || elsewhere.length > 0, changes, ...(headed && initiatives ? { initiatives: initiatives.choices } : {}) }
  const [announced, setAnnounced] = useState('')
  const lines = useRef<HTMLDivElement>(null)
  /** Shows `next` at once and saves the owner's whole order with `id` at its new place; a refused save puts the lines back. */
  const save = async (next: string[], id: string) => {
    setDraft(next)
    const placed = placeInOrder(order, next, id)
    const saved = placed.every((entry, index) => entry === order[index]) || await changes.apply({ action: 'reorder', focusAreaIds: placed })
    setDraft(null)
    return saved
  }
  const drop = (key: string) => {
    setDragging(null)
    const target = elsewhere.find((entry) => entry.key === initiatives?.over)
    initiatives?.onOver(null)
    const carried = orderable.find((group) => group.key === key)
    if (!target || carried?.kind !== 'area') { void save(shown, key); return }
    // Filed under the heading it was let go over; the order it was dragged through on the way is not kept.
    setDraft(null)
    const change = moveToInitiative(carried.area, target.kind === 'initiative' ? target.initiative : null)
    if (change) void changes.apply(change)
  }
  /** An arrow key on a grip. True when the key was a move, so the page does not scroll with it. */
  const gripKey = (id: string, key: string) => {
    const next = gripKeyMove(key, shown, id)
    if (!next || changes.saving) return key === 'ArrowUp' || key === 'ArrowDown'
    const moved = orderable.find((group) => group.key === id)
    const name = moved?.kind === 'area' ? moved.area.name : ''
    void save(next, id).then((saved) => {
      if (saved) setAnnounced(interpolate(t('{name} moved to {position} of {total}'), { name, position: next.indexOf(id) + 1, total: next.length }))
      // The line was put somewhere else in the page; the keyboard stays on its grip.
      lines.current?.querySelector<HTMLElement>(`[data-focus-grip="${CSS.escape(id)}"]`)?.focus()
    })
    // The same, before the save answers: moving a focused element can drop the focus.
    requestAnimationFrame(() => lines.current?.querySelector<HTMLElement>(`[data-focus-grip="${CSS.escape(id)}"]`)?.focus())
    return true
  }
  const common = (group: ThreadGroup) => ({ group, open: opened.has(group.key), onToggle: () => onToggle(group.key), onOpen, onOpenFocus, moves, nested: headed, showDone })
  /** This project merged into another: every focus under it filed under that one's name, as one change. */
  const mergeInto = (name: string) => {
    const change = section.kind === 'initiative' ? mergeInitiatives(section.initiative, name, focusAreas) : null
    if (change && section.kind === 'initiative') void changes.apply(change, { heading: section.initiative })
  }
  const others = section.kind === 'initiative' && initiatives ? initiatives.choices.filter((choice) => `initiative:${choice.key}` !== section.key) : []
  const carry: HeadingCarry = {
    onStart: () => initiatives?.onCarry(section.key),
    // A project is merged into a project: the No project section is not a place to drop a heading.
    onMove: (point) => { const key = sectionAt(point); initiatives?.onOver(others.some((choice) => `initiative:${choice.key}` === key) ? key : null) },
    onEnd: () => {
      const target = others.find((choice) => `initiative:${choice.key}` === initiatives?.over)
      initiatives?.onOver(null)
      initiatives?.onCarry(null)
      if (target) mergeInto(target.name)
    },
  }
  // A focus or a heading carried in from another section: this is where letting go would file it.
  const receiving = headed && !dragging && initiatives?.over === section.key && initiatives.carried !== section.key
  return (
    <div ref={lines} {...(headed ? { [SECTION_ATTRIBUTE]: section.key } : {})} className={cn('mt-6 rounded-md first:mt-0', receiving && 'bg-accent/60 outline-2 outline-ring/50')}>
      <p role="status" className="sr-only">{announced}</p>
      {headed && <InitiativeHeading section={section} changes={changes} others={others} carry={carry} onMergeInto={mergeInto} />}
      <Reorder.Group as="div" axis="y" values={shown} onReorder={setDraft}>
        {shown.map((key) => {
          const group = orderable.find((entry) => entry.key === key)!
          const drag: DragReport = { onStart: () => setDragging(key), onMove: (point) => initiatives?.onOver(sectionAt(point)), onEnd: () => drop(key) }
          return <DraggableFocusGroup key={key} {...common(group)} dragging={dragging === key} drag={drag} onGripKey={(pressed) => gripKey(key, pressed)} />
        })}
      </Reorder.Group>
      {section.groups.filter((group) => !orderable.includes(group)).map((group) => <section key={group.key}><FocusGroup {...common(group)} /></section>)}
    </div>
  )
}

/**
 * With every request showing, the focus areas come first, in the owner's order: each one a line of counts that opens
 * onto its threads. Inside one area there is nothing to group by, so the rows stand alone. `shows` picks the rows
 * out of `requests`; a focus line still counts all of them.
 */
export function ThreadList({ requests, shows, focusAreas, grouped, arrangement = 'priority', showDone = false, onOpen, onOpenFocus }: { requests: Request[]; shows?: (request: Request) => boolean; focusAreas: readonly FocusArea[]; grouped: boolean; arrangement?: FocusArrangement; showDone?: boolean; onOpen: (request: Request) => void; onOpenFocus: (focusAreaId: string) => void }) {
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const [over, setOver] = useState<string | null>(null)
  const [carried, setCarried] = useState<string | null>(null)
  const changes = useFocusChanges()
  // The owner's saved order: every kept area. A suggested area joins it when its line is moved (placeInOrder).
  const order = focusAreas.filter((area) => area.status === 'kept' && !area.mergedInto).sort(byFocusPriority).map((area) => area.id)
  const toggle = (key: string) => setOpened((current) => { const next = new Set(current); if (!next.delete(key)) next.add(key); return next })
  const sections = grouped ? focusSections(threadGroups(focusAreas, requests, shows), arrangement) : []
  const initiatives: InitiativeMoves | undefined = arrangement === 'initiative'
    ? { sections, over, onOver: setOver, carried, onCarry: setCarried, choices: sections.flatMap((section) => section.kind === 'initiative' ? [{ key: section.key.slice('initiative:'.length), name: section.initiative }] : []) }
    : undefined
  return (
    <Req ids={['R19.1', 'R1.1', 'R2.1', 'R3.3', 'R11.1']}>
      {grouped ? (
        <div>
          {sections.map((section) => (
            <FocusSectionView key={section.key} section={section} order={order} changes={changes} opened={opened} onToggle={toggle} onOpen={onOpen} onOpenFocus={onOpenFocus} initiatives={initiatives} showDone={showDone} />
          ))}
        </div>
      ) : <FocusThreads requests={sortThreads(requests)} rows={sortThreads(shows ? requests.filter(shows) : requests)} showDone={showDone} onOpen={onOpen} />}
    </Req>
  )
}
