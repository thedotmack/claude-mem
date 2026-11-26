import { displayTime, recordedTimeWords } from '@/lib/display-time'
import { getLocale, interpolate, t, useI18n } from '@/lib/i18n'
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react'
import { ArrowRightIcon, CheckIcon, FileTextIcon, GitMergeIcon, SplitIcon, Undo2Icon } from 'lucide-react'
import { ChainOfThought, ChainOfThoughtContent, ChainOfThoughtHeader, ChainOfThoughtSteps, ChainOfThoughtSummary } from '@/components/ai-elements/chain-of-thought'
import { QueueItem, QueueItemContent, QueueItemIndicator, QueueList } from '@/components/ai-elements/queue'
import { Task, TaskContent, TaskItem, TaskTrigger } from '@/components/ai-elements/task'
import { openTasksFirst } from '@/lib/tasks'
import { SaveButton } from '@/components/save-button'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Req } from '@/spec/req'
import { OTHER_FOCUS_AREA_ID, type EvidenceKind, type Request, type WorkProductKind } from '@/data'
import { useStore, useWorkModel, useWorkspace } from '@/store'
import { isPlaceableFocusArea, resolveFocusAreaId } from '@/live/to-focus-model'
import { evidenceShown, nextStepShown, recordedStart, recordedTaskName, recordedWorkstreamTitle, TIME_NOT_RECORDED } from '@/live/to-work-model'
import { CHANGED_WHILE_READING_MESSAGE, CHECK_UNDONE_MESSAGE, CHECKED_LOCALLY_MESSAGE, type ReviewResult } from '@/live/review-response'
import { cn } from '@/lib/utils'
import { AgentIcon, FailureDetails, FocusAreaChip, NextMove, ProductLink, ProgressMeter, RecordedTime, STATE_LABEL, StateBadge, StateMark } from './bits'
import { ConversationReplyCard, ConversationRow, type SendEmphasis } from './conversation-continue'
import { durationWords, isFinishedRun } from '@/live/running-time'
import { conversationKey } from '@/live/conversation-continuation'
import { FocusChangeBar, useFocusChanges, type FocusChanges } from './focus-changes'
import { OpenFollowUps } from './request-card'
import { useRequestDetail } from '@/lib/use-request-detail'
import { MediaCountBadge, ObsMediaStrip } from './observation-media/ObsMedia'
import { DeliverableList } from './deliverable-list'
import { AddProductToReview } from './add-product-to-review'
import { isCardDeliverable } from '@/lib/deliverables'
import { requestImages } from './observation-media/request-images'
import { RequestDrawerLoading, RequestDrawerSheet } from './request-drawer'
import { SearchablePicker } from './searchable-picker'

/** The first records shown; older ones fold under "N earlier records" (§3: granular content is small and not the focus). */
const RECENT_RECORDS = 5

/**
 * One of the drawer's five folds (page-05, decisions G5 and D b26 10): the shared fold row, with its count at the right,
 * under an h3 (the title is the drawer's h2; the sections were h4). Closed, it draws nothing inside. `focusOnOpen`: its
 * row takes focus once, as it opens (Reply on a request with no recorded conversation lands on what Reply opened).
 */
