// The Cards view's sections when sorted attention-first. The card sections are ONE flat list of keyed entries. Flat on
// purpose: React scopes keys to their array, so cards nested per section would remount when their request changes
// section, and the card's layout glide from one section to the other could never connect. The one-line sections fold
// on their own (G4), so they are listed apart.
import type { LiveState, Request } from '../data.ts'

/**
 * How big a request draws on the Cards board (c-work-cards-view, decision G4): a full card when it needs you, a medium
 * card while it is working, one line when it is idle or shipped. The one definition of card size; the board and the
 * card (components/request-card.tsx `size`) take it from here. A new state fails the typecheck until it has a size.
 */
export type CardSize = 'full' | 'medium' | 'line'
export const CARD_SIZE: Record<LiveState, CardSize> = {
  'your-move': 'full',
  'needs-check': 'full',
  working: 'medium',
  idle: 'line',
  shipped: 'line',
}

/**
 * One-line rows drawn at a time when a folded section opens, and added by each "Show 50 more" (G4): 50 is UI UX Pro
 * Max's virtualize-lists rule, which draws at most 50 rows at once instead of virtualizing.
 */
export const LINE_ROWS_PER_PAGE = 50

export type CardGroup = { id: string; label: string; states: LiveState[]; dot: string; size: CardSize }

const group = (id: string, label: string, states: LiveState[], dot: string): CardGroup => {
  const size = CARD_SIZE[states[0]]
  if (states.some((state) => CARD_SIZE[state] !== size)) throw new Error(`Card group ${id} mixes card sizes`)
  return { id, label, states, dot, size }
}

/** What needs you, then what is moving, then the rest, folded to one line each. Every mark is still (rule 8). */
export const CARD_GROUPS: CardGroup[] = [
  group('needs-you', 'Needs you', ['your-move', 'needs-check'], 'bg-attention-foreground'),
  group('working', 'Working', ['working'], 'bg-working-foreground'),
  group('idle', 'Idle', ['idle'], 'bg-idle-foreground'),
  group('shipped', 'Shipped', ['shipped'], 'bg-shipped-foreground'),
]

/** A card entry carries the size its section draws it at (CARD_SIZE, never a line in the grid). */
export type CardGridEntry =
  | { kind: 'heading'; key: string; group: CardGroup; count: number }
  | { kind: 'card'; key: string; request: Request; size: Exclude<CardSize, 'line'> }

/** The card sections (full and medium): headings keyed `heading-<group>`, cards keyed by request id, all in one list. */
export function cardGridEntries(requests: Request[]): CardGridEntry[] {
  return CARD_GROUPS.flatMap((cardGroup): CardGridEntry[] => {
    const size = cardGroup.size
    if (size === 'line') return []
    const members = requests.filter((request) => cardGroup.states.includes(request.state))
    if (members.length === 0) return []
    return [
      { kind: 'heading', key: `heading-${cardGroup.id}`, group: cardGroup, count: members.length },
      ...members.map((request): CardGridEntry => ({ kind: 'card', key: request.id, request, size })),
    ]
  })
}

/** The one-line sections (idle, shipped), each with its requests in board order. Empty sections are left out. */
export function lineSections(requests: Request[]): { group: CardGroup; members: Request[] }[] {
  return CARD_GROUPS.filter((entry) => entry.size === 'line')
    .map((lineGroup) => ({ group: lineGroup, members: requests.filter((request) => lineGroup.states.includes(request.state)) }))
    .filter((section) => section.members.length > 0)
}

/** How many of `total` rows show once `pages` pages are open, and how many are left (G4: "Show 50 more · 68 left"). */
export function linePage(total: number, pages: number): { shown: number; left: number } {
  const shown = Math.min(total, Math.max(0, pages) * LINE_ROWS_PER_PAGE)
  return { shown, left: total - shown }
}
