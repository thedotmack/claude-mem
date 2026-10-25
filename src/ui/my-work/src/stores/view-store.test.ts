import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request } from '../data.ts'
import { createViewStore, readViewRoute, VIEW_STORAGE_KEY } from './view-store.ts'

const request = (id: string) => ({ id, title: id } as Request)
function harness(saved: string | null = null, href = 'http://localhost/work-view?source=sample') {
  let currentUrl = href
  let value = saved
  const writes: { url: string; replace: boolean }[] = []
  const store = createViewStore({
    href: () => currentUrl,
    storage: { getItem: () => value, setItem: (key, next) => { assert.equal(key, VIEW_STORAGE_KEY); value = next } },
    writeUrl: (url, replace) => { currentUrl = url.href; writes.push({ url: url.href, replace }) },
  })
  return { store, writes, saved: () => value, url: () => new URL(currentUrl), setUrl: (url: string) => { currentUrl = url } }
}

describe('My Work view state', () => {
  it('validates persisted fields, ignores unknown versions and tolerates denied storage', () => {
    const invalid = harness(JSON.stringify({ version: 1, preferences: { dark: 'yes', view: 'missing', filter: null, sort: [], team: 'yes' } })).store.getState()
    assert.equal(invalid.dark, false)
    assert.equal(invalid.view, 'cards')
    assert.equal(invalid.filter, 'all')
    assert.equal(invalid.sort, 'attention')
    assert.equal(invalid.team, false)
    assert.equal(harness('{broken').store.getState().view, 'cards')
    assert.equal(harness(JSON.stringify({ version: 2, preferences: { view: 'list' } })).store.getState().view, 'cards')
    const store = createViewStore({ storage: { getItem: () => { throw Error('denied') }, setItem: () => { throw Error('denied') } } })
    assert.doesNotThrow(() => store.getState().setView('list'))
    assert.equal(store.getState().view, 'list')
  })

  it('persists display preferences without server records, navigation or form state', () => {
    const h = harness()
    h.store.getState().setView('list')
    h.store.getState().setFilter('needs-you')
    h.store.getState().setSort('progress')
    h.store.getState().setDark(true)
    h.store.getState().openRequest(request('private-record'), false)
    h.store.getState().setShowSpec(true)
    h.store.getState().goToGoal('private-goal')
    assert.deepEqual(JSON.parse(h.saved()!), { version: 1, preferences: { dark: true, view: 'list', filter: 'needs-you', sort: 'progress', team: false } })
    const reloaded = harness(h.saved()).store.getState()
    assert.equal(reloaded.view, 'list')
    assert.equal(reloaded.selection, null)
    assert.equal(reloaded.showSpec, false)
  })

  it('returns to cards when team mode is disabled, including stale persisted team view', () => {
    const store = harness().store
    store.getState().setTeam(true)
    store.getState().setView('team')
    store.getState().setTeam(false)
    assert.equal(store.getState().view, 'cards')
    store.getState().setView('team')
    assert.equal(store.getState().view, 'cards')
    const reloaded = harness(JSON.stringify({ version: 1, preferences: { view: 'team', team: false } }))
    assert.equal(reloaded.store.getState().view, 'cards')
  })

  it('keeps explicit theme links in sync with changes and replaces completed setup history', () => {
    const h = harness(null, 'http://localhost/work-view?setup=1&theme=dark')
    assert.equal(h.store.getState().dark, true)
    h.store.getState().setDark(false)
    assert.equal(h.url().searchParams.get('theme'), 'light')
    h.store.getState().goToPage('work', true)
    assert.equal(h.url().searchParams.has('setup'), false)
    assert.equal(h.writes.at(-1)?.replace, true)
  })

  it('restores URL navigation and supports browser back without pushing another history entry', () => {
    const h = harness(null, 'http://localhost/work-view?source=sample&goal=g1&request=r1')
    assert.equal(h.store.getState().page, 'goals')
    assert.equal(h.store.getState().selection?.id, 'r1')
    h.store.getState().goToPage('rules')
    assert.equal(h.url().searchParams.get('source'), 'sample')
    assert.equal(h.url().searchParams.get('page'), 'rules')
    assert.equal(h.url().searchParams.has('request'), false)
    h.store.getState().goToGoal('g2')
    const count = h.writes.length
    h.setUrl('http://localhost/work-view?source=sample&page=rules')
    h.store.getState().syncUrl()
    assert.equal(h.store.getState().page, 'rules')
    assert.equal(h.store.getState().goalId, undefined)
    assert.equal(h.writes.length, count)
    assert.equal(readViewRoute(new URL('http://localhost/?setup=1')).page, 'setup')
  })

  it('keeps live selection by ID and closes it if it leaves the feed without reopening later', () => {
    const h = harness()
    const one = request('r1')
    h.store.getState().openRequest(one, true)
    assert.deepEqual(h.store.getState().selection, { id: 'r1', fromLiveFeed: true, fallback: null })
    h.store.getState().reconcileRequests([{ ...one, title: 'updated' }], [])
    assert.equal(h.store.getState().selection?.id, 'r1')
    h.store.getState().reconcileRequests([], [one])
    assert.equal(h.store.getState().selection, null)
    assert.equal(h.writes.at(-1)?.replace, true)
    h.store.getState().reconcileRequests([one], [])
    assert.equal(h.store.getState().selection, null)
  })

  it('resolves deep links and preserves goal-only fallback without persisting it', () => {
    const h = harness(null, 'http://localhost/work-view?page=goals&request=older')
    const older = request('older')
    h.store.getState().reconcileRequests([], [older])
    assert.equal(h.store.getState().selection?.fromLiveFeed, false)
    assert.equal(h.store.getState().selection?.fallback, older)
    h.store.getState().reconcileRequests([], [])
    assert.equal(h.store.getState().selection?.id, 'older')
    h.store.getState().closeRequest()
    assert.equal(h.url().searchParams.has('request'), false)
    h.setUrl('http://localhost/work-view?request=unknown')
    h.store.getState().syncUrl()
    h.store.getState().reconcileRequests([], [])
    assert.equal(h.store.getState().selection, null)
  })
})