function DrawerFold({ title, count, defaultOpen = false, focusOnOpen = false, children }: { title: string; count?: ReactNode; defaultOpen?: boolean; focusOnOpen?: boolean; children: ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null)
  // After the drawer's own first focus, which Radix gives its panel once this row's effects have run: one frame later.
  useEffect(() => {
    if (!focusOnOpen) return
    const frame = requestAnimationFrame(() => trigger.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [focusOnOpen])
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <h3><CollapsibleFoldTrigger ref={trigger} count={count}>{title}</CollapsibleFoldTrigger></h3>
      <CollapsibleContent className="pt-3 pb-1">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** A fold inside a fold ("5 earlier records"): the same shared row, with no heading of its own. */
function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleFoldTrigger className="mt-2">{label}</CollapsibleFoldTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  )
}

/** Each kind's count in words (page-05: "21 branches, 10 commits, 2 PRs"); each form is its own t() call. */
const WORK_PRODUCT_COUNT_WORDS: Record<WorkProductKind, (count: number) => string> = {
  PR: (count) => count === 1 ? t('{count} PR') : t('{count} PRs'),
  Commit: (count) => count === 1 ? t('{count} commit') : t('{count} commits'),
  Branch: (count) => count === 1 ? t('{count} branch') : t('{count} branches'),
  Page: (count) => count === 1 ? t('{count} page') : t('{count} pages'),
  Deck: (count) => count === 1 ? t('{count} deck') : t('{count} decks'),
  Doc: (count) => count === 1 ? t('{count} doc') : t('{count} docs'),
  File: (count) => count === 1 ? t('{count} file') : t('{count} files'),
  Link: (count) => count === 1 ? t('{count} link') : t('{count} links'),
}

/** How many of each kind, most first ("2 docs, 1 PR"). */
function countsByKind(products: Request['workProduct']): string[] {
  const byKind = new Map<WorkProductKind, number>()
  for (const product of products) byKind.set(product.kind, (byKind.get(product.kind) ?? 0) + 1)
  return [...byKind].sort((a, b) => b[1] - a[1]).map(([kind, count]) => interpolate(WORK_PRODUCT_COUNT_WORDS[kind](count), { count }))
}

/**
 * The Deliverables fold's count (V11): first the request's deliverables by the card's one rule (lib/deliverables.ts
 * isCardDeliverable, which the worker's detailCounts uses too), so the card's "Deliverables · 3" and this fold lead with
 * the same number; the total before them when there is more than one kind; then, after "plus", the commits and
 * branches the list also holds, named by kind ("3 · 2 docs, 1 PR · plus 2 commits, 1 branch").
 */
function deliverablesCount(workProduct: Request['workProduct']): string | undefined {
  const deliverables = workProduct.filter(isCardDeliverable)
  const history = countsByKind(workProduct.filter((product) => !isCardDeliverable(product)))
  const kinds = countsByKind(deliverables)
  const lead = kinds.length < 2 ? kinds[0] : `${deliverables.length} · ${kinds.join(', ')}`
  if (history.length === 0) return lead
  const plus = interpolate(t('plus {kinds}'), { kinds: history.join(', ') })
  return lead === undefined ? history.join(', ') : `${lead} · ${plus}`
}

/** The Workstreams fold's count: tasks done of all, or how many workstreams when none lists a task. */
function workstreamsCount(workstreams: Request['workstreams']): string {
  const tasks = workstreams.flatMap((stream) => stream.tasks)
  if (tasks.length > 0) return interpolate(t('{done} of {total} done'), { done: tasks.filter((task) => task.done).length, total: tasks.length })
  return interpolate(workstreams.length === 1 ? t('{count} workstream') : t('{count} workstreams'), { count: workstreams.length })
}

/**
 * Each source record's kind in the reader's language, before its title in "Where this came from" (the mapper sent these
 * as English words in the title, "Observation: …"; Phase 5 fix round 3's open list). Each entry words its own literal
 * text, so the catalog test sees it; a new kind fails the typecheck until it has words here.
 */
const EVIDENCE_KIND_WORDS: Record<EvidenceKind, () => string> = {
  prompt: () => t('Your prompt'),
  'work-state': () => t('Work state'),
  observation: () => t('Observation'),
  summary: () => t('Session summary'),
  session: () => t('Session'),
  record: () => t('Record'),
}

/** A source record's line: its kind's words and its title (an older worker's title that names no kind shows as sent). */
function sourceRecordWords(source: Request['evidence'][number]): string {
  const shown = evidenceShown(source)
  return shown.kind === null ? shown.title : interpolate(t('{kind}: {title}'), { kind: EVIDENCE_KIND_WORDS[shown.kind](), title: shown.title })
}

/** "Where this came from"'s count: its conversations, then its sources when it has any. */
function whereItCameFromCount(request: Request): string {
  const conversations = request.conversations.length || 1
  const sources = request.evidence.length
  const conversationWords = interpolate(conversations === 1 ? t('{count} conversation') : t('{count} conversations'), { count: conversations })
  if (sources === 0) return conversationWords
  return `${conversationWords} · ${interpolate(sources === 1 ? t('{count} source') : t('{count} sources'), { count: sources })}`
}

/**
 * The longer of the two record lists ("N earlier records") scrolls in a box past 24rem: the drawer's first screen at
 * 1440×900 shows about 800px of panel, so the box takes under half of it and the panel's own scroll stays in reach.
 * The newest five are never boxed (c-request-detail-records: the mockup shows them whole).
 */
const EARLIER_RECORDS_BOX = 'max-h-96'

/**
 * Latest records (c-request-detail-records, c-ai-queue): each row has its mark at a fixed size (work a dot, a saved
 * memory a check, so the empty ring no longer reads as "not done"), its time in a monospace column at the left, its
 * words wrapping in full (the one-line cut is gone, so a row's whole text is always there, D b15 F308), and its kind as
 * a word in a small chip. A record's images are in the drawer's one image strip, so a row counts them instead of
 * drawing that strip a second time (c-obs-media F). A long list scrolls in its box, with a caption that says so (M312).
 */
function Records({ records, boxed = false }: { records: Request['granular']; boxed?: boolean }) {
  return (
    <QueueList className={boxed ? EARLIER_RECORDS_BOX : 'max-h-none'} scrollRegionLabel={t('Latest records')}
      overflowCaption={interpolate(t('{count} records · scroll to read them all'), { count: records.length })}>
      {records.map((record, index) => (
        // On a phone the kind chip goes under the words, so the words keep the row's width; in a box, rows step in
        // from its edge.
        <QueueItem key={`${index}-${record.text}`} data-record-kind={record.kind}
          className="grid grid-cols-[1rem_auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 rounded-none border-b border-border/70 px-0 py-2.5 last:border-b-0 hover:bg-transparent in-data-overflowing:px-2.5 sm:grid-cols-[1rem_auto_minmax(0,1fr)_auto]">
          <QueueItemIndicator completed={record.kind === 'memory'}
            className={cn('justify-self-center border-0', record.kind === 'memory' ? 'mt-0.5 flex size-3.5 items-center justify-center bg-muted-foreground text-card' : 'mt-1.5 size-2 bg-muted-foreground')}>
            {record.kind === 'memory' && <CheckIcon aria-hidden="true" className="size-2.5 stroke-3" />}
          </QueueItemIndicator>
          {/* 8.5ch: the longest short time the mapper writes, "12:59 pm", is 8 characters, each 1ch in the mono face, so
              8ch is exactly its width (66.5px of the column's 70.7px at the 17px root, measured); the half character
              keeps it on one line. A Chinese or Korean time is wider (its half-day word is two characters of about 1.7ch
              each) and wraps inside the column, whole: nothing in it is ever cut (fix round R4, request-card-parts test). */}
          <RecordedTime iso={record.atIso} words={record.at} form="time-or-day" className="mono-number w-[8.5ch] text-[0.8125rem] leading-5 text-muted-foreground" />
          <QueueItemContent className="text-sm leading-5 text-foreground/90">
            {record.text}
            {record.media && <> <MediaCountBadge media={record.media} /></>}
          </QueueItemContent>
          <Badge variant="outline" className="col-start-3 justify-self-start font-normal sm:col-start-auto sm:justify-self-auto">{record.kind === 'memory' ? t("memory") : t("work")}</Badge>
        </QueueItem>
      ))}
    </QueueList>
  )
}

/** The drawer is a Radix modal whose Escape closes it; while the image viewer inside it is open, Escape closes only the viewer. */
function keepDrawerOpenForGallery(event: KeyboardEvent) {
  if (event.target instanceof Element && event.target.closest('.obs-media-gallery')) event.preventDefault()
}

/**
 * What the person is told after a save, worded when it is shown, so it follows the page's language. `cause`: the raw
 * text behind a failed save (the worker's own words, or the browser's error), folded under Details (G17, fix round M1).
 */
type SaveNotice = { tone: 'saved' | 'problem'; words: () => string; cause?: string | null }

/**
 * The size of the drawer's decision buttons (Mark checked, Undo, Join, Keep separate): the Button's small size, 38px at
 * the desktop root and 44px on touch by its own rule, the sizes c-request-detail-check-action keeps.
 */
const DRAWER_ACTION_SIZE = 'sm'

/** Sentences joined by a space, leaving out the ones that do not apply. */
const sentences = (...parts: (string | false | null | undefined)[]) => parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** What the person is told after the worker answers a check (app.js `saveReview` toasts). */
function noticeFor(result: ReviewResult, checked: boolean, requestId: string, expectedFingerprint?: string): SaveNotice {
  switch (result.outcome) {
    case 'saved': {
      const latest = result.model.requests.find((request) => request.id === requestId)
      const review = latest?.review
      const shared = (result.save?.scope ?? review?.mode) === 'shared'
      const pending = result.save ? result.save.state === 'queued' : review?.pending
      if (shared && review?.conflict) return { tone: 'problem', words: () => sentences(
        t('Your review decision was saved here, but your viewers still have conflicting decisions. Read this version and choose again.'),
        pending && t('The saved decision is waiting to sync.')) }
      if (expectedFingerprint && latest?.contentFingerprint !== expectedFingerprint) return { tone: 'problem', words: () => sentences(
        t('Your review decision was saved for the version you read. The current work changed; review it again.'),
        shared && pending && t('The saved decision is waiting to sync.')) }
      if (shared) return { tone: 'saved', words: () => sentences(
        checked ? t('Checked for this shared version.') : t('Check undone for this shared version.'),
        pending && t('Saved here; waiting to sync to your other viewers.')) }
      if (result.model.sourceKind === 'cloud') return { tone: 'saved', words: () => checked
        ? t('Checked in your cloud viewer only. My Work sharing is off.') : t('Check undone in your cloud viewer only. My Work sharing is off.') }
      return { tone: 'saved', words: () => checked ? t(CHECKED_LOCALLY_MESSAGE) : t(CHECK_UNDONE_MESSAGE) }
    }
    // Nothing was saved: a plain sentence for each answer (M1), with the worker's own words, when it gave any, under Details.
    case 'changed-while-reading': return { tone: 'problem', words: () => t(CHANGED_WHILE_READING_MESSAGE), cause: result.serverMessage }
    case 'refused': return { tone: 'problem', words: () => t('Your review decision was not saved. The worker refused this version as it is.'), cause: result.serverMessage }
    case 'unavailable': return { tone: 'problem', words: () => t('Your review decision was not saved. Local work is unavailable right now.'), cause: result.serverMessage }
  }
}

/**
 * A save's outcome, short and plain at the body size (c-request-detail-check-action F: notices were 12px sentences). A
 * failed save is an alert (it was a quiet status); a saved one is a status. `focusRef`: where focus goes after a save
 * whose button went away with the block it was in (useOutcomeTakesFocusWhenFocusIsLost).
 */
function SaveNoticeLine({ notice, focusRef }: { notice: SaveNotice; focusRef?: Ref<HTMLDivElement> }) {
  return (
    <div ref={focusRef} tabIndex={focusRef ? -1 : undefined} role={notice.tone === 'problem' ? 'alert' : 'status'}
      className={cn('w-full space-y-1 rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50', notice.tone === 'problem' ? 'font-medium text-foreground' : 'text-muted-foreground')}>
      <p>{notice.words()}</p>
      {notice.cause && <FailureDetails cause={notice.cause} />}
    </div>
  )
}

/**
 * After a save in the drawer, where focus goes when the button pressed went away with the block it was in (a check, an
 * undo, a join): to the line that says what happened, `outcomeLine` (fix round Q2, V8). Focus left on the drawer's
 * panel, or the page, says it was lost: Radix gives the panel focus when the focused button leaves. A button that stays
 * (a refused save, a conflict that remains) keeps focus, and so does any place the owner moved to while it saved.
 */
function useOutcomeTakesFocusWhenFocusIsLost() {
  const outcomeLine = useRef<HTMLDivElement>(null)
  const [savesSettled, setSavesSettled] = useState(0)
  useEffect(() => {
    if (savesSettled === 0) return
    const focused = document.activeElement
    const focusIsLost = !focused || focused === document.body || focused.getAttribute('data-slot') === 'sheet-content'
    if (focusIsLost) outcomeLine.current?.focus()
  }, [savesSettled])
  return { outcomeLine, saveSettled: () => setSavesSettled((count) => count + 1) }
}

/**
 * Done, not checked: the drawer's one decision when the request is done and not checked (page-05, G1), with undo.
 * Checking saves this version as checked where the work came from and hands it back to you to ship; it never ships it.
 * The worker refuses a version that changed. After a check the block says when and where it was saved, with Undo beside
 * it (c-request-detail-check-action), and that line takes focus, since the pressed button went with the block it was in.
 * Mark checked is the orange button, with dark text on it (G1).
 */
function CheckAction({ request }: { request: Request }) {
  useI18n()
  const { mode } = useWorkspace()
  const { sourceKind, devices } = useWorkModel()
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<SaveNotice | null>(null)
  const { outcomeLine, saveSettled } = useOutcomeTakesFocusWhenFocusIsLost()
  const headingId = useId()
  // Resolves whether the save happened (fix round Q3): a decision saved with a caveat (the viewers still disagree, the
  // work changed while it was read, it waits to sync) is saved, and its button says "Saved"; the caveat is the notice
  // line's. Only a save that saved nothing (refused, unavailable, changed before it saved, no answer) resolves false.
  const save = async (checked: boolean) => {
    setSaving(true)
    let next: SaveNotice
    let saved = false
    try {
      // The version on screen is the one checked; the worker refuses any other.
      const result = await useStore.getState().setRequestChecked(request.id, checked, request.contentFingerprint, request.review?.hash)
      saved = result.outcome === 'saved'
      next = noticeFor(result, checked, request.id, request.contentFingerprint)
    } catch (error) {
      next = { tone: 'problem', words: () => t('Your review decision was not saved.'), cause: messageOf(error) }
    } finally {
      setSaving(false)
    }
    setNotice(next)
    saveSettled()
    return saved
  }
  // While one decision saves, the others wait with aria-disabled (G16), never natively disabled, which would drop focus
  // to the page: the pressed one keeps focus and says it is saving (aria-busy), its siblings wait (fix round Q5).
  const waits = saving || undefined
  const noticeLine = notice && <SaveNoticeLine notice={notice} focusRef={outcomeLine} />
  // A shared review the worker cannot offer yet, or whose viewers disagree: the drawer says so in the page's words; the
  // worker's own sentence about it (shared-reviews.mjs, English) is folded under Details, whole (G17, fix round R1).
  if (request.review?.available === false) return (
    <div role="status" className="space-y-1 rounded-xl border border-control-edge p-4 text-sm text-muted-foreground">
      <p>{t('This review is unavailable until the shared state is complete. Nothing was changed.')}</p>
      <FailureDetails cause={request.review.message} />
    </div>
  )
  if (request.review?.conflict) return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-control-edge p-4 text-sm">
      <div role="status" className="basis-full space-y-1">
        <p>{t('Your viewers recorded different review decisions. Read this version, then choose the decision to keep.')}</p>
        <FailureDetails cause={request.review.message} />
      </div>
      {request.state === 'needs-check' && <SaveButton className={buttonVariants({ size: DRAWER_ACTION_SIZE })} onClick={() => save(true)} aria-disabled={waits}><CheckIcon />{t('Mark checked')}</SaveButton>}
      <SaveButton className={buttonVariants({ variant: 'ghost', size: DRAWER_ACTION_SIZE })} onClick={() => save(false)} aria-disabled={waits}><Undo2Icon />{t('Keep unchecked')}</SaveButton>
      {noticeLine}
    </div>
  )
  if (request.state === 'needs-check') {
    return (
      <Req ids={['R6.2', 'R13.7']}>
        <section aria-labelledby={headingId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-xl border border-review-border bg-review p-4 text-sm">
          <div className="min-w-0 flex-1 basis-60 space-y-1">
            <h3 id={headingId} className="flex items-center gap-2 font-medium text-review-foreground"><StateMark state="needs-check" />{t(STATE_LABEL['needs-check'])}</h3>
            <p className="text-foreground">{t('Check the work, then mark this version checked. Checking never ships it.')}</p>
          </div>
          <SaveButton className={buttonVariants({ size: DRAWER_ACTION_SIZE })} onClick={() => save(true)} aria-disabled={waits}><CheckIcon />{t('Mark checked')}</SaveButton>
          {noticeLine}
        </section>
      </Req>
    )
  }
  if (!request.checkedAt) return noticeLine
  // Where the decision is saved, from the review as the worker has it now, so the words are the same right after the
  // check and after a reload (V8: right after it, the block said where and not when).
  const savedWhere = request.review?.mode === 'shared'
    ? request.review.pending ? t('Saved here; waiting to sync to your other viewers.') : t('Saved as a shared review decision.')
    : sourceKind === 'cloud' ? t('Saved in your cloud viewer only. My Work sharing is off.') : sourceKind !== 'sample' ? t('Saved on this machine only.') : mode === 'web' ? interpolate(t('Saved from the web · syncing to {count} machines (demonstration).'), { count: devices.length }) : t('Saved on this machine (demonstration).')
  return (
    <Req ids={['R6.2', 'R13.7']}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-xl border border-control-edge bg-surface p-4 text-sm">
        <div ref={outcomeLine} tabIndex={-1} role="status" className="min-w-0 flex-1 basis-60 space-y-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <p className="flex items-start gap-2 font-medium text-shipped-foreground"><CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="tabular">{interpolate(t('Checked {checkedAt}.'), { checkedAt: recordedTimeWords(request.checkedAtIso, request.checkedAt) })}</span></p>
          <p className="text-muted-foreground">{sentences(savedWhere, t('Shipping is still your call.'))}</p>
        </div>
        <SaveButton className={buttonVariants({ variant: 'outline', size: DRAWER_ACTION_SIZE })} onClick={() => save(false)} aria-disabled={waits}><Undo2Icon />{t('Undo')}</SaveButton>
        {notice?.tone === 'problem' && <SaveNoticeLine notice={notice} />}
      </div>
    </Req>
  )
}

/** The worker's id for a grouped request (request-projection.mjs): a suggestion names the other request by its group id. */
const groupedRequestId = (groupId: string) => JSON.stringify(['overall-request', groupId])

/** The judge's check score, 0 to 1, as a whole percent in the page's language ("70%", "70 %"). */
const confidencePercent = (confidence: number) => new Intl.NumberFormat(getLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(confidence)

/**
 * "May be part of another request" (c-request-detail-suggestion-action): a small label, the other request's title as
 * a link that opens it (when today's work has it), one plain sentence with the judge's confidence as a percent, and the
 * model's account folded under "How this was decided". Both buttons are neutral, so the drawer keeps one primary (G1).
 * Joining asks once more before it saves: the worker has no way to undo a join (its suggestions route takes join and
 * not-this only), so the question says so instead of an Undo. The question stays open while Join saves, so Join keeps
 * focus and shows "Saving…" then how it went in place; a failure stays in the question. Once a decision is saved the
 * suggestion goes, and its result line takes focus (fix round Q2).
 */
function SuggestionAction({ request }: { request: Request }) {
  useI18n()
  const { sourceKind, requests } = useWorkModel()
  const [saving, setSaving] = useState(false)
  const [confirmingJoin, setConfirmingJoin] = useState(false)
  const [notice, setNotice] = useState<SaveNotice | null>(null)
  const { outcomeLine, saveSettled } = useOutcomeTakesFocusWhenFocusIsLost()
  const headingId = useId()
  const confirmId = useId()
  const suggestion = request.suggestion
  const noticeLine = notice && <SaveNoticeLine notice={notice} focusRef={outcomeLine} />
  if (!suggestion) return noticeLine
  const suggested = requests.find((other) => other.id === groupedRequestId(suggestion.requestId))
  // Resolves whether the decision was saved (Q3): one saved while the viewers' grouping decisions still conflict is
  // saved, and its button says so; the notice line asks to choose again. A decision that did not save resolves false.
  const save = async (action: 'join' | 'not-this') => {
    // Keep separate is another decision than the question Join asks, so the question closes; Join's stays open.
    if (action === 'not-this') setConfirmingJoin(false)
    setSaving(true)
    try {
      const result = await useStore.getState().answerRequestSuggestion(suggestion, action)
      const shared = result.save?.scope === 'shared'
      const queued = result.save?.state === 'queued'
      const localCopyUpdating = result.save?.localMaterialization === 'pending'
      const conflict = result.model.requests.some((current) => current.suggestion?.conversationKey === suggestion.conversationKey && current.suggestion.sharedConflict)
      // Answered: the question closes, and the result line says what happened.
      setConfirmingJoin(false)
      if (conflict) {
        setNotice({ tone: 'problem', words: () => sentences(t('Your decision was saved here, but grouping decisions still conflict. Read this suggestion and choose again.'),
          shared && queued && t('The saved decision is waiting to sync.'), localCopyUpdating && t("This viewer's local work copy is still updating.")) })
        return true
      }
      setNotice({ tone: 'saved', words: () => sentences(action === 'join' ? t('Joined the request.') : t('Kept these requests separate.'),
        shared ? (queued ? t('Saved here; waiting to sync to your other viewers.') : t('Saved as a shared decision.'))
          : sourceKind === 'cloud' ? t('Saved in your cloud viewer only.') : t('Saved on this machine only.'),
        localCopyUpdating && t("This viewer's local work copy is still updating.")) })
      return true
    } catch (error) {
      setNotice({ tone: 'problem', words: () => t('Your grouping decision was not saved.'), cause: messageOf(error) })
      return false
    } finally {
      setSaving(false)
      saveSettled()
    }
  }
  // While a decision saves, the others wait with aria-disabled (G16, Q5), so the pressed one keeps focus.
  const waits = saving || undefined
  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-xl border border-control-edge p-4 text-sm">
      <h3 id={headingId} className="flex items-center gap-2 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">
        <GitMergeIcon aria-hidden="true" className="size-4 shrink-0" />{t('May be part of another request')}
      </h3>
      {suggestion.sharedConflict && <p>{t('Your viewers recorded different grouping decisions. Read this suggestion, then choose again to resolve them.')}</p>}
      <p className="flex items-start gap-2 text-base font-medium">
        <ArrowRightIcon aria-hidden="true" className="mt-1 size-4 shrink-0" />
        {/* The title wraps inside the section (V1): the Button base does not shrink, so the link says it may. */}
        {suggested
          ? <Button variant="link" className="h-auto min-w-0 shrink justify-start px-0 text-left text-base break-words whitespace-normal" onClick={() => useStore.getState().openRequestDrawer(suggested)}>{suggestion.requestTitle}</Button>
          : <span className="min-w-0 break-words">{suggestion.requestTitle}</span>}
      </p>
      {suggestion.confidence !== undefined && (
        <p className="text-muted-foreground tabular">{interpolate(t('Looks like a continuation of that request ({percent} confidence).'), { percent: confidencePercent(suggestion.confidence) })}</p>
      )}
      {suggestion.evidence && (
        <Collapsible>
          <CollapsibleFoldTrigger className="w-auto">{t('How this was decided')}</CollapsibleFoldTrigger>
          <CollapsibleContent><p className="mt-2 rounded-md bg-surface px-3 py-2 font-mono text-xs break-words text-foreground/80">{suggestion.evidence}</p></CollapsibleContent>
        </Collapsible>
      )}
      {/* The save buttons draw their icon in the slot they keep for the spinner and the check, so it is never an empty gap
          at rest (V12): Keep separate, two paths parting; Join, the merge mark this section's heading uses. */}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size={DRAWER_ACTION_SIZE} aria-expanded={confirmingJoin} aria-controls={confirmId} aria-disabled={waits}
          onClick={() => setConfirmingJoin((asking) => !asking)}>{t('Join that request')}</Button>
        <SaveButton className={buttonVariants({ variant: 'ghost', size: DRAWER_ACTION_SIZE })} icon={<SplitIcon />} onClick={() => save('not-this')} aria-disabled={waits}>{t('Keep separate')}</SaveButton>
      </div>
      <div id={confirmId} hidden={!confirmingJoin} className="space-y-2 rounded-lg border border-control-edge p-3">
        <p>{interpolate(t('Join this work into “{title}”? It can’t be undone from here.'), { title: suggestion.requestTitle })}</p>
        <div className="flex flex-wrap gap-2">
          <SaveButton className={buttonVariants({ variant: 'outline', size: DRAWER_ACTION_SIZE })} icon={<GitMergeIcon />} onClick={() => save('join')} aria-disabled={waits}>{t('Join')}</SaveButton>
          <Button variant="ghost" aria-disabled={waits} onClick={() => setConfirmingJoin(false)}>{t('Cancel')}</Button>
        </div>
        {/* A join that did not save: the question stays open, with why, beside the Join that keeps focus. */}
        {confirmingJoin && noticeLine}
      </div>
      {!confirmingJoin && noticeLine}
    </section>
  )
}

/**
 * Move to… (c-request-detail-move-to): puts the request in another area or Other, as the owner's placement (a refresh
 * never overrides it). A searchable list (G15, 31 areas on real data), grouped as the review drew it: the owner's kept
 * areas, then suggested ones, then Other, with a count. A second pick while one move is saving does nothing.
 */
function MoveTo({ request, changes }: { request: Request; changes: FocusChanges }) {
  useI18n()
  const { focusAreas } = useWorkModel()
  const current = resolveFocusAreaId(request.focusAreaId, focusAreas)
  const targets = focusAreas.filter((area) => isPlaceableFocusArea(area) && area.id !== current)
  // Nowhere to move it, or no conversation to file the move under: the worker would refuse, so there is no control.
  if (targets.length === 0 && current === OTHER_FOCUS_AREA_ID) return null
  if (request.canMoveFocus === false) return null
  const choice = (focusAreaId: string, name: string) => ({ value: focusAreaId, label: name, searchWords: [name] })
  const groups = [
    { heading: t('Your focus areas'), choices: targets.filter((area) => area.status === 'kept').map((area) => choice(area.id, area.name)) },
    { heading: t('Suggested'), choices: targets.filter((area) => area.status === 'suggested').map((area) => choice(area.id, area.name)) },
    { choices: current === OTHER_FOCUS_AREA_ID ? [] : [choice(OTHER_FOCUS_AREA_ID, t('Other'))] },
  ]
  const count = groups.reduce((sum, group) => sum + group.choices.length, 0)
  return (
    <Req ids={['R16.6']}>
      <SearchablePicker trigger={changes.saving ? t('Moving…') : t('Move to…')} groups={groups}
        onChoose={(focusAreaId) => { changes.apply({ action: 'move-request', requestId: request.id, focusAreaId }) }}
        searchPlaceholder={t('Find a focus area')} nothingFound={t('No focus area matches.')} cannotChoose={changes.saving}
        countLine={count === 1 ? interpolate(t('{count} area'), { count }) : interpolate(t('{count} areas · type to narrow'), { count })} />
    </Req>
  )
}

/**
 * Where the request sits (c-request-detail-move-to): a visible "Focus area" label (F 270), the area's link, Move to…,
 * and, under the row, the last move with Undo (focus-changes.tsx).
 */
function FocusAreaRow({ request, onOpenFocus }: { request: Request; onOpenFocus: (focusAreaId: string) => void }) {
  useI18n()
  // The shared save: a second pick while one move is saving does nothing, and the move shows with Undo.
  const changes = useFocusChanges(`request:${request.id}`)
  const labelId = useId()
  return (
    <div className="space-y-2">
      <div role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <span id={labelId} className="text-muted-foreground">{t('Focus area')}</span>
        <FocusAreaChip focusAreaId={request.focusAreaId} onOpen={onOpenFocus} />
        {/* Sample fixtures change in memory; live requests save as my-focus rows. */}
        <MoveTo request={request} changes={changes} />
      </div>
      <FocusChangeBar changes={changes} />
    </div>
  )
}

/**
 * The request drawer (page-05, §3). One Sheet whatever it shows (RequestDrawerSheet), so the panel and the focus inside
 * it stay put while the detail loads, and focus goes back to what opened it when it closes (F 344). Real requests come
 * as a compact summary; the drawer reads the detail when it opens, showing the page's shape meanwhile (D b18 M 373).
 */
export function RequestDetail({ request, onClose, onOpenFocus }: { request: Request | null; onClose: () => void; onOpenFocus: (focusAreaId: string) => void }) {
  useI18n()
  // The one detail read (lib/use-request-detail.ts): a newer version of the same request keeps the detail read before it
  // on screen while it loads, or with its failure if it fails, so the drawer stays as the owner left it. The same
  // component in the same place, so React keeps it. Its review actions act on that older version, the one on screen.
  // Keyed by the request, so another request starts afresh.
  const read = useRequestDetail(request)
  if (!request) return null
  const title = request.title ?? request.resolvesTo?.title ?? t('Untitled request')
  const summary = request.summary ?? request.resolvesTo?.summary
  return (
    <RequestDrawerSheet onClose={onClose} onEscapeKeyDown={keepDrawerOpenForGallery}>
      {read.loaded
        ? <LoadedRequestDetail key={request.id} request={read.loaded} onOpenFocus={onOpenFocus}
            newerVersionReadFailure={read.newerVersionReadFailure === null ? undefined : { message: read.newerVersionReadFailure, tryAgain: read.tryAgain }} />
        : read.failure
          ? <RequestDetailFailure title={title} summary={summary} cause={read.failure.message} waitedMs={read.failure.waitedMs ?? undefined} onTryAgain={read.tryAgain} />
          : <RequestDrawerLoading title={title} summary={summary} />}
    </RequestDrawerSheet>
  )
}

/** How long a failed read waited, in words: the slow-worker state said nothing of it (page-05 F timeout-feedback). */
function waitedWords(waitedMs: number): string {
  const seconds = Math.round(waitedMs / 1000)
  if (seconds < 1) return t('The worker answered in under a second.')
  return interpolate(seconds === 1 ? t('Waited {seconds} second for the worker.') : t('Waited {seconds} seconds for the worker.'), { seconds })
}

/**
 * The detail could not be read (G17): plain words, how long it waited, the raw cause folded under Details in monospace,
 * and Try again. The title and summary the card had stay above it.
 */
function RequestDetailFailure({ title, summary, cause, waitedMs, onTryAgain }: { title: string; summary?: string | null; cause: string; waitedMs?: number; onTryAgain: () => void }) {
  useI18n()
  return (
    <>
      <SheetHeader className="gap-3 border-b p-5 pr-14 md:p-6 md:pr-14">
        <SheetTitle className="text-xl leading-snug">{title}</SheetTitle>
        <SheetDescription>{summary ?? t('Request details')}</SheetDescription>
      </SheetHeader>
      <div className="p-5 md:p-6">
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t('Could not load this request’s details.')}</AlertTitle>
          <AlertDescription>
            {waitedMs !== undefined && <p className="tabular">{waitedWords(waitedMs)}</p>}
            <FailureDetails cause={cause} />
          </AlertDescription>
          <AlertAction><Button variant="outline" onClick={onTryAgain}>{t('Try again')}</Button></AlertAction>
        </Alert>
      </div>
    </>
  )
}

