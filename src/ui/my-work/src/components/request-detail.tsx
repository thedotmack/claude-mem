import { useEffect, useRef, useState } from 'react'
import { CheckIcon, ChevronDownIcon, FileTextIcon, Undo2Icon } from 'lucide-react'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import { QueueItem, QueueItemContent, QueueItemIndicator, QueueList } from '@/components/ai-elements/queue'
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task'
import { SaveButton } from '@/components/save-button'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Req } from '@/spec/req'
import { OTHER_FOCUS_AREA_ID, type Request } from '@/data'
import { useStore, useWorkModel, useWorkspace } from '@/store'
import { isPlaceableFocusArea, resolveFocusAreaId } from '@/live/to-focus-model'
import { CHANGED_WHILE_READING_MESSAGE, CHECK_UNDONE_MESSAGE, CHECKED_LOCALLY_MESSAGE, type ReviewResult } from '@/live/review-response'
import { PRODUCT_ICON } from '@/lib/product-icons'
import { cn } from '@/lib/utils'
import { AgentIcon, FocusAreaChip, NextMove, ProductLink, ProgressMeter, StateBadge } from './bits'
import { FocusChangeBar, useFocusChanges } from './focus-changes'
import { OpenFollowUps } from './request-card'
import { mergeRequestDetail, requestDetailKey } from '@/live/request-detail-state'

const RECENT_RECORDS = 5

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h4 className="section-label">{title}</h4>
      {children}
    </section>
  )
}

/** A quiet disclosure for the secondary layers (§3: granular content is small and not the primary focus). */
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Collapsible className="group/disclosure">
      <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 text-left text-sm text-muted-foreground hover:text-foreground md:min-h-9">
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]/disclosure:rotate-180 motion-reduce:transition-none" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}

function Records({ records }: { records: Request['granular'] }) {
  return (
    <QueueList>
      {records.map((record, index) => (
        <QueueItem key={`${index}-${record.text}`}>
          <div className="flex items-center gap-2">
            <QueueItemIndicator completed={record.kind === 'memory'} />
            <QueueItemContent className="text-xs">{record.text}</QueueItemContent>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{record.kind === 'memory' ? 'memory' : 'work'} · {record.at}</span>
          </div>
        </QueueItem>
      ))}
    </QueueList>
  )
}

type CheckNotice = { tone: 'saved' | 'problem'; message: string }

/** What the person is told after the worker answers (app.js `saveReview` toasts). */
function noticeFor(result: ReviewResult, checked: boolean, requestId: string, expectedFingerprint?: string): CheckNotice {
  switch (result.outcome) {
    case 'saved': {
      const latest = result.model.requests.find((request) => request.id === requestId)
      const review = latest?.review
      const shared = (result.save?.scope ?? review?.mode) === 'shared'
      const pending = result.save ? result.save.state === 'queued' : review?.pending
      if (shared && review?.conflict) return {
        tone: 'problem', message: `Your review decision was saved here, but your viewers still have conflicting decisions. Read this version and choose again.${pending ? ' The saved decision is waiting to sync.' : ''}`,
      }
      if (expectedFingerprint && latest?.contentFingerprint !== expectedFingerprint) return {
        tone: 'problem', message: `Your review decision was saved for the version you read. The current work changed; review it again.${shared && pending ? ' The saved decision is waiting to sync.' : ''}`,
      }
      return { tone: 'saved', message: shared
        ? `${checked ? 'Checked' : 'Check undone'} for this shared version.${pending ? ' Saved here; waiting to sync to your other viewers.' : ''}`
        : result.model.sourceKind === 'cloud'
          ? `${checked ? 'Checked' : 'Check undone'} in your cloud viewer only. My Work sharing is off.`
          : checked ? CHECKED_LOCALLY_MESSAGE : CHECK_UNDONE_MESSAGE }
    }
    case 'changed-while-reading': return { tone: 'problem', message: result.serverMessage ?? CHANGED_WHILE_READING_MESSAGE }
    case 'refused': return { tone: 'problem', message: result.serverMessage }
    case 'unavailable': return { tone: 'problem', message: result.serverMessage }
  }
}

