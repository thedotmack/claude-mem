// Sharing one focus area as a page people and agents comment on (§17): the dialog behind the area menu's Share…,
// and the Shared mark beside the area's name. The worker signs every call to cmem.ai.
import { useCallback, useEffect, useState } from 'react'
import { BotIcon, CheckIcon, CopyIcon, ExternalLinkIcon, Link2Icon, UserIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Req } from '@/spec/req'
import type { FocusArea } from '@/data'
import { useWorkModel } from '@/store'
import { loadFocusShares, postFocusShareComment, readFocusShareComments, shareFocusArea, stopSharingFocusArea, useFocusShares, type FocusShareComment } from '@/live/focus-shares'

/** How often an open dialog re-reads the comments and when the page last updated. */
const COMMENTS_REFRESH_MS = 20_000
const COMMENT_MAX_CHARS = 4000

function ago(iso: string | null, now: number): string {
  if (!iso) return 'not yet'
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
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

/** Beside the area's name while it is shared. */
export function SharedMark({ focusAreaId, onOpen }: { focusAreaId: string; onOpen: () => void }) {
  const { shares } = useFocusShares()
  if (!shares[focusAreaId]) return null
  return (
    <Req ids={['R17.1']}>
      <button type="button" onClick={onOpen} className="inline-flex min-h-11 items-center sm:min-h-0" aria-label="Shared by link: open sharing">
        <Badge variant="outline" className="gap-1 font-normal"><Link2Icon className="size-3" />Shared</Badge>
      </button>
    </Req>
  )
}

function Comment({ comment }: { comment: FocusShareComment }) {
  return (
    <li className="space-y-1 rounded-lg border bg-card px-3 py-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        {comment.authorKind === 'agent' ? <BotIcon className="size-3.5" /> : <UserIcon className="size-3.5" />}
        <span className="font-medium text-foreground">{comment.authorKind === 'agent' ? `${comment.agentName}, agent for ${comment.authorName}` : comment.authorName}</span>
        {comment.isOwner && <span>· you</span>}
        <time dateTime={comment.createdAt}><Ago at={comment.createdAt} /></time>
      </p>
      <p className="text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{comment.body}</p>
    </li>
  )
}

function Comments({ focusAreaId }: { focusAreaId: string }) {
  const [comments, setComments] = useState<FocusShareComment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const read = await readFocusShareComments(focusAreaId)
      setComments(read)
      setError(null)
    } catch (reason) {
      setError((reason as Error).message)
    }
  }, [focusAreaId])

  // Reads the comments now and every few seconds while the dialog is open (cmem.ai is the outside system here).
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => void refresh(), COMMENTS_REFRESH_MS)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [refresh])

  async function post() {
    if (!draft.trim() || posting) return
    setPosting(true)
    try {
      await postFocusShareComment(focusAreaId, draft.trim())
      setDraft('')
      await refresh()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setPosting(false)
    }
  }

  return (
    <Req ids={['R17.2']}>
      <section className="space-y-2" aria-label="Comments">
        <h3 className="text-xs font-medium text-muted-foreground">Comments{comments ? ` · ${comments.length}` : ''}</h3>
        {comments === null && !error && <p className="text-sm text-muted-foreground">Reading comments…</p>}
        {comments?.length === 0 && <p className="text-sm text-muted-foreground">No comments yet. People comment on the page; agents comment through the cmem.ai MCP server with the link.</p>}
        {!!comments?.length && (
          <ol className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {comments.map((comment) => <Comment key={comment.id} comment={comment} />)}
          </ol>
        )}
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        <div className="space-y-2">
          <Textarea aria-label="Answer as yourself" placeholder="Answer as yourself" value={draft} maxLength={COMMENT_MAX_CHARS} onChange={(event) => setDraft(event.target.value)} rows={2} />
          <div className="flex justify-end">
            <Button size="sm" className="h-11 sm:h-8" disabled={posting || !draft.trim()} onClick={() => void post()}>{posting ? 'Posting…' : 'Comment'}</Button>
          </div>
        </div>
      </section>
    </Req>
  )
}

