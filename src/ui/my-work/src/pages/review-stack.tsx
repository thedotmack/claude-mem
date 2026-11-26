import { useEffect, useRef, useState } from 'react'
import { BookmarkIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, HistoryIcon, MessageSquareIcon, RefreshCwIcon, SkipForwardIcon, UploadIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ReviewCard } from '@/components/review-stack-card'
import { ReviewHistory } from '@/components/review-stack-history'
import { ImportReviewCards } from '@/components/review-stack-import'
import { useI18n, interpolate } from '@/lib/i18n'
import { milestoneCrossed, reviewDeck, XP_PER_SEEN } from '@/live/review-stack-deck'
import { useReviewStack } from '@/live/use-review-stack'
import { REVIEW_STACK_MODES, REVIEW_STACK_MODE_LABELS, reviewStackFocusKey, type ReviewStackAction, type ReviewStackCard, type ReviewStackMode } from '../../../../shared/review-stack.ts'
import './review-stack.css'

export default function ReviewStack() {
  const { t } = useI18n()
  const { snapshot, saving, stale, error, refresh, write } = useReviewStack()
  const [mode, setMode] = useState<ReviewStackMode>('work')
  const [focus, setFocus] = useState('')
  const [browseId, setBrowseId] = useState('')
  const [revisit, setRevisit] = useState<ReadonlySet<string>>(new Set())
  const [guide, setGuide] = useState(false)
  const guideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [notice, setNotice] = useState('')
  const [undoGroup, setUndoGroup] = useState<string>()
  const [celebration, setCelebration] = useState(0)
  const [showHistory, setShowHistory] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [noteCard, setNoteCard] = useState<ReviewStackCard | null>(null)
  const [note, setNote] = useState('')
  useEffect(() => () => clearTimeout(guideTimer.current), [])

  if (!snapshot) return <section className="rounded-xl border bg-card p-5" aria-busy={!error}>
    <p role={error ? 'alert' : 'status'}>{error || t('Loading review cards…')}</p>
    {error && <Button className="mt-3" variant="outline" onClick={() => void refresh()}>{t('Try again')}</Button>}
  </section>

  const areas = new Map(snapshot.cards.map(card => [reviewStackFocusKey(card.focus), card.focus]))
  const area = areas.get(reviewStackFocusKey(focus)) ?? ''
  const deck = reviewDeck(snapshot, area, revisit)
  const browseIndex = Math.max(0, deck.cards.findIndex(card => card.id === browseId))
  const current = mode === 'work' ? deck.pending[0] : deck.cards[browseIndex]
  const bookmark = current && deck.bookmarks.get(current.id)
  const totalSeen = snapshot.reviews.filter(review => review.action === 'seen').length
  const disabled = saving || stale

  function switchMode(next: ReviewStackMode) {
    if (next === mode) return
    if (next === 'browse' && current) setBrowseId(current.id)
    setMode(next); setGuide(true); setNotice('')
    clearTimeout(guideTimer.current)
    guideTimer.current = setTimeout(() => setGuide(false), 2100)
  }
  function chooseArea(value: string) {
    setFocus(value); setBrowseId(''); setRevisit(new Set()); setUndoGroup(undefined); setNotice('')
  }
  function browse(step: number) {
    const card = deck.cards[Math.max(0, Math.min(deck.cards.length - 1, browseIndex + step))]
    if (card) setBrowseId(card.id)
  }
  function openNote(card: ReviewStackCard) { setNoteCard(card); setNote('') }

  async function apply(action: ReviewStackAction) {
    setNotice('')
    const result = await write(action)
    if (!result.saved) return false
    setUndoGroup(undefined)
    const next = result.next
    if (action.action === 'seen' || action.action === 'skip') {
      if (action.expectedReviewId) setRevisit(ids => { const rest = new Set(ids); rest.delete(action.expectedReviewId!); return rest })
      setNotice(action.action === 'seen' ? t('Marked as seen.') : t('Skipped for this pass.'))
    } else if (action.action === 'seen-group') {
      const group = next?.groups.find(entry => entry.id === result.eventId && entry.activeCount > 0)
      if (group) { setUndoGroup(group.id); setNotice(interpolate(t('{count} marked seen in {focus}.'), { count: group.count, focus: group.focus })) }
    } else if (action.action === 'bookmark') setNotice(action.saved ? t('Saved to review history.') : t('Bookmark removed.'))
    else if (action.action === 'follow-up') setNotice(t('Follow-up saved.'))
    else if (action.action === 'undo' || action.action === 'undo-group') setNotice(t('Returned to the review queue.'))
    else if (action.action === 'set-follow-up') setNotice(action.closed ? t('Follow-up completed.') : t('Follow-up reopened.'))
    if (next && (action.action === 'seen' || action.action === 'seen-group')) {
      const after = next.reviews.filter(review => review.action === 'seen').length
      if (after > totalSeen && (action.action === 'seen-group' || milestoneCrossed(totalSeen, after))) setCelebration(count => count + 1)
    }
    return true
  }
  function advance(action: 'seen' | 'skip') {
    if (!current) return
    void apply({ action, cardId: current.id, expectedReviewId: deck.reviews.get(current.id)?.id ?? null })
  }
  function seeGroup() { if (current) void apply({ action: 'seen-group', focus: current.focus }) }
  function toggleBookmark() {
    if (current) void apply({ action: 'bookmark', cardId: current.id, saved: !bookmark?.saved, revision: bookmark?.revision ?? 0 })
  }

  return <section className="review-stack space-y-4" aria-label={t('Review Stack')}>
    <div className="stack-toolbar">
      <div className="stack-modes" role="group" aria-label={t('Review mode')}>
        {REVIEW_STACK_MODES.map(value => <button key={value} type="button" aria-pressed={mode === value} disabled={saving} onClick={() => switchMode(value)}>{t(REVIEW_STACK_MODE_LABELS[value])}</button>)}
      </div>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" aria-expanded={showHistory} onClick={() => setShowHistory(value => !value)}><HistoryIcon aria-hidden="true" />{t('History')}</Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => setShowImport(true)}><UploadIcon aria-hidden="true" />{t('Import')}</Button>
        <Button size="icon-sm" variant="outline" disabled={saving} aria-label={t('Refresh review cards')} title={t('Refresh review cards')} onClick={() => void refresh()}><RefreshCwIcon aria-hidden="true" /></Button></div>
    </div>
    {guide && <p className="stack-guide" role="status">{mode === 'browse' ? t('Swipe left for the next card, right for the previous card.') : t('Swipe right for Seen. Hold for three seconds to mark the whole focus area seen.')}</p>}
    {error && <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3"><p role="alert">{error}</p><Button size="sm" variant="outline" onClick={() => void refresh()}>{t('Reload cards')}</Button></div>}
    {snapshot.cards.length > 0 && <>
      <div className="stack-toolbar"><label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">{t('Focus area')}
        <select className="stack-select" value={area} disabled={saving} onChange={event => chooseArea(event.target.value)}><option value="">{t('All focus areas')}</option>
          {Array.from(areas.values(), name => <option key={name} value={name}>{name}</option>)}</select></label>
        <div className="text-right text-sm"><p>{interpolate(t('{seen} of {total} seen'), { seen: deck.seen, total: deck.cards.length })}</p><p className="text-xs text-muted-foreground">{interpolate(t('{points} XP'), { points: totalSeen * XP_PER_SEEN })}</p></div>
      </div>
      <progress className="stack-progress" max={deck.cards.length || 1} value={deck.seen} aria-label={t('Cards seen in this focus area')} />
    </>}
    <div className="stack-feedback" role="status" aria-live="polite">{notice}
      {undoGroup && <Button size="sm" variant="outline" className="ml-2" disabled={disabled} onClick={() => void apply({ action: 'undo-group', groupId: undoGroup })}>{t('Undo group')}</Button>}
      {celebration > 0 && <span key={celebration} className="stack-confetti" aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</span>}
    </div>
    {current ? <>
      {mode === 'browse' && <div className="stack-toolbar"><Button size="sm" variant="outline" disabled={!browseIndex} onClick={() => browse(-1)}><ChevronLeftIcon aria-hidden="true" />{t('Previous')}</Button>
        <span className="text-sm">{interpolate(t('{position} of {total}'), { position: browseIndex + 1, total: deck.cards.length })}</span>
        <Button size="sm" variant="outline" disabled={browseIndex >= deck.cards.length - 1} onClick={() => browse(1)}>{t('Next')}<ChevronRightIcon aria-hidden="true" /></Button></div>}
      <ReviewCard card={current} mode={mode} disabled={disabled || showImport || !!noteCard} onSeen={() => advance('seen')} onGroup={seeGroup} onBrowse={browse}>
        {mode === 'work' && <div className="stack-actions">
          <Button data-review-seen disabled={disabled} aria-describedby="review-stack-hold-hint" onClick={() => advance('seen')}><CheckIcon aria-hidden="true" />{t('Seen')}</Button>
          <Button variant="outline" disabled={disabled} aria-pressed={!!bookmark?.saved} onClick={toggleBookmark}><BookmarkIcon aria-hidden="true" fill={bookmark?.saved ? 'currentColor' : 'none'} />{bookmark?.saved ? t('Saved') : t('Save')}</Button>
          <Button variant="outline" disabled={disabled} onClick={() => openNote(current)}><MessageSquareIcon aria-hidden="true" />{t('Follow up')}</Button>
          <Button variant="ghost" disabled={disabled} onClick={() => advance('skip')}><SkipForwardIcon aria-hidden="true" />{t('Skip for now')}</Button>
          <p id="review-stack-hold-hint" className="col-span-full text-center text-xs text-muted-foreground">{interpolate(t('Swipe right for Seen. Hold for 3s to mark {focus} seen.'), { focus: current.focus })}</p>
        </div>}
      </ReviewCard>
    </> : <div className="stack-empty"><h2 className="text-lg font-semibold">{snapshot.cards.length ? t('You’ve reached the end of this stack.') : t('Your Review Stack is empty.')}</h2>
      {snapshot.cards.length ? <div className="flex flex-wrap justify-center gap-2">{deck.skipped.length > 0 && <Button variant="outline" onClick={() => setRevisit(new Set(deck.skipped))}>{interpolate(t('Revisit {count} skipped'), { count: deck.skipped.length })}</Button>}
        <Button variant="outline" onClick={() => switchMode('browse')}>{t('Browse all cards')}</Button></div>
        : <><p>{t('Ask your agent to add deliverables to your Review Stack, or import an existing deck.')}</p><Button onClick={() => setShowImport(true)}>{t('Import cards')}</Button></>}
    </div>}
    {showHistory && <ReviewHistory snapshot={snapshot} focus={area} disabled={disabled} onAction={action => void apply(action)} onNote={openNote}
      onOpen={card => { switchMode('browse'); setBrowseId(card.id); setShowHistory(false) }} />}
    {showImport && <ImportReviewCards close={() => setShowImport(false)} onImported={() => void refresh()} />}
    {noteCard && <Dialog open onOpenChange={open => { if (!open && !saving) setNoteCard(null) }}>
      <DialogContent hasUnsavedText={!!note.trim()} showCloseButton={!saving} aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{t('Follow up')}</DialogTitle></DialogHeader><p className="font-medium" dir="auto">{noteCard.title}</p>
        <form className="space-y-3" onSubmit={async event => {
          event.preventDefault(); const body = note.trim()
          if (body && await apply({ action: 'follow-up', cardId: noteCard.id, body })) setNoteCard(null)
        }}><label className="block space-y-1"><span>{t('What should happen next?')}</span>
          <textarea autoFocus required maxLength={4000} disabled={saving} value={note} onChange={event => setNote(event.target.value)} rows={4} className="block w-full rounded-lg border bg-background p-3" /></label>
          {error && <p role="alert" className="text-destructive">{error}</p>}<Button disabled={disabled || !note.trim()} type="submit">{t('Save follow-up')}</Button>
        </form>
      </DialogContent>
    </Dialog>}
  </section>
}
