import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadRulesInClaudeCode, markAgentFinished, saveRuleChange, setRequestChecked, startWorkModel, type Request } from '../data.ts'
import { getConnectionStatus } from '../live/connection-status.ts'
import type { WorkDataSource, WorkModel } from '../live/work-data-source.ts'
import { workStore } from './work-store.ts'

test('a save from a disposed session cannot replace the restarted session, even on the same source', async () => {
  for (const action of [
    () => saveRuleChange({ action: 'approve', ruleId: 'rule' }),
    () => setRequestChecked('one', true),
    () => markAgentFinished('agent'),
    () => loadRulesInClaudeCode(),
  ]) {
    const model = (title: string) => ({ sourceKind: 'local', requests: [{ id: 'one', title } as Request], connection: getConnectionStatus({ now: 0 }) }) as WorkModel
    let current = model('before save')
    let resolve!: (model: WorkModel) => void
    const pending = new Promise<WorkModel>((done) => { resolve = done })
    const source: WorkDataSource = {
      sourceKind: 'local',
      loadWorkModel: async () => current,
      subscribeToLiveUpdates: (publish) => { publish(current); return () => {} },
      saveRuleChange: () => pending,
      setRequestChecked: async () => ({ outcome: 'saved', model: await pending }),
      markAgentFinished: () => pending,
      loadRulesInClaudeCode: () => pending,
    }
    const stopFirst = startWorkModel(source)
    const save = action()
    stopFirst()
    current = model('new session')
    const stopSecond = startWorkModel(source)
    resolve(model('stale save'))
    await save
    const load = workStore.getState().load
    assert.equal(load.state === 'loaded' && load.model.requests[0].title, 'new session')
    stopSecond()
  }
})
