import { useState } from 'react'
import { CheckIcon, ChevronDownIcon, FileTextIcon, Undo2Icon } from 'lucide-react'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtStep } from '@/components/ai-elements/chain-of-thought'
import { QueueItem, QueueItemContent, QueueItemIndicator, QueueList } from '@/components/ai-elements/queue'
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Req } from '@/spec/req'
import { setRequestChecked, useWorkModel, type Request } from '@/data'
import { CHANGED_WHILE_READING_MESSAGE, CHECK_UNDONE_MESSAGE, CHECKED_LOCALLY_MESSAGE, type ReviewResult } from '@/live/review-response'
import { PRODUCT_ICON } from '@/lib/product-icons'
import { cn } from '@/lib/utils'
import { AgentIcon, GoalChip, NextMove, ProductLink, ProgressMeter, StateBadge, useWorkspace } from './bits'
import { OpenFollowUps } from './request-card'

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
function noticeFor(result: ReviewResult, checked: boolean): CheckNotice {
  switch (result.outcome) {
    case 'saved': return { tone: 'saved', message: checked ? CHECKED_LOCALLY_MESSAGE : CHECK_UNDONE_MESSAGE }
    case 'changed-while-reading': return { tone: 'problem', message: CHANGED_WHILE_READING_MESSAGE }
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
  const save = async (checked: boolean) => {
    setSaving(true)
    try {
      setNotice(noticeFor(await setRequestChecked(request.id, checked), checked))
    } catch (error) {
      setNotice({ tone: 'problem', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setSaving(false)
    }
  }
  const noticeLine = notice && (
    <p role="status" className={cn('w-full text-xs', notice.tone === 'problem' ? 'font-medium text-foreground' : 'text-muted-foreground')}>{notice.message}</p>
  )
  if (request.state === 'needs-check') {
    return (
      <Req ids={['R6.2', 'R13.7']}>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-review-border bg-review p-4 text-sm text-review-foreground">
          <span>Done. Check it, then mark this version checked.</span>
          <Button className="h-11 md:h-9" onClick={() => save(true)} disabled={saving}><CheckIcon />Mark checked</Button>
          {noticeLine}
        </div>
      </Req>
    )
  }
  if (!request.checkedAt) return noticeLine
  const savedWhere = sourceKind !== 'sample' ? 'Saved on this machine.' : mode === 'web' ? `Saved from the web · syncing to ${devices.length} machines (demonstration)` : 'Saved on this machine (demonstration)'
  return (
    <Req ids={['R6.2', 'R13.7']}>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-surface p-4 text-sm">
        <span role="status">{notice?.tone === 'saved' ? notice.message : `Checked ${request.checkedAt}.`} Shipping is still your call. <span className="text-muted-foreground">{savedWhere}</span></span>
        <Button variant="ghost" className="h-11 md:h-9" onClick={() => save(false)} disabled={saving}><Undo2Icon />Undo</Button>
        {notice?.tone === 'problem' && noticeLine}
      </div>
    </Req>
  )
}

/** The request page (§3): whose move and what's next first, then outcome, then the layers underneath, collapsed. */
export function RequestDetail({ request, onClose, onOpenGoal }: { request: Request | null; onClose: () => void; onOpenGoal: (goalId: string) => void }) {
  if (!request) return null
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
          <OpenFollowUps request={request} />

          <div className="space-y-3">
            <ProgressMeter request={request} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <GoalChip goalId={request.goalId} onOpen={onOpenGoal} />
              <span>Asked by {request.askedBy} · started {request.startedAt} · {request.runningFor} · {request.stage}</span>
            </div>
          </div>

          <Req ids={['R5.10']}>
            <Section title="What came out of it">
              {request.workProduct.length === 0 ? <p className="text-sm text-muted-foreground">Nothing attached yet.</p> : (
                <div className="-mx-3 flex flex-col">
                  {request.workProduct.map((product, index) => {
                    const Icon = PRODUCT_ICON[product.kind]
                    return (
                      <ProductLink key={`${index}-${product.label}`} href={product.href} className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm hover:bg-surface">
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate">{product.label}</span>
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
