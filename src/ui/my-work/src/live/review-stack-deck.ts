import type { ReviewStackCard, ReviewStackSnapshot } from '../../../../shared/review-stack.ts'
import { reviewStackFocusKey } from '../../../../shared/review-stack.ts'

export const GROUP_HOLD_MS = 3000
export const XP_PER_SEEN = 10
const CONFETTI_EVERY = 5

export function milestoneCrossed(before: number, after: number) {
  return after > before && Math.floor(after / CONFETTI_EVERY) > Math.floor(before / CONFETTI_EVERY)
}

/** Browse includes the whole area. A Work pass may revisit the skips that existed when the pass began. */
export function reviewDeck(snapshot: ReviewStackSnapshot, focus: string, revisit: ReadonlySet<string>) {
  const areaKey = reviewStackFocusKey(focus)
  const cards = snapshot.cards.filter(card => !focus || reviewStackFocusKey(card.focus) === areaKey)
  const reviews = new Map(snapshot.reviews.map(review => [review.cardId, review]))
  const bookmarks = new Map(snapshot.bookmarks.map(bookmark => [bookmark.cardId, bookmark]))
  const pending: ReviewStackCard[] = []
  const skipped: string[] = []
  let seen = 0
  for (const card of cards) {
    const review = reviews.get(card.id)
    if (!review) pending.push(card)
    else if (review.action === 'seen') seen++
    else {
      skipped.push(review.id)
      if (revisit.has(review.id)) pending.push(card)
    }
  }
  return { cards, pending, skipped, seen, reviews, bookmarks }
}

export function horizontalTravel(x: number, y: number, width: number) {
  return Math.abs(x) > Math.abs(y) * 1.15 && Math.abs(x) >= Math.max(44, Math.min(64, width * 0.12))
}
