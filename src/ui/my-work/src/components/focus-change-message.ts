import { uiMessage, renderUiMessage, type UiMessage } from '../../../ui-message'
import { OTHER_FOCUS_AREA_ID, type FocusArea, type FocusChange, type Request } from '../data'
import type { FocusChangeRecord } from '../store/store-types'
import { NOT_SORTED_YET_LABEL, focusAreaLabel, resolveFocusAreaId } from '../live/to-focus-model'

type MessageRecord = FocusChangeRecord & { message?: UiMessage }

// Keep the English text contract for existing consumers; metadata survives the store's history/Undo.
function record({ message, undo }: { message: UiMessage; undo: FocusChange[] | null }): MessageRecord {
  return { text: renderUiMessage(message, source => source), message, undo }
}

export function renderFocusChange(record: MessageRecord, t: (source: string) => string): string {
  return record.message ? renderUiMessage(record.message, t) : record.text
}

/** The changes that return an area to the status it had, or null when the worker allows none. */
function backTo(area: FocusArea): FocusChange[] | null {
  if (area.status === 'suggested') return area.source === 'owner' ? null : [{ action: 'restore-suggestion', focusAreaId: area.id }]
  return [{ action: STATUS_ACTION[area.status], focusAreaId: area.id }]
}
const STATUS_ACTION = { kept: 'keep', done: 'done', dismissed: 'dismiss' } as const

/** A sub focus with the area it is in, from the areas as they were before a change; null when none has that id. */
function subFocusIn(areas: FocusArea[], subFocusId: string | null | undefined) {
  for (const area of areas) {
    const subFocus = area.subFocuses?.find((entry) => entry.id === subFocusId)
    if (subFocus) return { area, subFocus }
  }
  return null
}

/** What one change says in the saved note, and how to undo it, read from the areas as they were before it. */
export function describeFocusChange(change: FocusChange, areas: FocusArea[], requests: Request[]): MessageRecord {
  const area = areas.find((entry) => entry.id === change.focusAreaId)
  const name = area?.name || uiMessage('the area')
  switch (change.action) {
    case 'keep': return record({ message: uiMessage('Kept “{name}”', { name }), undo: area ? backTo(area) : null })
    case 'dismiss': return record({ message: uiMessage('Dismissed “{name}”', { name }), undo: area ? backTo(area) : null })
    case 'done': return record({ message: uiMessage('Marked “{name}” done', { name }), undo: area ? backTo(area) : null })
    case 'rename': return record({ message: uiMessage('Renamed “{name}” to “{newName}”', { name, newName: change.name?.trim() ?? '' }), undo: area ? [{ action: 'rename', focusAreaId: area.id, name: area.name }] : null })
    case 'edit-goal': return record({ message: uiMessage('Changed the goal of “{name}”', { name }), undo: area?.goal ? [{ action: 'edit-goal', focusAreaId: area.id, goal: area.goal }] : null })
    case 'merge': {
      const into = areas.find((entry) => entry.id === change.intoFocusAreaId)?.name ?? uiMessage('another area')
      // Only restore-suggestion clears a merge; a kept or done area is then decided again as it was.
      const undo = area && area.source !== 'owner' ? [{ action: 'restore-suggestion' as const, focusAreaId: area.id }, ...(area.status === 'suggested' ? [] : backTo(area) ?? [])] : null
      return record({ message: uiMessage('Merged “{name}” into “{into}”', { name, into }), undo })
    }
    case 'reorder': {
      const before = areas.filter((entry) => entry.status === 'kept' && !entry.mergedInto).map((entry) => entry.id)
      return record({ message: uiMessage('Changed the order of your focus areas'), undo: [{ action: 'reorder', focusAreaIds: before }] })
    }
    case 'move-request': {
      const request = requests.find((entry) => entry.id === change.requestId)
      const from = request ? resolveFocusAreaId(request.focusAreaId, areas) : null
      // Other and the unplaced case are words in the reader's language; an area's name is its own.
      const toPlaced = resolveFocusAreaId(change.focusAreaId, areas)
      const toArea = toPlaced === OTHER_FOCUS_AREA_ID ? uiMessage('Other') : toPlaced === null ? uiMessage(NOT_SORTED_YET_LABEL) : focusAreaLabel(change.focusAreaId, areas)
      return record({ message: uiMessage('Moved “{title}” to {area}', { title: request?.title ?? uiMessage('the request'), area: toArea }), undo: request && from ? [{ action: 'move-request', requestId: request.id, focusAreaId: from }] : null })
    }
    case 'restore-suggestion': return record({ message: uiMessage('Put “{name}” back in Suggested', { name }), undo: null })
    case 'rename-sub-focus': {
      const subFocus = subFocusIn(areas, change.subFocusId)?.subFocus
      return record({
        message: uiMessage('Renamed “{name}” to “{newName}”', { name: subFocus?.name || uiMessage('the sub focus'), newName: change.name?.trim() ?? '' }),
        undo: subFocus ? [{ action: 'rename-sub-focus', subFocusId: subFocus.id, name: subFocus.name }] : null,
      })
    }
    case 'merge-sub-focus': {
      const found = subFocusIn(areas, change.subFocusId)
      const into = found?.area.subFocuses?.find((entry) => entry.id === change.intoSubFocusId)?.name || uiMessage('the sub focus')
      // The worker has no change that takes a merge back, so the note offers no Undo.
      return record({ message: uiMessage('Merged “{name}” into “{into}”', { name: found?.subFocus.name || uiMessage('the sub focus'), into }), undo: null })
    }
    case 'move-to-sub-focus': {
      const request = requests.find((entry) => entry.id === change.requestId)
      const area = areas.find((entry) => entry.id === request?.focusAreaId)
      // Into none of the area's sub focuses: the request stays in its area, which is where the note says it went.
      const to = change.subFocusId === null ? area?.name : area?.subFocuses?.find((entry) => entry.id === change.subFocusId)?.name
      // Undo only when it sat in a sub focus before: a request not grouped yet, or ungrouped by a refresh, has no owner
      // decision to go back to, and an owner "none" would keep every later refresh from grouping it.
      return record({
        message: uiMessage('Moved “{title}” to {area}', { title: request?.title ?? uiMessage('the request'), area: to || uiMessage('the sub focus') }),
        undo: request && area && request.subFocusId ? [{ action: 'move-to-sub-focus', requestId: request.id, subFocusId: request.subFocusId }] : null,
      })
    }
  }
}
