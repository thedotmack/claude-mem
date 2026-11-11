// My Focus saves: one at a time, the last one kept for the saved note's Undo. Undo writes the changes that put
// things back (focus-changes.tsx works them out when the change is made).
import type { SliceCreator } from '../create-store.ts'
import type { FocusSlice } from '../store-types.ts'
import type { FocusChange } from '../../data.ts'
import type { WorkModel } from '../../live/work-data-source.ts'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Only the saved records an Undo would change, excluding clocks and activity in other areas. */
function undoVersion(undo: FocusChange[] | null, model: WorkModel): string | null {
  if (!undo?.length) return null
  const versions: unknown[] = []
  for (const step of undo) {
    if (step.action === 'reorder') {
      versions.push(model.focusAreas.filter(area => area.status === 'kept' && !area.mergedInto)
        .map(area => [area.id, area.ownerRank, area.priorityRank]))
    } else if (step.action === 'move-request') {
      const request = model.requests.find(request => request.id === step.requestId)
      if (!request) return null
      versions.push([request.id, request.focusAreaId])
    } else {
      const area = model.focusAreas.find(area => area.id === step.focusAreaId)
      if (!area) return null
      versions.push([area.id, area.name, area.goal, area.about, area.status, area.ownerRank, area.priorityRank, area.source, area.mergedInto])
    }
  }
  return JSON.stringify(versions)
}

export const createFocusSlice: SliceCreator<FocusSlice> = (set, get) => {
  const oneAtATime = async (save: () => Promise<void>) => {
    if (get().focus.saving) return false
    set((state) => { state.focus.saving = true; state.focus.error = null })
    try {
      await save()
      return true
    } catch (error) {
      set((state) => { state.focus.error = messageOf(error) })
      return false
    } finally {
      set((state) => { state.focus.saving = false })
    }
  }

  return {
    focus: { history: [], saving: false, error: null },

    applyFocusChange: (change, record) => oneAtATime(async () => {
      const saved = await get().saveFocusChange(change)
      if (record) set((state) => { state.focus.history.push({ ...record, expectedVersion: undoVersion(record.undo, saved) }) })
    }),

    undoLastFocusChange: () => oneAtATime(async () => {
      const last = get().focus.history.at(-1)
      const undo = last?.undo
      if (!undo) return
      for (let index = 0; index < undo.length; index++) {
        const current = get().focus.history.at(-1)!
        const load = get().work.load
        if (!current.expectedVersion || load.state !== 'loaded' || current.expectedVersion !== undoVersion(current.undo, load.model)) {
          throw new Error('This focus changed since your edit. Review its current version before changing it again.')
        }
        const saved = await get().saveFocusChange(undo[index])
        const remaining = undo.slice(index + 1)
        // A merge Undo can take two writes. If the second fails, keep only the unfinished step.
        if (remaining.length) set((state) => {
          const current = state.focus.history.at(-1)!
          current.undo = remaining
          current.expectedVersion = undoVersion(remaining, saved)
        })
      }
      set((state) => { state.focus.history.pop() })
    }),
  }
}
