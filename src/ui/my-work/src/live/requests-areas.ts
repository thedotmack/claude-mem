// Requests' focus area choice (pages/requests.tsx Filter and sort, its `?area=`; store/slices/view-slice.ts): each
// request sits in the area a review placed it in (an area merged away puts it in the area it merged into), in Other,
// or in none yet. The page offers only the places some request sits in, and the store reads any other as none. Pure,
// with .ts imports, so the store's tests load it.
import { OTHER_FOCUS_AREA_ID, type FocusArea, type Request } from '../data.ts'
import { createFocusAreaResolver } from './to-focus-model.ts'

/** The choice for the requests no review has placed yet ("Not sorted yet"). No area's id is this: the worker's are `fa_…`. */
export const NOT_SORTED_AREA = 'not-sorted'

/** Requests' area choice: a focus area's id, Other's (OTHER_FOCUS_AREA_ID), or NOT_SORTED_AREA. */
export type RequestsArea = FocusArea['id'] | typeof OTHER_FOCUS_AREA_ID | typeof NOT_SORTED_AREA

/** Where each request sits, as an area choice. */
export function requestsAreaOf(focusAreas: readonly FocusArea[]): (request: Pick<Request, 'focusAreaId'>) => RequestsArea {
  const resolve = createFocusAreaResolver(focusAreas)
  return (request) => resolve(request.focusAreaId) ?? NOT_SORTED_AREA
}

/** The places the requests sit in: in the work's order of areas, then Other, then the requests not sorted yet. */
export function requestsAreaChoices(requests: readonly Request[], focusAreas: readonly FocusArea[]): RequestsArea[] {
  const areaOf = requestsAreaOf(focusAreas)
  const used = new Set(requests.map(areaOf))
  return [...focusAreas.map((area) => area.id), OTHER_FOCUS_AREA_ID, NOT_SORTED_AREA].filter((area) => used.has(area))
}
