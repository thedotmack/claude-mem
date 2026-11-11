import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { isServedFromCloud, setTimeoutThenWaitUntilCloudPageVisible, whenCloudPageVisible } from './served-from.ts'

describe('where the page is served', () => {
  it('treats loopback as this computer and any other host as the cloud viewer', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]', '::1']) assert.equal(isServedFromCloud(host), false, host)
    assert.equal(isServedFromCloud('cmem-viewer.fly.dev'), true)
    assert.equal(isServedFromCloud('viewer.cmem.ai'), true)
    assert.equal(isServedFromCloud(''), false)
    assert.equal(isServedFromCloud(undefined), false)
  })
})

describe('timed requests from a hidden tab', () => {
  class FakePage extends EventTarget {
    visibilityState = 'hidden'
    show(state: 'visible' | 'hidden') { this.visibilityState = state; this.dispatchEvent(new Event('visibilitychange')) }
  }

  it('waits on a hidden cloud tab until it is shown, then runs once', () => {
    const page = new FakePage()
    let runs = 0
    whenCloudPageVisible(() => runs++, 'work.cmem.ai', page)
    page.show('hidden')
    assert.equal(runs, 0)
    page.show('visible')
    page.show('hidden')
    page.show('visible')
    assert.equal(runs, 1)
  })

  it('runs at once on a visible cloud tab and on this computer, hidden or not', () => {
    let runs = 0
    const visible = new FakePage()
    visible.visibilityState = 'visible'
    whenCloudPageVisible(() => runs++, 'work.cmem.ai', visible)
    whenCloudPageVisible(() => runs++, 'localhost', new FakePage())
    whenCloudPageVisible(() => runs++, 'work.cmem.ai', undefined)
    assert.equal(runs, 3)
  })

  it('a cancelled wait never runs', () => {
    const page = new FakePage()
    let runs = 0
    const cancel = whenCloudPageVisible(() => runs++, 'work.cmem.ai', page)
    cancel()
    page.show('visible')
    assert.equal(runs, 0)
  })
})

describe('a timed request that waits for a hidden cloud tab', () => {
  class FakePage extends EventTarget {
    visibilityState = 'visible'
    show(state: 'visible' | 'hidden') { this.visibilityState = state; this.dispatchEvent(new Event('visibilitychange')) }
  }
  const useSimulatedTimers = (t: TestContext) => t.mock.timers.enable({ apis: ['setTimeout'] })

  it('on a cloud tab hidden when the delay ends, runs once the tab is shown', (t) => {
    useSimulatedTimers(t)
    const page = new FakePage()
    let runs = 0
    setTimeoutThenWaitUntilCloudPageVisible(() => runs++, 1000, 'work.cmem.ai', page)
    page.show('hidden')
    t.mock.timers.tick(10 * 60_000)
    assert.equal(runs, 0)
    page.show('visible')
    assert.equal(runs, 1)
  })

  it('runs when the delay ends on a visible cloud tab and on this computer, hidden or not', (t) => {
    useSimulatedTimers(t)
    const hidden = new FakePage()
    hidden.visibilityState = 'hidden'
    let runs = 0
    setTimeoutThenWaitUntilCloudPageVisible(() => runs++, 1000, 'work.cmem.ai', new FakePage())
    setTimeoutThenWaitUntilCloudPageVisible(() => runs++, 1000, 'localhost', hidden)
    t.mock.timers.tick(999)
    assert.equal(runs, 0)
    t.mock.timers.tick(1)
    assert.equal(runs, 2)
  })

  it('cancelling stops both the timer and the wait', (t) => {
    useSimulatedTimers(t)
    const page = new FakePage()
    let runs = 0
    setTimeoutThenWaitUntilCloudPageVisible(() => runs++, 1000, 'work.cmem.ai', page)()
    t.mock.timers.tick(1000)
    page.visibilityState = 'hidden'
    const cancelWhileWaiting = setTimeoutThenWaitUntilCloudPageVisible(() => runs++, 1000, 'work.cmem.ai', page)
    t.mock.timers.tick(1000)
    cancelWhileWaiting()
    page.show('visible')
    assert.equal(runs, 0)
  })
})