/**
 * The drawer's one decision (page-05, G1): the reply card when it is your move, Mark checked when it is done and not
 * checked, nothing otherwise. A layout choice, not a state shown in words.
 */
type DrawerPrimary = 'reply' | 'check' | 'none'

/** How Send looks for each of the drawer's decisions (V0): the one orange when the reply is the decision. */
const SEND_EMPHASIS_OF: Record<DrawerPrimary, SendEmphasis> = { reply: 'primary', check: 'outlined', none: 'once-words-are-typed' }

/**
 * The drawer's content, top to bottom (page-05's area decision, amended after the Phase 5 verify): the title, whole, with
 * its summary; the progress line with the focus area and Move to…; then the drawer's one primary card and the reply
 * card: when it is your move the reply card is the primary card, with the next step; when it is done and not checked,
 * Mark checked comes first and is the primary, and the reply card follows it; otherwise the reply card stands alone. The
 * reply card is right under the progress line for every request with a conversation, in every state, never in a fold,
 * and in the same place whatever the state, so a change of state never moves it or what is typed in it (fix round V0).
 * Then the join suggestion if any, and five folds, each with its count: Deliverables, Workstreams, Build story, Latest
 * records and "Where this came from", which lists each conversation (ConversationRow) with Open, Copy, its exchanges,
 * Stop and "Reply here". `newerVersionReadFailure`: the detail shown is an older version of this request, because
 * reading the newer one failed.
 */
