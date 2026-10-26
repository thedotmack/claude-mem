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
    const mutation = async () => { const savedModel = await pending; return { savedModel, model: savedModel, refreshError: null } }
    const source: WorkDataSource = {
      sourceKind: 'local',
      loadWorkModel: async () => current,
      subscribeToLiveUpdates: (publish) => { publish(current); return () => {} },
      saveRuleChange: mutation,
      setRequestChecked: async () => ({ outcome: 'saved', ...await mutation() }),
      markAgentFinished: mutation,
      loadRulesInClaudeCode: mutation,
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

test('a confirmed save retains its receipt and exposes refresh failure without replacing newer work', async () => {
  const model = (title: string) => ({ sourceKind: 'local', requests: [{ id: 'one', title } as Request], connection: getConnectionStatus({ now: 0 }) }) as WorkModel
  const savedModel = model('saved version')
  const currentModel = model('newer version')
  const result = { savedModel, model: currentModel, refreshError: 'offline', savedRuleId: 'one' }
  const source: WorkDataSource = {
    sourceKind: 'local', loadWorkModel: async () => currentModel,
    subscribeToLiveUpdates: (publish) => { publish(currentModel); return () => {} },
    saveRuleChange: async () => result,
    setRequestChecked: async () => ({ outcome: 'saved', ...result }),
    markAgentFinished: async () => result,
    loadRulesInClaudeCode: async () => result,
  }
  const stop = startWorkModel(source)
  try {
    await Promise.resolve()
    const received = await saveRuleChange({ action: 'approve', ruleId: 'one' })
    assert.equal(received.savedModel, savedModel)
    const load = workStore.getState().load
    assert.equal(load.state === 'loaded' && load.model, currentModel)
    assert.match(workStore.getState().refreshError ?? '', /change was saved.*offline/)
  } finally { stop() }
})