/**
 * Done, not checked: the one action in the drawer, with undo. Checking saves this version as checked where the
 * work came from and hands it back to you to ship; it never ships it. The worker refuses a version that changed.
 */
function CheckAction({ request }: { request: Request }) {
  const { mode } = useWorkspace()
  const { sourceKind, devices } = useWorkModel()
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<CheckNotice | null>(null)
  // Resolves false when the save did not happen, so the button shows no check; the notice line says why.
  const save = async (checked: boolean) => {
    setSaving(true)
    let next: CheckNotice
    try {
      // The version on screen is the one checked; the worker refuses any other.
      next = noticeFor(await useStore.getState().setRequestChecked(request.id, checked, request.contentFingerprint, request.review?.hash), checked, request.id, request.contentFingerprint)
    } catch (error) {
      next = { tone: 'problem', message: error instanceof Error ? error.message : String(error) }
    } finally {
      setSaving(false)
    }
    setNotice(next)
    return next.tone !== 'problem'
  }
  const noticeLine = notice && (
    <p role="status" className={cn('w-full text-xs', notice.tone === 'problem' ? 'font-medium text-foreground' : 'text-muted-foreground')}>{notice.message}</p>
  )
  if (request.review?.available === false) return (
    <p role="status" className="rounded-xl border p-4 text-sm text-muted-foreground">{request.review.message ?? 'This review is unavailable until the shared state is complete. Nothing was changed.'}</p>
  )
  if (request.review?.conflict) return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border p-4 text-sm">
      <p role="status" className="basis-full">{request.review.message ?? 'Your viewers recorded different review decisions. Read this version, then choose the decision to keep.'}</p>
      {request.state === 'needs-check' && <SaveButton className={cn(buttonVariants(), 'h-11 md:h-9')} onClick={() => save(true)} disabled={saving}><CheckIcon />Mark checked</SaveButton>}
      <SaveButton className={cn(buttonVariants({ variant: 'ghost' }), 'h-11 md:h-9')} onClick={() => save(false)} disabled={saving}><Undo2Icon />Keep unchecked</SaveButton>
      {noticeLine}
    </div>
  )
  if (request.state === 'needs-check') {
    return (
      <Req ids={['R6.2', 'R13.7']}>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-review-border bg-review p-4 text-sm text-review-foreground">
          <span>Done. Check it, then mark this version checked.</span>
          <SaveButton className={cn(buttonVariants(), 'h-11 md:h-9')} onClick={() => save(true)} disabled={saving}><CheckIcon />Mark checked</SaveButton>
          {noticeLine}
        </div>
      </Req>
    )
  }
  if (!request.checkedAt) return noticeLine
  const savedWhere = request.review?.mode === 'shared'
    ? request.review.pending ? 'Saved here; waiting to sync to your other viewers.' : 'Saved as a shared review decision.'
    : sourceKind === 'cloud' ? 'Saved in your cloud viewer only. My Work sharing is off.' : sourceKind !== 'sample' ? 'Saved on this machine only.' : mode === 'web' ? `Saved from the web · syncing to ${devices.length} machines (demonstration)` : 'Saved on this machine (demonstration)'
  return (
    <Req ids={['R6.2', 'R13.7']}>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-surface p-4 text-sm">
        <span role="status">{notice?.tone === 'saved' ? notice.message : `Checked ${request.checkedAt}.`} Shipping is still your call. {notice?.tone !== 'saved' && <span className="text-muted-foreground">{savedWhere}</span>}</span>
        <SaveButton className={cn(buttonVariants({ variant: 'ghost' }), 'h-11 md:h-9')} onClick={() => save(false)} disabled={saving}><Undo2Icon />Undo</SaveButton>
        {notice?.tone === 'problem' && noticeLine}
      </div>
    </Req>
  )
}

