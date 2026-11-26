import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useI18n, interpolate } from '@/lib/i18n'
import { REVIEW_STACK_VERDICT_LABELS, reviewStackFocusKey, type ReviewStackAction, type ReviewStackCard, type ReviewStackSnapshot } from '../../../../shared/review-stack.ts'

export function ReviewHistory({ snapshot, focus, disabled, onAction, onNote, onOpen }: {
  snapshot: ReviewStackSnapshot; focus: string; disabled: boolean; onAction: (action: ReviewStackAction) => void
  onNote: (card: ReviewStackCard) => void; onOpen: (card: ReviewStackCard) => void
}) {
  const { t } = useI18n()
  const [savedOnly, setSavedOnly] = useState(false)
  const [limit, setLimit] = useState(32)
  const reviews = useMemo(() => new Map(snapshot.reviews.map(review => [review.cardId, review])), [snapshot.reviews])
  const bookmarks = useMemo(() => new Map(snapshot.bookmarks.map(mark => [mark.cardId, mark])), [snapshot.bookmarks])
  const notes = useMemo(() => {
    const grouped = new Map<string, typeof snapshot.followUps>()
    for (const note of snapshot.followUps) {
      const entries = grouped.get(note.cardId) ?? []
      entries.push(note); grouped.set(note.cardId, entries)
    }
    return grouped
  }, [snapshot.followUps])
  const areaKey = reviewStackFocusKey(focus)
  const inArea = (name: string) => !focus || reviewStackFocusKey(name) === areaKey
  const cards = snapshot.cards.filter(card => inArea(card.focus) && (savedOnly ? bookmarks.get(card.id)?.saved : reviews.has(card.id) || bookmarks.get(card.id)?.saved || notes.has(card.id)))
  const groups = snapshot.groups.filter(group => inArea(group.focus) && group.activeCount > 0)
  return <section className="space-y-3 rounded-xl border bg-card p-4" aria-label={t('Review history')}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{t('Review history')}</h2>
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={savedOnly} onChange={event => setSavedOnly(event.target.checked)} />{t('Saved only')}</label></div>
    {!savedOnly && groups.map(group => <div key={group.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2">
      <span>{interpolate(t('{focus} · {count} marked seen together'), { focus: group.focus, count: group.activeCount })}</span>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => onAction({ action: 'undo-group', groupId: group.id })}>{t('Undo group')}</Button>
    </div>)}
    {!cards.length && <p className="text-sm text-muted-foreground">{t('No reviews here yet.')}</p>}
    <ul className="divide-y">{cards.slice(0, limit).map(card => {
      const review = reviews.get(card.id), bookmark = bookmarks.get(card.id)
      return <li key={card.id} className="space-y-2 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><Button variant="link" className="h-auto whitespace-normal p-0 text-left" onClick={() => onOpen(card)}>{card.title}</Button>
          <span className="text-xs text-muted-foreground">{[review && t(REVIEW_STACK_VERDICT_LABELS[review.action]), bookmark?.saved && t('Saved')].filter(Boolean).join(' · ')}</span></div>
        {notes.get(card.id)?.map(note => <div key={note.id} className="space-y-1 border-l-2 pl-3"><p className="whitespace-pre-wrap break-words" dir="auto">{note.body}</p>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onAction({ action: 'set-follow-up', cardId: card.id, followUpId: note.id, closed: note.closedAt === null, revision: note.revision })}>{note.closedAt === null ? t('Complete follow-up') : t('Reopen follow-up')}</Button></div>)}
        <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={disabled} onClick={() => onAction({ action: 'bookmark', cardId: card.id, revision: bookmark?.revision ?? 0, saved: !bookmark?.saved })}>{bookmark?.saved ? t('Unsave') : t('Save')}</Button>
          <Button variant="outline" size="sm" disabled={disabled} onClick={() => onNote(card)}>{t('Follow up')}</Button>
          {review && <Button variant="outline" size="sm" disabled={disabled} onClick={() => onAction({ action: 'undo', cardId: card.id, reviewId: review.id })}>{t('Return to deck')}</Button>}
        </div>
      </li>
    })}</ul>
    {cards.length > limit && <Button variant="outline" onClick={() => setLimit(value => value + 32)}>{t('Show more')}</Button>}
  </section>
}
