import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { presentSharedState } from './shared-state-presentation.ts'

describe('shared My Work status', () => {
  it('keeps old snapshots readable and says when publication is disabled', () => {
    assert.equal(presentSharedState(undefined), null)
    const status = presentSharedState({ enabled: false })
    assert.equal(status?.state, 'disabled')
    assert.match(status?.detail ?? '', /Shared My Work state is not enabled/)
  })

  it('does not claim cloud parity just because writes are enabled', () => {
    const status = presentSharedState({ enabled: true })
    assert.equal(status?.label, 'My Work sharing on')
    assert.match(status?.detail ?? '', /Cloud freshness is shown separately/)
  })

  it('shows incomplete batches and rejected state explicitly', () => {
    assert.equal(presentSharedState({ enabled: true, pending: 1 })?.state, 'pending')
    for (const diagnostics of [{ invalid: 1 }, { unsupported: 1 }, { conflicts: [{}] }, { files: [{ file: 'story.json', message: 'too large' }] }]) {
      const status = presentSharedState({ enabled: true, ...diagnostics })
      assert.equal(status?.state, 'attention')
      assert.match(status?.detail ?? '', /previous complete state/)
    }
  })
})
