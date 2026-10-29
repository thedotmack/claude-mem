// My Rules saves: one at a time, each recorded as a receipt for the exact version the worker saved, so live
// updates arriving meanwhile can't turn a receipt or an Undo into a statement about a different rule.
import { ruleUndoIsCurrent, ruleVersion } from '../../live/rule-actions.ts'
import type { SliceCreator } from '../create-store.ts'
import type { RulesSlice } from '../store-types.ts'

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

export const createRulesSlice: SliceCreator<RulesSlice> = (set, get) => ({
  rules: { savedDecisions: {}, history: [], changedIds: [], saving: false, saveError: null },

  runRuleSave: async (change, describe) => {
    if (get().rules.saving) return null
    set((state) => { state.rules.saving = true; state.rules.saveError = null })
    try {
      const saved = await get().saveRuleChange(change)
      const outcome = describe(saved)
      const savedVersion = (ruleId: string | null) => ruleId ? ruleVersion(saved.model.rules.find((rule) => rule.id === ruleId)) : null
      set((state) => {
        if (outcome.decision) {
          const { ruleId, decision } = outcome.decision
          const version = savedVersion(ruleId)
          if (decision && version) state.rules.savedDecisions[ruleId] = { decision, version }
          else delete state.rules.savedDecisions[ruleId]
        }
        if (outcome.change) {
          state.rules.history.push({ ...outcome.change, expectedVersion: savedVersion(outcome.change.ruleId) })
          const { ruleId } = outcome.change
          if (ruleId && !state.rules.changedIds.includes(ruleId)) state.rules.changedIds.push(ruleId)
        }
      })
      return saved.model.rules
    } finally {
      set((state) => { state.rules.saving = false })
    }
  },

  undoLastRuleChange: async () => {
    const last = get().rules.history.at(-1)
    if (!last?.undo || !last.ruleId || get().rules.saving) return
    const load = get().work.load
    const shownRules = load.state === 'loaded' ? load.model.rules : []
    if (!ruleUndoIsCurrent(last.ruleId, last.expectedVersion, shownRules)) {
      set((state) => { state.rules.saveError = 'This rule changed since your edit. Review its current version before changing it again.' })
      return
    }
    const { ruleId, undo } = last
    set((state) => { state.rules.saving = true; state.rules.saveError = null })
    try {
      await get().saveRuleChange(undo)
      set((state) => {
        if (undo.action === 'restore-suggestion') delete state.rules.savedDecisions[ruleId]
        state.rules.history.pop()
      })
    } catch (error) {
      set((state) => { state.rules.saveError = messageOf(error) })
    } finally {
      set((state) => { state.rules.saving = false })
    }
  },

  setRuleSaveError: (saveError) => set((state) => { state.rules.saveError = saveError }),
})
