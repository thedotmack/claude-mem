// One focus-area overview for setup's first reveal and the live work view. This reads recorded placement only;
// matching words, repeated prompts and unsorted requests never manufacture an area or a completion estimate.
import { isClosed, needsYou, OTHER_FOCUS_AREA_ID, type FocusArea, type Request } from '../data.ts'
import { focusIconSrc } from './focus-icon.ts'
import { byFocusPriority, createFocusAreaResolver } from './to-focus-model.ts'

export interface FocusOverviewRow {
  area: FocusArea
  /** Every request placed here, including closed work, so the area opens the same membership as My Work. */
  requests: Request[]
  /** The ones its card counts and lists: every one that is not closed, or only those the page's filter shows. */
  shown: Request[]
  /** The one request the card points at: the first shown that waits on a person, else the first being worked on. */
  next: Request | null
  /** The focus's own icon, uploaded or drawn for it; null when it has none, and the card then has no picture. */
  iconSrc: string | null
  needsYou: number
  working: number
  shipped: number
}

export interface FocusOverview {
  areas: FocusOverviewRow[]
  suggested: FocusOverviewRow[]
  /** Explicitly placed in Other; like a card's `shown`, only those the filter shows. */
  other: Request[]
  /** No recorded live placement, including unknown or dismissed areas. */
  sorting: Request[]
}

const notClosed = (request: Request) => !isClosed(request)

/** `shows` is the page's filter (Open work leaves Done out); without one a card counts everything that is not closed. */
export function focusOverview(areas: readonly FocusArea[], requests: readonly Request[], shows: (request: Request) => boolean = notClosed): FocusOverview {
  const members = new Map<string, Request[]>()
  const resolveArea = createFocusAreaResolver(areas)
  const other: Request[] = []
  const sorting: Request[] = []
  for (const request of requests) {
    const id = resolveArea(request.focusAreaId)
    if (id === OTHER_FOCUS_AREA_ID) other.push(request)
    else if (id === null) sorting.push(request)
    else {
      const bucket = members.get(id) ?? []
      bucket.push(request)
      members.set(id, bucket)
    }
  }
  const row = (area: FocusArea): FocusOverviewRow => {
    const placed = members.get(area.id) ?? []
    const shown = placed.filter(shows)
    return {
      area, requests: placed, shown,
      next: shown.find(needsYou) ?? shown.find((request) => request.state === 'working') ?? null,
      iconSrc: focusIconSrc(area),
      needsYou: shown.filter(needsYou).length,
      working: shown.filter((request) => request.state === 'working').length,
      shipped: shown.filter((request) => request.state === 'shipped').length,
    }
  }
  const ordered = [...areas].filter((area) => !area.mergedInto).sort(byFocusPriority)
  return {
    areas: ordered.filter((area) => area.status === 'kept').map(row),
    suggested: ordered.filter((area) => area.status === 'suggested').map(row),
    other: other.filter(shows), sorting: sorting.filter(shows),
  }
}
