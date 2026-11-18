import { interpolate, t, useI18n } from '@/lib/i18n'
// Sharing one focus area as a page people and agents comment on (§17, c-share-focus): the dialog behind the area menu's
// Share… and the header's Sharing row, and the Shared mark beside the area's name. The worker signs every call to
// cmem.ai.
import { useCallback, useEffect, useId, useState } from 'react'
import { BotIcon, CheckIcon, CopyIcon, ExternalLinkIcon, EyeIcon, Link2Icon, LockIcon, RefreshCwIcon, UserIcon, XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Req } from '@/spec/req'
import type { FocusArea } from '@/data'
import { useWorkModel } from '@/store'
import { FailureDetails } from './bits'
import { sentenceWith } from '@/lib/sentence-with'
import {
  focusSharesAreADemonstration, loadFocusShares, postFocusShareComment, readFocusShareComments, shareFocusArea, stopSharingFocusArea,
  useFocusShareCommentCount, useFocusShares, type FocusShareComment,
} from '@/live/focus-shares'

/** How often an open dialog re-reads the comments and when the page last updated. */
const COMMENTS_REFRESH_MS = 20_000
const COMMENT_MAX_CHARS = 4000

function ago(iso: string | null, now: number): string {
  if (!iso) return t('not yet')
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return t('just now')
  if (minutes < 60) return interpolate(t('{minutes} min ago'), { minutes })
  const hours = Math.round(minutes / 60)
  return hours < 48 ? interpolate(t('{hours} h ago'), { hours }) : interpolate(t('{days} days ago'), { days: Math.round(hours / 24) })
}