function SuggestionAction({ request }: { request: Request }) {
  const { sourceKind } = useWorkModel()
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<CheckNotice | null>(null)
  const suggestion = request.suggestion
  if (!suggestion) return notice ? <p role="status" className="text-sm text-muted-foreground">{notice.message}</p> : null
  const save = async (action: 'join' | 'not-this') => {
    setSaving(true)
    try {
      const result = await useStore.getState().answerRequestSuggestion(suggestion, action)
      const shared = result.save?.scope === 'shared'
      const localCopy = result.save?.localMaterialization === 'pending' ? " This viewer's local work copy is still updating." : ''
      const conflict = result.model.requests.some((current) => current.suggestion?.conversationKey === suggestion.conversationKey && current.suggestion.sharedConflict)
      if (conflict) {
        setNotice({ tone: 'problem', message: `Your decision was saved here, but grouping decisions still conflict. Read this suggestion and choose again.${shared && result.save?.state === 'queued' ? ' The saved decision is waiting to sync.' : ''}${localCopy}` })
        return
      }
      setNotice({ tone: 'saved', message: `${action === 'join' ? 'Joined the request.' : 'Kept these requests separate.'} ${shared
        ? result.save?.state === 'queued' ? 'Saved here; waiting to sync to your other viewers.' : 'Saved as a shared decision.'
        : sourceKind === 'cloud' ? 'Saved in your cloud viewer only.' : 'Saved on this machine only.'}${localCopy}` })
    } catch (error) { setNotice({ tone: 'problem', message: error instanceof Error ? error.message : String(error) }) }
    finally { setSaving(false) }
  }
  return <div className="space-y-2 rounded-xl border p-4 text-sm">
    <p>{suggestion.sharedConflict ? 'Your viewers recorded different grouping decisions. Read this suggestion, then choose again to resolve them.' : 'This work may be part of another request.'}</p>
    <p className="font-medium">{suggestion.requestTitle}</p>
    {suggestion.evidence && <p className="text-muted-foreground">{suggestion.evidence}</p>}
    <div className="flex gap-2">
      <SaveButton className={cn(buttonVariants(), 'h-11 md:h-9')} onClick={() => save('join')} disabled={saving}>Join</SaveButton>
      <SaveButton className={cn(buttonVariants({ variant: 'ghost' }), 'h-11 md:h-9')} onClick={() => save('not-this')} disabled={saving}>Not this</SaveButton>
    </div>
    {notice && <p role="status" className={notice.tone === 'problem' ? 'font-medium' : 'text-muted-foreground'}>{notice.message}</p>}
  </div>
}

/** Move to…: puts the request in another area or Other, as the owner's placement (a refresh never overrides it). */
function MoveTo({ request }: { request: Request }) {
  const { focusAreas } = useWorkModel()
  // The shared save: a second pick while one move is saving does nothing, and the move shows with Undo.
  const changes = useFocusChanges()
  const current = resolveFocusAreaId(request.focusAreaId, focusAreas)
  const targets = focusAreas.filter((area) => isPlaceableFocusArea(area) && area.id !== current)
  // Nowhere to move it, or no conversation to file the move under: the worker would refuse, so there is no control.
  if (targets.length === 0 && current === OTHER_FOCUS_AREA_ID) return null
  if (request.canMoveFocus === false) return null
  const move = (focusAreaId: string) => { changes.apply({ action: 'move-request', requestId: request.id, focusAreaId }) }
  return (
    <Req ids={['R16.6']}>
      <div className="space-y-1">
        <Select value="" onValueChange={move} disabled={changes.saving}>
          <SelectTrigger aria-label="Move to another focus area" size="sm" className="h-11 text-xs md:h-8"><SelectValue placeholder={changes.saving ? 'Moving…' : 'Move to…'} /></SelectTrigger>
          <SelectContent>
            {targets.map((area) => <SelectItem key={area.id} value={area.id}>{area.name}{area.status === 'suggested' ? ' · suggested' : ''}</SelectItem>)}
            {current !== OTHER_FOCUS_AREA_ID && <SelectItem value={OTHER_FOCUS_AREA_ID}>Other</SelectItem>}
          </SelectContent>
        </Select>
        <FocusChangeBar changes={changes} />
      </div>
    </Req>
  )
}

