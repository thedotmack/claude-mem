// Run with `npm test`. What the thread search finds, in what order, and what opening a result does (components/thread-search.tsx).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FocusArea, Request } from '../data.ts'
import { enterPick, isSearchShortcut, markMatches, MAX_THREAD_HITS, searchThreads, SUGGESTED_THREADS, threadOpen, type KeyPress } from './thread-search.ts'

const SESSION = '0a1b2c3d-1111-4222-8333-444455556666'
const area = (id: string, change: Partial<FocusArea> = {}) => ({ id, name: id, status: 'kept', ownerRank: null, priorityRank: null, mergedInto: null, ...change }) as FocusArea
const request = (id: string, title: string | null, change: Partial<Request> = {}) => ({
  id, title, state: 'working', startedAtIso: '2026-11-01T00:00:00Z', next: { who: 'bot', text: 'Next step not recorded' }, ...change,
}) as Request
const ids = (hits: { request: Request }[]) => hits.map((hit) => hit.request.id)
const key = (change: Partial<KeyPress>): KeyPress => ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...change })

describe('searchThreads', () => {
  const areas = [area('fa-sync', { name: 'Device sync', initiative: 'orchard' }), area('fa-old', { name: 'Old name', mergedInto: 'fa-sync' })]

  it('finds every typed word in any order and any case', () => {
    const requests = [request('a', 'Fix the Billing page layout'), request('b', 'Fix the login page')]
    assert.deepEqual(ids(searchThreads(requests, areas, 'LAYOUT billing')), ['a'])
    assert.deepEqual(ids(searchThreads(requests, areas, '  page   fix ')), ['a', 'b'])
    assert.deepEqual(ids(searchThreads(requests, areas, 'billing login')), [])
  })

  it('matches the title, the next step, the open question, the why, the focus name and the focus initiative', () => {
    const requests = [
      request('title', 'Rework the importer'),
      request('next', 'One', { next: { who: 'bot', text: 'Run the migration dry' } }),
      request('question', 'Two', { question: { text: 'Keep the legacy endpoint?' } }),
      request('why', 'Three', { why: 'Forgiving UI' }),
      request('focus', 'Four', { focusAreaId: 'fa-sync' }),
      request('merged', 'Five', { focusAreaId: 'fa-old' }),
      request('later-title', null, { resolvesTo: { title: 'Tidy the changelog', summary: '' } }),
    ]
    const found = (query: string) => ids(searchThreads(requests, areas, query))
    assert.deepEqual(found('importer'), ['title'])
    assert.deepEqual(found('migration'), ['next'])
    assert.deepEqual(found('legacy'), ['question'])
    assert.deepEqual(found('forgiving'), ['why'])
    assert.deepEqual(found('device sync'), ['focus', 'merged'])
    assert.deepEqual(found('orchard'), ['focus', 'merged'])
    assert.deepEqual(found('changelog'), ['later-title'])
    assert.deepEqual(found('four sync'), ['focus'], 'words may be spread over the title and another field')
  })

  it('does not match the placeholder shown when no next step is recorded, and gives a row no next step for it', () => {
    const requests = [request('a', 'Anything')]
    assert.deepEqual(searchThreads(requests, areas, 'recorded'), [])
    assert.equal(searchThreads(requests, areas, 'anything')[0].next, null)
  })

  it('gives a row its title, focus name and next step', () => {
    const [hit] = searchThreads([request('a', 'Sync notes', { focusAreaId: 'fa-old', next: { who: 'bot', text: 'Write the test' } })], areas, 'notes')
    assert.deepEqual({ title: hit.title, focusName: hit.focusName, next: hit.next }, { title: 'Sync notes', focusName: 'Device sync', next: 'Write the test' })
  })

  it('ranks a title match above any other match, then a person\'s move, working, idle and shipped, then the newest', () => {
    const human = { who: 'human', need: 'answer', text: 'x' } as const
    const requests = [
      request('why-move', 'Other thing', { why: 'cache', state: 'your-move', next: human }),
      request('title-shipped', 'Cache docs', { state: 'shipped' }),
      request('title-idle', 'Cache cleanup', { state: 'idle' }),
      request('title-working-old', 'Cache warmup', { startedAtIso: '2026-11-01T00:00:00Z' }),
      request('title-working-new', 'Cache keys', { startedAtIso: '2026-11-03T00:00:00Z' }),
      request('title-move', 'Cache size?', { state: 'your-move', next: human }),
    ]
    assert.deepEqual(ids(searchThreads(requests, areas, 'cache')), ['title-move', 'title-working-new', 'title-working-old', 'title-idle', 'title-shipped', 'why-move'])
  })

  it('with nothing typed lists the open threads, what waits on a person first, and no more than a few', () => {
    const human = { who: 'human', need: 'review', text: 'x' } as const
    const requests = [
      ...Array.from({ length: 12 }, (_, index) => request(`w${index}`, `Working ${index}`)),
      request('closed', 'Closed chat', { state: 'closed', next: { who: 'bot', text: '' } }),
      request('checked', 'Checked work', { state: 'checked', next: { who: 'bot', text: '' } }),
      request('shipped', 'Shipped work', { state: 'shipped' }),
      request('move', 'Needs you', { state: 'your-move', next: human }),
    ]
    const few = [requests[0], ...requests.slice(-4)]
    assert.deepEqual(ids(searchThreads(few, areas, '')), ['move', 'w0'], 'what rests in Done is not suggested, even with room for it')
    const hits = searchThreads(requests, areas, '   ')
    assert.equal(hits.length, SUGGESTED_THREADS)
    assert.equal(hits[0].request.id, 'move')
    for (const done of ['closed', 'checked', 'shipped']) {
      assert.ok(!ids(hits).includes(done))
      assert.deepEqual(ids(searchThreads(requests, areas, done)), [done], `a ${done} thread is still found by name`)
    }
    assert.equal(searchThreads(requests, areas, 'checked')[0].next, null, 'a checked thread has no next step to show')
  })

  it('caps a typed query\'s results', () => {
    const requests = Array.from({ length: 140 }, (_, index) => request(`r${index}`, `Thread ${index}`))
    assert.equal(searchThreads(requests, areas, 'thread').length, MAX_THREAD_HITS)
  })
})