/** "5 min ago", kept current while it is on screen. */
function Ago({ at }: { at: string | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return <>{ago(at, now)}</>
}

/** "2 comments" in the reader's language: one key per count form, as the catalogs have no plural mechanism. */
const commentsWords = (count: number) => count === 1 ? t('1 comment') : interpolate(t('{count} comments'), { count })

/**
 * Whether sharing works on this page: on the person's own work, which the worker serves, and in the sample's sharing
 * demonstration (`?source=sample&sample-state=area-shared`), which writes nothing.
 */
function useSharingWorksHere(): boolean {
  return useWorkModel().sourceKind === 'local' || focusSharesAreADemonstration()
}

/**
 * Beside the area's name while it is shared, with the number of comments on its page once a read has counted them
 * (c-share-focus M3). Its name stays "Shared by link: open sharing" (the review's Keep); the count is its description.
 * 44px on touch through the Button's own rule.
 */
export function SharedMark({ focusAreaId, onOpen }: { focusAreaId: string; onOpen: () => void }) {
  useI18n()
  const { shares } = useFocusShares()
  const shared = !!shares[focusAreaId]
  const works = useSharingWorksHere()
  const count = useFocusShareCommentCount(focusAreaId, shared && works)
  const countId = useId()
  if (!shared) return null
  return (
    <Req ids={['R17.1']}>
      <Button variant="bare" data-shared-mark="" onClick={onOpen} className="w-auto rounded-md" aria-label={t('Shared by link: open sharing')} aria-describedby={count === null ? undefined : countId}>
        <Badge variant="outline" className="gap-1 font-normal">
          <Link2Icon aria-hidden="true" className="size-3" />
          {/* One sentence for "Shared" and its count, the same one the Sharing row says (SharingFold). */}
          <span>{count === null ? t('Shared') : sentenceWith(t('Shared · {comments}'), 'comments', <span id={countId} className="tabular">{commentsWords(count)}</span>)}</span>
        </Badge>
      </Button>
    </Req>
  )
}

/**
 * Sharing in the area's header, folded to one line (c-focus-header M4): whether the area is shared, with its comment
 * count, and opened, one line and the way into the sharing dialog.
 */
export function SharingFold({ focusAreaId, onOpenSharing }: { focusAreaId: string; onOpenSharing: () => void }) {
  useI18n()
  const { loaded, shares, commentCounts } = useFocusShares()
  const works = useSharingWorksHere()
  const shared = !!shares[focusAreaId]
  const count = commentCounts[focusAreaId]
  // The row says nothing it does not know: not until the worker answers which areas are shared, and nothing at all on a
  // page where sharing is never read (the cloud copy, plain sample data), where "Not shared" would be a guess.
  const state = !works || !loaded ? null : shared ? (count === undefined ? t('Shared') : interpolate(t('Shared · {comments}'), { comments: commentsWords(count) })) : t('Not shared')
  return (
    <Req ids={['R17.1']}>
      <Collapsible data-sharing-fold="">
        <CollapsibleFoldTrigger count={state}>{t('Sharing')}</CollapsibleFoldTrigger>
        <CollapsibleContent className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 pt-2 pb-1 text-sm">
          <p className="min-w-0 flex-1 basis-64 text-muted-foreground">{shared ? t('Anyone with the link can read this area’s page and comment on it.') : t('A page of this area that people and agents can read and comment on.')}</p>
          <Button variant="outline" size="sm" onClick={onOpenSharing}><Link2Icon />{shared ? t('Open sharing') : t('Share…')}</Button>
        </CollapsibleContent>
      </Collapsible>
    </Req>
  )
}

/** Who wrote a comment: a person by name, or an agent with the person it answers for. */
const commentAuthor = (comment: FocusShareComment) => comment.authorKind === 'agent'
  ? interpolate(t('{agent}, agent for {person}'), { agent: comment.agentName ?? t('Agent'), person: comment.authorName })
  : comment.authorName

function Comment({ comment }: { comment: FocusShareComment }) {
  return (
    <li className="space-y-1 rounded-lg border border-control-edge/55 bg-card px-3 py-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        {comment.authorKind === 'agent' ? <BotIcon aria-hidden="true" className="size-3.5" /> : <UserIcon aria-hidden="true" className="size-3.5" />}
        <span className="font-medium text-foreground">{commentAuthor(comment)}</span>
        {comment.isOwner && <span>{t("· you")}</span>}
        <time dateTime={comment.createdAt} className="tabular"><Ago at={comment.createdAt} /></time>
      </p>
      <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{comment.body}</p>
    </li>
  )
}

/**
 * The page's comments, in the dialog's one scroll (c-share-focus F5: they scrolled in a 288px box inside the scrolling
 * dialog), and the box to answer, with its label on screen (F4). A read that fails says so in plain words, the reason
 * under Details, with Try again; the reads every COMMENTS_REFRESH_MS go on as before (F6).
 */
function Comments({ focusAreaId }: { focusAreaId: string }) {
  const [comments, setComments] = useState<FocusShareComment[] | null>(null)
  const [readFailure, setReadFailure] = useState<string | null>(null)
  const [postFailure, setPostFailure] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const boxId = useId()

  const refresh = useCallback(async () => {
    try {
      const read = await readFocusShareComments(focusAreaId)
      setComments(read)
      setReadFailure(null)
    } catch (reason) {
      setReadFailure((reason as Error).message)
    }
  }, [focusAreaId])

  // Reads the comments now and every few seconds while the dialog is open (cmem.ai is the outside system here).
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => void refresh(), COMMENTS_REFRESH_MS)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [refresh])

  const readAgain = async () => {
    setReading(true)
    try { await refresh() } finally { setReading(false) }
  }

  async function post() {
    if (!draft.trim() || posting) return
    setPosting(true)
    setPostFailure(null)
    try {
      await postFocusShareComment(focusAreaId, draft.trim())
      setDraft('')
      await refresh()
    } catch (reason) {
      setPostFailure((reason as Error).message)
    } finally {
      setPosting(false)
    }
  }

  return (
    <Req ids={['R17.2']}>
      <section className="space-y-2" aria-label={t("Comments")}>
        <h3 className="text-xs font-medium text-muted-foreground">{t("Comments")}{comments ? <span className="tabular">{` · ${comments.length}`}</span> : ''}</h3>
        {comments === null && !readFailure && <p className="text-sm text-muted-foreground">{t("Reading comments…")}</p>}
        {comments?.length === 0 && <p className="text-sm text-muted-foreground">{t("No comments yet. People comment on the page; agents comment through the cmem.ai MCP server with the link.")}</p>}
        {!!comments?.length && (
          <ol data-share-comments="" className="space-y-2">
            {comments.map((comment) => <Comment key={comment.id} comment={comment} />)}
          </ol>
        )}
        {readFailure && (
          <div role="alert" data-comments-read-failure="" className="space-y-2 rounded-lg border border-control-edge/55 p-3">
            {/* "The ones shown" only while some are: with none on screen, the failure alone. */}
            <p className="text-sm">{comments?.length ? t('Could not read the comments. The ones shown are from the last read.') : t('Could not read the comments.')}</p>
            <FailureDetails cause={readFailure} />
            <Button variant="outline" size="sm" busy={reading} busyLabel={t('Reading…')} onClick={() => void readAgain()}><RefreshCwIcon />{t('Try again')}</Button>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor={boxId}>{t("Answer as yourself")}</Label>
          <Textarea id={boxId} value={draft} maxLength={COMMENT_MAX_CHARS} onChange={(event) => setDraft(event.target.value)} rows={2} />
          {postFailure && (
            <div role="alert" className="space-y-1 text-sm">
              <p>{t('The comment was not posted.')}</p>
              <FailureDetails cause={postFailure} />
            </div>
          )}
          <div className="flex justify-end">
            <Button size="sm" variant="outline" busy={posting} busyLabel={t("Posting…")} aria-disabled={!draft.trim() || undefined} onClick={() => void post()}>{t("Comment")}</Button>
          </div>
        </div>
      </section>
    </Req>
  )
}

/** What a sharing call that failed did not do, in plain words; the reason goes under Details (G17). */
type SharingCall = 'share' | 'stop' | 'copy'
const SHARING_FAILURE_WORDS: Record<SharingCall, () => string> = {
  share: () => t('The area was not shared.'),
  stop: () => t('Sharing did not stop.'),
  copy: () => t('Could not copy. Select the link and copy it.'),
}

/**
 * Share… from the area menu (c-share-focus): what goes on the page and what stays here in two columns, then the words
 * on who can read it, Cancel beside "Share this area" (the dialog's one orange); once shared, the link with Copy and
 * Open, the comments, and Stop sharing. A failed call says so in plain words, its reason under Details.
 */
export function ShareFocusDialog({ area, open, onOpenChange }: { area: FocusArea; open: boolean; onOpenChange: (open: boolean) => void }) {
  useI18n()
  const live = useSharingWorksHere()
  const { loaded, connected, shares } = useFocusShares()
  const share = shares[area.id]
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ call: SharingCall; cause: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)

  // While the dialog is open, "Updated … ago" and any failed update come from the worker, which keeps publishing.
  useEffect(() => {
    if (!open || !live) return
    const first = setTimeout(() => void loadFocusShares(), 0)
    const timer = setInterval(() => void loadFocusShares(), COMMENTS_REFRESH_MS)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [open, live])

  function openChange(next: boolean) {
    if (!next) { setFailure(null); setConfirmStop(false); setCopied(false) }
    onOpenChange(next)
  }

  async function run(call: SharingCall, action: () => Promise<unknown>) {
    setBusy(true)
    setFailure(null)
    try { await action() } catch (reason) { setFailure({ call, cause: (reason as Error).message }) } finally { setBusy(false) }
  }

  async function copy() {
    if (!share) return
    try { await navigator.clipboard.writeText(share.url); setCopied(true) }
    catch (reason) { setFailure({ call: 'copy', cause: (reason as Error).message }) }
  }

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{interpolate(t('Share “{name}”'), { name: area.name })}</DialogTitle>
          <DialogDescription>{t("A page of this area that people and agents can read and comment on.")}</DialogDescription>
        </DialogHeader>

        {!live ? (
          <p className="text-sm text-muted-foreground">{t("Sharing works on your live work. This is the sample.")}</p>
        ) : !loaded ? (
          <p className="text-sm text-muted-foreground">{t("Checking…")}</p>
        ) : !share && !connected ? (
          <p className="text-sm">{t("Sharing needs cloud sync, so the page can live at cmem.ai. Connect cmem.ai from Setup, then share.")}</p>
        ) : !share ? (
          <Req ids={['R17.1', 'R17.3']}>
            <div className="space-y-4">
              <div data-share-columns="" className="grid gap-4 sm:grid-cols-2">
                <section aria-labelledby={`${area.id}-on-the-page`} className="space-y-2">
                  <h3 id={`${area.id}-on-the-page`} className="flex items-center gap-2 text-sm font-medium"><EyeIcon aria-hidden="true" className="size-4" />{t('On the page')}</h3>
                  <ul className="space-y-1.5 text-sm">
                    {[t('This area’s requests'), t('Where each one stands'), t('What is next')].map((item) => (
                      <li key={item} className="flex items-start gap-2"><CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />{item}</li>
                    ))}
                  </ul>
                </section>
                <section aria-labelledby={`${area.id}-stays-here`} className="space-y-2 sm:border-l sm:border-border sm:pl-4">
                  <h3 id={`${area.id}-stays-here`} className="flex items-center gap-2 text-sm font-medium"><LockIcon aria-hidden="true" className="size-4" />{t('Stays here')}</h3>
                  <ul className="space-y-1.5 text-sm">
                    {[t('Your own words and prompts'), t('Transcripts and files'), t('Machine names'), t('Your other areas and Other')].map((item) => (
                      <li key={item} className="flex items-start gap-2"><XIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />{item}</li>
                    ))}
                  </ul>
                </section>
              </div>
              <p className="text-sm text-muted-foreground">{t("Anyone with the link can read it. To comment, people sign in at cmem.ai, and agents use the cmem.ai MCP server.")}</p>
              <p className="text-sm text-muted-foreground">{t("It keeps up: a request you place in this area shows up, and one you move out leaves. It keeps updating while claude-mem runs on this computer, even with My Work closed.")}</p>
              {failure && <SharingFailure call={failure.call} cause={failure.cause} />}
              <DialogFooter showCloseButton>
                <Button busy={busy} busyLabel={t('Sharing…')} onClick={() => void run('share', () => shareFocusArea(area.id))}><Link2Icon />{t("Share this area")}</Button>
              </DialogFooter>
            </div>
          </Req>
        ) : (
          <div className="space-y-4">
            <Req ids={['R17.1']}>
              <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-lg border border-control-edge/55 bg-muted/40 px-3 py-1">
                  <p className="min-w-0 flex-1 truncate font-mono text-xs select-all">{share.url}</p>
                  <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={t("Copy link")} onClick={() => void copy()}>{copied ? <CheckIcon /> : <CopyIcon />}</Button>
                  <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={t("Open the page")} asChild>
                    <a href={share.url} target="_blank" rel="noreferrer"><ExternalLinkIcon /></a>
                  </Button>
                </div>
                <span role="status" className="sr-only">{copied ? t('Copied') : ''}</span>
                <p className="text-xs text-muted-foreground">{interpolate(t('Updated {ago}. Only this area’s requests are on it.'), { ago: ago(share.publishedAt, Date.now()) })}</p>
                {share.publishError && (
                  <div role="alert" className="space-y-1 text-xs">
                    <p>{t('The page’s last update didn’t go through.')}</p>
                    <FailureDetails cause={share.publishError} />
                  </div>
                )}
              </div>
            </Req>
            <Comments focusAreaId={area.id} />
            {failure && <SharingFailure call={failure.call} cause={failure.cause} />}
            <Req ids={['R17.4']}>
              <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
                {confirmStop && <p className="mr-auto text-xs text-muted-foreground">{t("The link stops working for everyone.")}</p>}
                <Button variant={confirmStop ? 'destructive' : 'ghost'} size="sm" busy={busy && confirmStop}
                  onClick={() => confirmStop ? void run('stop', () => stopSharingFocusArea(area.id)) : setConfirmStop(true)}>
                  {confirmStop ? t("Stop sharing") : t("Stop sharing…")}
                </Button>
              </div>
            </Req>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function SharingFailure({ call, cause }: { call: SharingCall; cause: string }) {
  return (
    <div role="alert" className="space-y-1 text-sm">
      <p>{SHARING_FAILURE_WORDS[call]()}</p>
      <FailureDetails cause={cause} />
    </div>
  )
}
