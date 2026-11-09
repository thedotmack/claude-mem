// The short focus navigation is a presentation of the complete area list, never a stored-area limit.
import type { FocusArea } from '../data.ts'
import { byFocusPriority, resolveFocusAreaId } from './to-focus-model.ts'

/** Four kept areas in owner order. An off-list selection replaces only the fourth slot. Other is added by the UI. */
export function focusNavAreas(areas: readonly FocusArea[], selectedFocusAreaId: string | null): FocusArea[] {
  const kept = areas.filter((area) => area.status === 'kept' && !area.mergedInto).sort(byFocusPriority)
  const visible = kept.slice(0, 4)
  const selectedId = resolveFocusAreaId(selectedFocusAreaId, areas)
  const selected = kept.find((area) => area.id === selectedId)
  if (selected && !visible.some((area) => area.id === selected.id)) visible[3] = selected
  return visible
}