function LoadedRequestDetail({ request, newerVersionReadFailure, onOpenFocus }: { request: Request; newerVersionReadFailure?: { message: string; tryAgain: () => void }; onOpenFocus: (focusAreaId: string) => void }) {
  useI18n()
  // Only the page this computer's worker serves can continue a conversation; the card shows nothing elsewhere.
  const canReply = useStore((state) => state.conversationContinuationSource() !== null) && request.conversations.length > 0
  // Reply on a card or the summary (G2): the reply box takes focus once its conversation is read (its worker read decides
  // whether it can be continued; if not, the line saying why takes focus). With no reply card ("Where this came from"
  // lists no conversation that this page can continue), that fold opens and its row takes focus: what the drawer shows.
  const replyAsked = useStore((state) => state.view.openRequest?.id === request.id && state.view.openRequest.replyAsked === true)
  const [chosenConversation, setChosenConversation] = useState<string | null>(null)
  const [focusReplyBox, setFocusReplyBox] = useState(replyAsked)
  const replyBoxFocused = useCallback(() => setFocusReplyBox(false), [])
  /** A Send from the reply card is on its way: "Reply here" waits, as the picker does (fix round L2, Q4). */
  const [replySending, setReplySending] = useState(false)
  const primary: DrawerPrimary = request.state === 'your-move' ? 'reply' : request.state === 'needs-check' ? 'check' : 'none'
  const nextStepInReplyCard = primary === 'reply' && canReply
  const hasNextStep = nextStepShown(request.next).kind !== 'missing'
  const title = request.title ?? request.resolvesTo?.title ?? t('Untitled request')
  const summary = request.summary ?? request.resolvesTo?.summary
  const started = recordedStart(request.startedAt)
  const recent = request.granular.slice(0, RECENT_RECORDS)
  const earlier = request.granular.slice(RECENT_RECORDS)
  const images = requestImages(request)
  /**
   * "Reply here" on a conversation's row: the reply card answers it, and its box takes focus. While a Send is on its way
   * it waits, so words on their way to one conversation never land in another's box, or go out to it a second time.
   */
  const replyHere = (conversation: Request['conversations'][number]) => {
    if (replySending) return
    setChosenConversation(conversationKey(conversation))
    setFocusReplyBox(true)
  }
  return (
    <>
      <Req ids={['R3.6', 'R3.2']}>
        {/* From md up the state and the title stay put while the panel scrolls (D b17 M 352). On a phone only the title
            bar and the close button stay, because a pinned header took a large share of a 390×844 screen. `contents`
            there lets the title bar stick to the panel itself, the scroll container; `shrink-0` keeps a long title whole
            inside it (a flex item with a min-height would otherwise shrink to that height). The title is never cut. */}
        <SheetHeader className="max-md:contents md:gap-3 md:border-b md:p-6">
          <div className="flex min-w-0 flex-wrap items-center gap-2 pr-10 max-md:pt-5 max-md:pr-14 max-md:pl-5"><StateBadge state={request.state} /><AgentIcon agentId={request.agentId} withDevice /></div>
          <div data-slot="request-title-bar" className="max-md:sticky max-md:top-0 max-md:z-10 max-md:flex max-md:min-h-15 max-md:shrink-0 max-md:items-center max-md:border-b max-md:bg-card max-md:py-2 max-md:pr-14 max-md:pl-5">
            <SheetTitle className="text-xl leading-snug">{title}</SheetTitle>
          </div>
        </SheetHeader>
      </Req>

      <div className="space-y-5 p-5 md:p-6">
        {newerVersionReadFailure && (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{t('Could not load the newest version of this request. This is the version read before it.')}</AlertTitle>
            <AlertDescription><FailureDetails cause={newerVersionReadFailure.message} /></AlertDescription>
            <AlertAction><Button variant="outline" onClick={newerVersionReadFailure.tryAgain}>{t('Try again')}</Button></AlertAction>
          </Alert>
        )}

        <div className="space-y-3">
          {/* The summary, whole: the drawer is the one place with room for all of it. */}
          {summary ? <SheetDescription className="text-[0.95rem]">{summary}</SheetDescription> : <SheetDescription className="sr-only">{t('Request details')}</SheetDescription>}
          {!nextStepInReplyCard && <NextMove next={request.next} className="text-[0.95rem]" />}
        </div>

        <div className="space-y-3">
          <ProgressMeter request={request} />
          <FocusAreaRow request={request} onOpenFocus={onOpenFocus} />
          {/* A shipped run's time is how long it took, never "Just started" (live/running-time.ts isFinishedRun, the List's
              rule); a start that is not recorded is a missing value, worded here. */}
          <p className="text-xs text-muted-foreground tabular">{started
            ? interpolate(t('Asked by {name} · started {time} · {duration} · {stage}'), { name: request.askedBy, time: recordedTimeWords(request.startedAtIso, started), duration: durationWords(request.runningForMs, request.runningFor, t, isFinishedRun(request.state)), stage: t(request.stage) })
            : interpolate(t('Asked by {name} · start not recorded · {duration} · {stage}'), { name: request.askedBy, duration: durationWords(request.runningForMs, request.runningFor, t, isFinishedRun(request.state)), stage: t(request.stage) })}</p>
        </div>

        {/* Done and not checked: Mark checked comes first and is the drawer's one primary. It stays here whatever the
            state, so its receipt after a check (with Undo) takes the place of the button pressed. */}
        <CheckAction key={request.id} request={request} />
        {canReply && (
          <section aria-label={primary === 'reply' ? t('Your move') : undefined} data-slot="reply-section" className="space-y-4 rounded-xl border border-control-edge bg-card p-4">
            {nextStepInReplyCard && hasNextStep && <NextMove next={request.next} className="text-[0.95rem]" />}
            <ConversationReplyCard conversations={request.conversations} chosenConversation={chosenConversation} onChooseConversation={setChosenConversation}
              focusBox={focusReplyBox} onBoxFocused={replyBoxFocused} sendEmphasis={SEND_EMPHASIS_OF[primary]} onSendingChange={setReplySending} />
          </section>
        )}
        <SuggestionAction key={`suggestion:${request.id}`} request={request} />
        <OpenFollowUps request={request} />

        {images && <ObsMediaStrip media={images} title={title} />}

        <div className="space-y-2">
          <Req ids={['R5.10', 'R5.12']}>
            <DrawerFold title={t('Deliverables')} count={deliverablesCount(request.workProduct)}>
              <DeliverableList products={request.workProduct} />
              <AddProductToReview request={request} />
            </DrawerFold>
          </Req>

          {request.workstreams.length > 0 && (
            <Req ids={['R3.4']}>
              <DrawerFold title={t('Workstreams')} count={workstreamsCount(request.workstreams)}>
                <div className="divide-y divide-border/70">
                  {request.workstreams.map((stream, index) => (
                    <Task key={`${index}-${stream.title}`} defaultOpen={false} className="py-0.5">
                      {/* A title or name that is not recorded is worded here, in the reader's language. */}
                      <TaskTrigger title={recordedWorkstreamTitle(stream.title) ?? t('Supporting work')} done={stream.tasks.filter((task) => task.done).length} total={stream.tasks.length} />
                      <TaskContent className="pb-3">
                        {openTasksFirst(stream.tasks).map((task, index) => <TaskItem key={`${index}-${task.name}`} done={task.done}>{recordedTaskName(task.name) ?? t('Untitled task')}</TaskItem>)}
                      </TaskContent>
                    </Task>
                  ))}
                </div>
              </DrawerFold>
            </Req>
          )}

          {(request.story.length > 0 || request.storyNarrative) && (
            <Req ids={['R7.2', 'R3.2']}>
              {/* A heading by role: the build story draws its own fold row (ai-elements/chain-of-thought.tsx). */}
              <ChainOfThought defaultOpen={false}>
                <div role="heading" aria-level={3}>
                  <ChainOfThoughtHeader count={request.story.length === 0 ? undefined : interpolate(request.story.length === 1 ? t('{count} step') : t('{count} steps'), { count: request.story.length })}>{t("Build story")}</ChainOfThoughtHeader>
                </div>
                <ChainOfThoughtContent>
                  {request.storyNarrative && <ChainOfThoughtSummary>{request.storyNarrative}</ChainOfThoughtSummary>}
                  {request.story.length > 0 && <ChainOfThoughtSteps steps={request.story} />}
                </ChainOfThoughtContent>
              </ChainOfThought>
            </Req>
          )}

          <Req ids={['R3.5']}>
            <DrawerFold title={t('Latest records')} count={request.granular.length === 0 ? undefined
              : interpolate(request.granular.length === 1 ? t('{count} record') : t('{count} records'), { count: request.granular.length })}>
              {recent.length === 0 ? <p className="text-sm text-muted-foreground">{t("No records yet.")}</p> : <Records records={recent} />}
              {earlier.length > 0 && <Disclosure label={interpolate(earlier.length === 1 ? t('{count} earlier record') : t('{count} earlier records'), { count: earlier.length })}><Records records={earlier} boxed /></Disclosure>}
            </DrawerFold>
          </Req>

          <Req ids={['R2.5', 'R2.2', 'R5.11']}>
            <DrawerFold title={t('Where this came from')} count={whereItCameFromCount(request)}
              defaultOpen={replyAsked && !canReply} focusOnOpen={replyAsked && !canReply}>
              <div className="space-y-4">
                {request.conversations.length === 0 && request.prompts.length === 0 && <p className="text-sm text-muted-foreground">{t("One conversation so far.")}</p>}
                {request.conversations.length > 0 && (
                  <div className="divide-y divide-border">
                    {request.conversations.map((conversation) => (
                      <div key={conversationKey(conversation)} className="py-3 first:pt-0">
                        <ConversationRow conversation={conversation} conversations={request.conversations} onReplyHere={canReply ? () => replyHere(conversation) : undefined}
                          replyHereWaits={replySending} />
                      </div>
                    ))}
                  </div>
                )}
                {request.prompts.map((prompt, index) => (
                  <blockquote key={`${index}-${prompt.at}`} className="border-l-2 pl-3 text-sm text-muted-foreground">“{prompt.quote}” {prompt.at !== TIME_NOT_RECORDED && <span className="text-xs tabular">{displayTime(prompt.at)}</span>}</blockquote>
                ))}
                {request.evidence.map((source) => (
                  <ProductLink key={source.href === '#' ? source.title : source.href} href={source.href} className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground"><FileTextIcon className="size-3.5" />{sourceRecordWords(source)}</ProductLink>
                ))}
              </div>
            </DrawerFold>
          </Req>
        </div>
      </div>
    </>
  )
}