/** The request page (§3): whose move and what's next first, then outcome, then the layers underneath, collapsed. */
export function RequestDetail({ request, onClose, onOpenFocus }: { request: Request | null; onClose: () => void; onOpenFocus: (focusAreaId: string) => void }) {
  const readDetail = useStore((state) => state.loadRequestDetail)
  const [retry, setRetry] = useState(0)
  const [detail, setDetail] = useState<{ key: string; request?: Request; error?: string } | null>(null)
  const key = request ? requestDetailKey(request) : ''
  const needsDetail = request?.detailLoaded === false
  const requestRef = useRef(request)
  requestRef.current = request
  useEffect(() => {
    const summary = requestRef.current
    if (!summary || !needsDetail) return
    const controller = new AbortController()
    let active = true
    setDetail({ key })
    void readDetail(summary, { signal: controller.signal }).then(
      (loaded) => { if (active) setDetail({ key, request: loaded }) },
      (error: unknown) => {
        if (active && !controller.signal.aborted) setDetail({ key, error: error instanceof Error ? error.message : 'Request detail could not be loaded.' })
      },
    )
    return () => { active = false; controller.abort() }
    // The detail version changes only when recorded content changes. A new overview object must not restart this read.
  }, [key, needsDetail, readDetail, retry])
  if (!request) return null
  if (!needsDetail) return <LoadedRequestDetail request={request} onClose={onClose} onOpenFocus={onOpenFocus} />
  const current = detail?.key === key ? detail : null
  if (current?.request) return <LoadedRequestDetail request={mergeRequestDetail(request, current.request)} onClose={onClose} onOpenFocus={onOpenFocus} />
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="gap-3 border-b p-5 md:p-6">
          <SheetTitle className="pr-8 text-xl leading-snug">{request.title ?? request.resolvesTo?.title ?? 'Untitled request'}</SheetTitle>
          <SheetDescription>{request.summary ?? request.resolvesTo?.summary ?? 'Request details'}</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 p-5 md:p-6" aria-live="polite">
          {current?.error ? <><p role="alert" className="text-sm text-muted-foreground">{current.error}</p><Button variant="outline" onClick={() => setRetry((value) => value + 1)}>Try again</Button></> : <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-4" />Loading request detail…</p>}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function LoadedRequestDetail({ request, onClose, onOpenFocus }: { request: Request; onClose: () => void; onOpenFocus: (focusAreaId: string) => void }) {
  const title = request.title ?? request.resolvesTo?.title ?? 'Untitled request'
  const recent = request.granular.slice(0, RECENT_RECORDS)
  const earlier = request.granular.slice(RECENT_RECORDS)
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <Req ids={['R3.6', 'R3.2']}>
          <SheetHeader className="gap-3 border-b p-5 md:p-6">
            <div className="flex min-w-0 flex-wrap items-center gap-2 pr-10"><StateBadge state={request.state} /><AgentIcon agentId={request.agentId} withDevice /></div>
            <SheetTitle className="text-xl leading-snug">{title}</SheetTitle>
            <SheetDescription className="line-clamp-2">{request.summary ?? request.resolvesTo?.summary}</SheetDescription>
            <NextMove next={request.next} className="text-[0.95rem]" />
          </SheetHeader>
        </Req>

        <div className="space-y-6 p-5 md:p-6">
          <CheckAction key={request.id} request={request} />
          <SuggestionAction key={`suggestion:${request.id}`} request={request} />
          <OpenFollowUps request={request} />

          <div className="space-y-3">
            <ProgressMeter request={request} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <FocusAreaChip focusAreaId={request.focusAreaId} onOpen={onOpenFocus} />
              {/* Sample fixtures change in memory; live requests save as my-focus rows. */}
              <MoveTo request={request} />
              <span>Asked by {request.askedBy} · started {request.startedAt} · {request.runningFor} · {request.stage}</span>
            </div>
          </div>

          <Req ids={['R5.10', 'R5.12']}>
            <Section title="Deliverables">
              {request.workProduct.length === 0 ? <p className="text-sm text-muted-foreground">Nothing attached yet.</p> : (
                <div className="-mx-3 flex flex-col">
                  {request.workProduct.map((product, index) => {
                    const Icon = PRODUCT_ICON[product.kind]
                    return (
                      <ProductLink key={`${index}-${product.label}`} href={product.href} className={cn('flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm', product.href && 'hover:bg-surface')}>
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0"><span className="block truncate">{product.label}</span>
                          {product.availability === 'origin-only' && <span className="block text-xs text-muted-foreground">Local file — check the original computer</span>}
                        </span>
                        <Badge variant="outline" className="ml-auto shrink-0 font-normal">{product.kind}</Badge>
                      </ProductLink>
                    )
                  })}
                </div>
              )}
            </Section>
          </Req>

          {request.workstreams.length > 0 && (
            <Req ids={['R3.4']}>
              <Section title="Workstreams">
                <div className="divide-y divide-border/70">
                  {request.workstreams.map((stream, index) => (
                    <Task key={`${index}-${stream.title}`} defaultOpen={false} className="py-0.5">
                      <TaskTrigger title={`${stream.title} · ${stream.tasks.filter((task) => task.done).length} of ${stream.tasks.length} done`} />
                      <TaskContent className="pb-3">
                        {stream.tasks.map((task, index) => <TaskItem key={`${index}-${task.name}`} className={task.done ? 'line-through' : ''}>{task.name}</TaskItem>)}
                      </TaskContent>
                    </Task>
                  ))}
                </div>
              </Section>
            </Req>
          )}

          {(request.story.length > 0 || request.storyNarrative) && (
            <Req ids={['R7.2', 'R3.2']}>
              <ChainOfThought defaultOpen={false}>
                <ChainOfThoughtHeader>Build story</ChainOfThoughtHeader>
                <ChainOfThoughtContent>
                  {request.storyNarrative && <p className="text-sm text-muted-foreground">{request.storyNarrative}</p>}
                  {request.story.map((step, index) => <ChainOfThoughtStep key={`${index}:${step.label}`} label={step.label} description={step.description} status={step.status} />)}
                </ChainOfThoughtContent>
              </ChainOfThought>
            </Req>
          )}

          <Req ids={['R3.5']}>
            <Section title="Latest records">
              {recent.length === 0 ? <p className="text-sm text-muted-foreground">No records yet.</p> : <Records records={recent} />}
              {earlier.length > 0 && <Disclosure label={`${earlier.length} earlier record${earlier.length === 1 ? '' : 's'}`}><Records records={earlier} /></Disclosure>}
            </Section>
          </Req>

          <Req ids={['R2.5', 'R2.2', 'R5.11']}>
            <Disclosure label={`Where this came from · ${request.conversations.length || 1} conversation${request.conversations.length > 1 ? 's' : ''}${request.evidence.length ? `, ${request.evidence.length} sources` : ''}`}>
              <div className="space-y-2.5 pb-2">
                {request.conversations.length === 0 && request.prompts.length === 0 && <p className="text-sm text-muted-foreground">One conversation so far.</p>}
                {request.conversations.map((conversation, index) => (
                  <p key={`${index}-${conversation.at}`} className="text-sm"><span className="text-muted-foreground">{conversation.tool} · {conversation.at}</span> — {conversation.title}</p>
                ))}
                {request.prompts.map((prompt, index) => (
                  <blockquote key={`${index}-${prompt.at}`} className="border-l-2 pl-3 text-sm text-muted-foreground">“{prompt.quote}” <span className="text-[11px]">{prompt.at}</span></blockquote>
                ))}
                {request.evidence.map((source) => (
                  <ProductLink key={source.href === '#' ? source.title : source.href} href={source.href} className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground"><FileTextIcon className="size-3.5" />{source.title}</ProductLink>
                ))}
              </div>
            </Disclosure>
          </Req>
        </div>
      </SheetContent>
    </Sheet>
  )
}
