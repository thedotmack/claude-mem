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

/**
 * The narrowest title column the List's table may give a request (pages/requests.tsx ListView): the 183px it has at
 * 1360px without Team, the narrowest width the table shows a title at (measured on the owner's data, 2026-11-16,
 * verify-4). With Team on, an Asked by column (7rem, 119px at the 17px desktop root) left the title 64px at 1360 and
 * 128px from 1440, where the page stops widening, so in team mode the table never fits this width and the List is
 * rows at every width, with who asked on each row's facts line. The List draws the table only where its own width
 * leaves the title column this wide (pages/requests.tsx ListView), so a classic 15px scrollbar, which a window-width rule
 * did not count (175.5px at 1366 on PR #6210's Linux CI), keeps it rows. The browser test holds the List to it from 1355
 * to 1390px with and without that scrollbar, Team off and on.
 */
export const LIST_TITLE_MIN_PX = 183

export type CardGroup<Id extends string = string> = { id: Id; label: string; states: LiveState[]; dot: string; size: CardSize }

const group = <Id extends string>(id: Id, label: string, states: LiveState[], dot: string): CardGroup<Id> => {
  const size = CARD_SIZE[states[0]]
  if (states.some((state) => CARD_SIZE[state] !== size)) throw new Error(`Card group ${id} mixes card sizes`)
  return { id, label, states, dot, size }
}

/**
 * What needs you, then what is moving, then the rest, folded to one line each. Every mark is still (rule 8). The one
 * list of request groups: the boards' sections, and Requests' status tabs and its `?status=` (pages/requests.tsx,
 * store/slices/view-slice.ts) take theirs from here.
 */
export const CARD_GROUPS = [
  group('needs-you', 'Needs you', ['your-move', 'needs-check'], 'bg-attention-foreground'),
  group('working', 'Working', ['working'], 'bg-working-foreground'),
  group('idle', 'Idle', ['idle'], 'bg-idle-foreground'),
  group('shipped', 'Shipped', ['shipped'], 'bg-shipped-foreground'),
]

/** A group's id, typed from CARD_GROUPS: Requests' status tab (`?status=`). */
export type CardGroupId = (typeof CARD_GROUPS)[number]['id']

/** Whether a word from outside (an address) names one of the groups. */
export const isCardGroupId = (value: string | null): value is CardGroupId => CARD_GROUPS.some((cardGroup) => cardGroup.id === value)

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

/**
 * Every group with its requests in board order, empty groups left out: the List and the Team columns draw these as
 * group rows (G4), the groups of one-line cards folded until opened.
 */
export function requestSections(requests: Request[]): { group: CardGroup; members: Request[] }[] {
  return CARD_GROUPS
    .map((cardGroup) => ({ group: cardGroup, members: requests.filter((request) => cardGroup.states.includes(request.state)) }))
    .filter((section) => section.members.length > 0)
}

/** The one-line sections (idle, shipped), each with its requests in board order. Empty sections are left out. */
export function lineSections(requests: Request[]): { group: CardGroup; members: Request[] }[] {
  return requestSections(requests).filter((section) => section.group.size === 'line')
}

/** How many of `total` rows show once `pages` pages are open, and how many are left (G4: "Show 50 more · 68 left"). */
export function linePage(total: number, pages: number): { shown: number; left: number } {
  const shown = Math.min(total, Math.max(0, pages) * LINE_ROWS_PER_PAGE)
  return { shown, left: total - shown }
}
