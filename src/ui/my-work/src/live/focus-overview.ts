// One focus-area overview for setup's first reveal and the live work view. This reads recorded placement only;
// matching words, repeated prompts and unsorted requests never manufacture an area or a completion estimate.
import { needsYou, OTHER_FOCUS_AREA_ID, type FocusArea, type Request } from '../data.ts'
import { byFocusPriority, resolveFocusAreaId } from './to-focus-model.ts'

export interface FocusOverviewRow {
  area: FocusArea
  /** Every request placed here, including closed work, so the area opens the same membership as My Work. */
  requests: Request[]
  needsYou: number
  working: number
  shipped: number
}

export interface FocusOverview {
  areas: FocusOverviewRow[]
  suggested: FocusOverviewRow[]
  /** Explicitly placed in Other. */
  other: Request[]
  /** No recorded live placement, including unknown or dismissed areas. */
  sorting: Request[]
}

export function focusOverview(areas: readonly FocusArea[], requests: readonly Request[]): FocusOverview {
  const members = new Map<string, Request[]>()
  const other: Request[] = []
  const sorting: Request[] = []
  for (const request of requests) {
    const id = resolveFocusAreaId(request.focusAreaId, areas)
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
    const open = placed.filter((request) => !request.closed)
    return {
      area, requests: placed,
      needsYou: open.filter(needsYou).length,
      working: open.filter((request) => request.state === 'working').length,
      shipped: open.filter((request) => request.state === 'shipped').length,
    }
  }
  const ordered = [...areas].filter((area) => !area.mergedInto).sort(byFocusPriority)
  return {
    areas: ordered.filter((area) => area.status === 'kept').map(row),
    suggested: ordered.filter((area) => area.status === 'suggested').map(row),
    other, sorting,
  }
}