/** Share… from the area menu: share by link, copy it, read and answer comments, stop sharing. */
export function ShareFocusDialog({ area, open, onOpenChange }: { area: FocusArea; open: boolean; onOpenChange: (open: boolean) => void }) {
  const model = useWorkModel()
  const { loaded, connected, shares } = useFocusShares()
  const share = shares[area.id]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const live = model.sourceKind === 'local'

  // While the dialog is open, "Updated … ago" and any failed update come from the worker, which keeps publishing.
  useEffect(() => {
    if (!open || !live) return
    const first = setTimeout(() => void loadFocusShares(), 0)
    const timer = setInterval(() => void loadFocusShares(), COMMENTS_REFRESH_MS)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [open, live])

  function openChange(next: boolean) {
    if (!next) { setError(null); setConfirmStop(false); setCopied(false) }
    onOpenChange(next)
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try { await action() } catch (reason) { setError((reason as Error).message) } finally { setBusy(false) }
  }

  async function copy() {
    if (!share) return
    try { await navigator.clipboard.writeText(share.url); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setError('Could not copy. Select the link and copy it.') }
  }

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Share “{area.name}”</DialogTitle>
          <DialogDescription>A page of this area that people and agents can read and comment on.</DialogDescription>
        </DialogHeader>

        {!live ? (
          <p className="text-sm text-muted-foreground">Sharing works on your live work. This is the sample.</p>
        ) : !loaded ? (
          <p className="text-sm text-muted-foreground">Checking…</p>
        ) : !share && !connected ? (
          <p className="text-sm">Sharing needs cloud sync, so the page can live at cmem.ai. Connect cmem.ai from Setup, then share.</p>
        ) : !share ? (
          <Req ids={['R17.1', 'R17.3']}>
            <div className="space-y-3">
              <ul className="list-disc space-y-1.5 pl-5 text-sm">
                <li>Anyone with the link can read it. To comment, people sign in at cmem.ai, and agents use the cmem.ai MCP server.</li>
                <li>It shows only this area: its requests, where each stands, and what is next. Nothing from your other areas or Other.</li>
                <li>It keeps up: a request you place in this area shows up, and one you move out leaves. It keeps updating while claude-mem runs on this computer, even with My Work closed.</li>
                <li>Your own words, prompts, transcripts, files and machine names stay here.</li>
              </ul>
              <Button className="h-11 w-full sm:h-9" disabled={busy} onClick={() => void run(() => shareFocusArea(area.id))}>
                <Link2Icon />{busy ? 'Sharing…' : 'Share this area'}
              </Button>
            </div>
          </Req>
        ) : (
          <div className="space-y-4">
            <Req ids={['R17.1']}>
              <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                  <p className="min-w-0 flex-1 truncate font-mono text-xs select-all">{share.url}</p>
                  <Button variant="ghost" size="sm" className="h-11 w-11 shrink-0 sm:h-8 sm:w-8" aria-label="Copy link" onClick={() => void copy()}>{copied ? <CheckIcon /> : <CopyIcon />}</Button>
                  <Button variant="ghost" size="sm" className="h-11 w-11 shrink-0 sm:h-8 sm:w-8" aria-label="Open the page" asChild>
                    <a href={share.url} target="_blank" rel="noreferrer"><ExternalLinkIcon /></a>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Updated <Ago at={share.publishedAt} />. Only this area’s requests are on it.</p>
                {share.publishError && <p className="text-xs text-destructive" role="alert">Last update didn’t go through: {share.publishError}</p>}
              </div>
            </Req>
            <Comments focusAreaId={area.id} />
            <Req ids={['R17.4']}>
              <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-3">
                {confirmStop && <p className="mr-auto text-xs text-muted-foreground">The link stops working for everyone.</p>}
                <Button variant={confirmStop ? 'destructive' : 'ghost'} size="sm" className="h-11 sm:h-8" disabled={busy}
                  onClick={() => confirmStop ? void run(() => stopSharingFocusArea(area.id)) : setConfirmStop(true)}>
                  {confirmStop ? 'Stop sharing' : 'Stop sharing…'}
                </Button>
              </div>
            </Req>
          </div>
        )}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}
