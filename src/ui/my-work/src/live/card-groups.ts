// A focus's Cards view in sections, as ONE flat list of keyed entries. Flat on purpose: React
// scopes keys to their array, so cards nested per section would remount when their request changes section, and the
// card's layout glide from one section to the other could never connect.
import type { Request } from '../data.ts'
import { countBucket, type CountBucket } from './status-label.ts'

export type CardGroup = { id: string; label: string; buckets: CountBucket[]; dot: string; foldAfter?: number }

/**
 * What needs you, then what is moving, then the rest. Idle and Done show their newest few and fold the rest behind
 * "Show all", so live work stays near the top of a long history. A request is filed by the bucket the focus line
 * counts it in, so shipped, checked and closed work rest together under Done.
 */
export const CARD_GROUPS: CardGroup[] = [
  { id: 'needs-you', label: 'Needs you', buckets: ['your-move', 'needs-check'], dot: 'bg-attention-foreground' },
  { id: 'working', label: 'Working', buckets: ['working'], dot: 'bg-working-foreground motion-safe:animate-pulse' },
  { id: 'idle', label: 'Idle', buckets: ['idle'], dot: 'bg-idle-foreground', foldAfter: 6 },
  { id: 'done', label: 'Done', buckets: ['done'], dot: 'bg-shipped-foreground/50', foldAfter: 6 },
]

export type CardGridEntry =
  | { kind: 'heading'; key: string; group: CardGroup; count: number; folds: boolean; open: boolean }
  | { kind: 'card'; key: string; request: Request }

/** Headings keyed `heading-<group>`, cards keyed by request id, all in one list. Empty sections are left out. */
export function cardGridEntries(requests: Request[], unfolded: Record<string, boolean>): CardGridEntry[] {
  return CARD_GROUPS.flatMap((group): CardGridEntry[] => {
    const members = requests.filter((request) => group.buckets.includes(countBucket(request)))
    if (members.length === 0) return []
    const folds = group.foldAfter !== undefined && members.length > group.foldAfter
    const open = !folds || !!unfolded[group.id]
    const shown = open ? members : members.slice(0, group.foldAfter)
    return [
      { kind: 'heading', key: `heading-${group.id}`, group, count: members.length, folds, open },
      ...shown.map((request): CardGridEntry => ({ kind: 'card', key: request.id, request })),
    ]
  })
}