describe('markMatches', () => {
  it('marks each matched part of the title and keeps its own letters', () => {
    assert.deepEqual(markMatches('Fix the Billing page', ['bill', 'fix']), [
      { text: 'Fix', match: true }, { text: ' the ', match: false }, { text: 'Bill', match: true }, { text: 'ing page', match: false },
    ])
  })
  it('joins marks that overlap and repeats a word found twice', () => {
    assert.deepEqual(markMatches('abcab', ['ab', 'bc']), [{ text: 'abcab', match: true }])
  })
  it('leaves a title with no match, or no query, whole', () => {
    assert.deepEqual(markMatches('Title', ['zzz']), [{ text: 'Title', match: false }])
    assert.deepEqual(markMatches('Title', []), [{ text: 'Title', match: false }])
  })
})

describe('threadOpen', () => {
  it('opens a Claude or Codex session in its app through the deep link', () => {
    assert.deepEqual(threadOpen({ id: 'r1', chat: { platform: 'claude', sessionId: SESSION } }), { kind: 'chat', href: `claude://resume?session=${SESSION}`, tool: 'Claude Code' })
    assert.deepEqual(threadOpen({ id: JSON.stringify(['conversation', 'codex', SESSION]) }), { kind: 'chat', href: `codex://threads/${SESSION}`, tool: 'Codex' })
  })
  it('opens the recorded transcript when the tool has no link of its own', () => {
    assert.deepEqual(threadOpen({ id: 'r1', chat: { platform: 'gemini', transcriptHref: '/transcripts/1' } }), { kind: 'chat', href: '/transcripts/1', tool: 'Gemini' })
  })
  it('shows the thread on the board when it has no chat, or a session id that is not a UUID', () => {
    assert.deepEqual(threadOpen({ id: 'r1' }), { kind: 'board' })
    assert.deepEqual(threadOpen({ id: 'r1', chat: { platform: 'claude', sessionId: 'x"; open -a Calculator' } }), { kind: 'board' })
    assert.deepEqual(threadOpen({ id: JSON.stringify(['conversation', 'codex', 'not-a-uuid']) }), { kind: 'board' })
  })
})

describe('isSearchShortcut', () => {
  it('is Cmd+K on a Mac and Ctrl+K elsewhere, in either letter case', () => {
    assert.equal(isSearchShortcut(key({ metaKey: true }), 'mac'), true)
    assert.equal(isSearchShortcut(key({ key: 'K', ctrlKey: true }), 'other'), true)
  })
  it('leaves a plain K, another letter and other modifier combinations alone', () => {
    assert.equal(isSearchShortcut(key({}), 'mac'), false)
    assert.equal(isSearchShortcut(key({}), 'other'), false)
    assert.equal(isSearchShortcut(key({ key: 'j', metaKey: true }), 'mac'), false)
    assert.equal(isSearchShortcut(key({ metaKey: true, shiftKey: true }), 'mac'), false)
    assert.equal(isSearchShortcut(key({ ctrlKey: true, altKey: true }), 'other'), false)
    assert.equal(isSearchShortcut(key({ ctrlKey: true }), 'mac'), false, 'Ctrl+K deletes to the end of the line in a Mac text field')
    assert.equal(isSearchShortcut(key({ metaKey: true }), 'other'), false)
  })
})

describe('enterPick', () => {
  const chat = threadOpen({ id: 'r1', chat: { platform: 'claude', sessionId: SESSION } })
  const noChat = threadOpen({ id: 'r1' })
  it('shows the thread on the board on plain Enter and opens its chat with Cmd or Ctrl', () => {
    assert.equal(enterPick(key({ key: 'Enter' }), chat), 'board')
    assert.equal(enterPick(key({ key: 'Enter', metaKey: true }), chat), 'chat')
    assert.equal(enterPick(key({ key: 'Enter', ctrlKey: true }), chat), 'chat')
  })
  it('shows a thread with no chat link on the board with either Enter', () => {
    assert.equal(enterPick(key({ key: 'Enter' }), noChat), 'board')
    assert.equal(enterPick(key({ key: 'Enter', metaKey: true }), noChat), 'board')
    assert.equal(enterPick(key({ key: 'Enter', ctrlKey: true }), noChat), 'board')
  })
  it('is no pick for any other key', () => {
    assert.equal(enterPick(key({ metaKey: true }), chat), null)
    assert.equal(enterPick(key({ key: 'ArrowDown' }), chat), null)
  })
})
