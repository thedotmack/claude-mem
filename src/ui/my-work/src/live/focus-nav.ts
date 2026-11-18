// The short focus navigation is a presentation of the complete area list, never a stored-area limit.
import { needsYou, type FocusArea, type Request } from '../data.ts'
import { keptFocusAreas } from './focus-overview.ts'
import { createFocusAreaResolver, resolveFocusAreaId } from './to-focus-model.ts'

/** Count each request once for all navigation entries, including placements through merged areas. */
export function focusNavActivity(areas: readonly FocusArea[], requests: readonly Request[]) {
  const resolveArea = createFocusAreaResolver(areas)
  const activity = new Map<string, { count: number; moving: boolean }>()
  for (const request of requests) {
    const id = resolveArea(request.focusAreaId)
    if (id === null) continue
    const entry = activity.get(id) ?? { count: 0, moving: false }
    if (needsYou(request)) entry.count++
    if (!request.closed && request.state === 'working') entry.moving = true
    activity.set(id, entry)
  }
  return activity
}

/**
 * Four kept areas in owner order (the focus board's list, live/focus-overview.ts). An off-list selection replaces only
 * the fourth slot. Other is added by the UI.
 */
export function focusNavAreas(areas: readonly FocusArea[], selectedFocusAreaId: string | null): FocusArea[] {
  const kept = keptFocusAreas(areas)
  const visible = kept.slice(0, 4)
  const selectedId = resolveFocusAreaId(selectedFocusAreaId, areas)
  const selected = kept.find((area) => area.id === selectedId)
  if (selected && !visible.some((area) => area.id === selected.id)) visible[3] = selected
  return visible
}
