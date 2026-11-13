// Run with `npm test`. The thread list's order and sections (components/thread-list.tsx).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FocusArea, Request } from '../data.ts'
import { statusCounts } from './status-label.ts'
import { FILTER_MATCHES } from './work-filters.ts'
import { fileUnderNone, focusSections, gripKeyMove, initiativeChange, isOrderable, keptByOrder, mergeInitiatives, moveChoices, moveOwner, movePeer, moveToInitiative, placeInOrder, renameInitiative, reorderWithin, savedFocusArrangement, sortThreads, threadAction, threadGroups, type FocusArrangement, type InitiativeSection } from './thread-groups.ts'

const area = (id: string, change: Partial<FocusArea> = {}) => ({ id, name: id, status: 'kept', ownerRank: null, priorityRank: null, mergedInto: null, ...change }) as FocusArea
const request = (id: string, state: Request['state'], focusAreaId?: string, startedAtIso = '2026-11-01T00:00:00Z') => ({ id, state, focusAreaId, startedAtIso, next: state === 'your-move' || state === 'needs-check' ? { who: 'human', need: 'review', text: 'x' } : { who: 'bot', text: 'x' } }) as Request
const ids = (requests: Request[]) => requests.map((entry) => entry.id)

describe('sortThreads', () => {
  it('puts what waits on a person first, and the newest first within a state', () => {
    const sorted = sortThreads([
      request('shipped', 'shipped'), request('old-move', 'your-move', undefined, '2026-11-01T00:00:00Z'), request('working', 'working'),
      request('check', 'needs-check'), request('new-move', 'your-move', undefined, '2026-11-02T00:00:00Z'), request('idle', 'idle'),
    ])
    assert.deepEqual(ids(sorted), ['new-move', 'old-move', 'check', 'working', 'idle', 'shipped'])
  })
  it('puts a shipped request that still owes a person a step above work an agent has', () => {
    const owed = { ...request('shipped-owed', 'shipped'), next: { who: 'human', need: 'approval', text: 'x' } } as Request
    assert.deepEqual(ids(sortThreads([request('working', 'working'), owed])), ['shipped-owed', 'working'])
  })
})

describe('threadGroups', () => {
  const areas = [
    area('second', { priorityRank: 2 }), area('first', { priorityRank: 1 }), area('suggested', { status: 'suggested', priorityRank: 0 }),
    area('finished', { status: 'done' }), area('merged', { mergedInto: 'first' }), area('dismissed', { status: 'dismissed' }), area('empty'),
  ]

  it('lists areas in priority order, then Other, then what is not sorted yet', () => {
    const groups = threadGroups(areas, [
      request('unsorted', 'working'), request('other', 'working', 'other'), request('b', 'working', 'second'), request('a', 'working', 'first'),
      request('s', 'working', 'suggested'), request('d', 'shipped', 'finished'),
    ])
    assert.deepEqual(groups.map((group) => group.key), ['first', 'second', 'empty', 'suggested', 'finished', 'other', 'not-sorted'])
    assert.deepEqual(groups.map((group) => group.kind), ['area', 'area', 'area', 'area', 'area', 'other', 'sorting'])
  })

  it('under Open, hides what rests in Done from the rows and still counts it on the focus line', () => {
    const groups = threadGroups(areas, [
      request('a', 'working', 'first'), request('a-shipped', 'shipped', 'first'), request('a-checked', 'checked', 'first'),
      request('s-closed', 'closed', 'suggested'), request('other-shipped', 'shipped', 'other'), request('unsorted-closed', 'closed'),
    ], FILTER_MATCHES.open)
    assert.deepEqual(groups.map((group) => group.key), ['first', 'second', 'empty', 'suggested'], 'a focus whose requests are all Done keeps its line; Other and not-sorted need a row')
    const first = groups[0]
    assert.deepEqual([ids(first.rows), ids(first.requests)], [['a'], ['a', 'a-checked', 'a-shipped']])
    assert.deepEqual(statusCounts(first.requests).map((entry) => [entry.bucket, entry.count]), [['working', 1], ['done', 2]])
    const suggested = groups[3]
    assert.deepEqual([ids(suggested.rows), statusCounts(suggested.requests).map((entry) => entry.label)], [[], ['1 done']])
  })

  it('lists a closed request under Other or not-sorted-yet when the filter shows Done', () => {
    const requests = [request('other-closed', 'closed', 'other'), request('unsorted-closed', 'closed')]
    const done = threadGroups(areas, requests, FILTER_MATCHES.done)
    assert.deepEqual(done.flatMap((group) => group.rows.map((row) => row.id)).sort(), ['other-closed', 'unsorted-closed'])
    const open = threadGroups(areas, requests, FILTER_MATCHES.open)
    assert.deepEqual(open.flatMap((group) => group.rows.map((row) => row.id)), [])
  })

  it('with no rule for the rows, shows every request it is given', () => {
    const [first] = threadGroups(areas, [request('a', 'working', 'first'), request('a-shipped', 'shipped', 'first')])
    assert.deepEqual(ids(first.rows), ids(first.requests))
  })

  it('keeps a kept area with no requests in the owner\'s order, and leaves every other empty group out', () => {
    const owned = [area('later', { ownerRank: 2 }), area('sooner', { ownerRank: 1 }), area('suggested', { status: 'suggested' }), area('finished', { status: 'done' }), area('merged', { mergedInto: 'sooner' })]
    assert.deepEqual(threadGroups(owned, []).map((group) => [group.key, group.requests.length]), [['sooner', 0], ['later', 0]])
    const moved = threadGroups(owned, [request('a', 'working', 'later')])
    assert.deepEqual(moved.map((group) => [group.key, ids(group.requests)]), [['sooner', []], ['later', ['a']]])
  })

  it('shows every request exactly once: a merged area\'s under its target, a dismissed or unknown area\'s as not sorted', () => {
    const requests = [request('m', 'working', 'merged'), request('x', 'working', 'dismissed'), request('u', 'working', 'nowhere'), request('a', 'your-move', 'first')]
    const groups = threadGroups(areas, requests)
    assert.deepEqual(groups.map((group) => [group.key, ids(group.requests)]), [['first', ['a', 'm']], ['second', []], ['empty', []], ['not-sorted', ['x', 'u']]])
    assert.equal(groups.flatMap((group) => group.requests).length, requests.length)
  })
})

describe('moveOwner', () => {
  it('names another person only in the team view', () => {
    assert.equal(moveOwner({ askedBy: 'Sam' }, { team: false, name: 'Alex' }), null)
    assert.equal(moveOwner({ askedBy: 'Alex' }, { team: true, name: 'Alex' }), null)
    assert.equal(moveOwner({ askedBy: 'Sam' }, { team: true, name: 'Alex' }), 'Sam')
  })
})

describe('threadAction', () => {
  const chat = { tool: 'Claude Code', title: 'Thread', transcriptHref: '/api/work-view/evidence/prompt/1' }
  const suggestion = { conversationKey: 'c', requestId: 'r', requestTitle: 'Other', evidence: '' }
  const thread = (change: Partial<Request>) => ({ state: 'your-move', next: { who: 'human', need: 'answer', text: 'x' }, chat, ...change }) as Request

  it('offers nothing on an agent\'s move', () => {
    assert.equal(threadAction(thread({ state: 'working', next: { who: 'bot', text: 'x' }, suggestion })), 'none')
  })

  it('marks a review checked in place, and sends a decision that needs reading to the request page', () => {
    const review = thread({ state: 'needs-check', next: { who: 'human', need: 'review', text: 'x' } })
    assert.equal(threadAction(review), 'mark-checked')
    assert.equal(threadAction({ ...review, review: { mode: 'shared', hash: null, available: true, conflict: true } }), 'open-request')
    assert.equal(threadAction({ ...review, review: { mode: 'shared', hash: null, available: false } }), 'open-request')
  })

  it('answers a grouping suggestion in place only when an approval is what is needed', () => {
    assert.equal(threadAction(thread({ next: { who: 'human', need: 'approval', text: 'x' }, suggestion })), 'answer-suggestion')
    assert.equal(threadAction(thread({ next: { who: 'human', need: 'approval', text: 'x' } })), 'open-chat')
    assert.equal(threadAction(thread({ suggestion })), 'open-chat')
  })

  it('opens the chat for an answer, and offers nothing when no chat can be opened', () => {
    assert.equal(threadAction(thread({})), 'open-chat')
    assert.equal(threadAction(thread({ chat: { platform: 'claude', sessionId: 'not-a-uuid' } })), 'none')
    assert.equal(threadAction(thread({ chat: undefined })), 'none')
  })
})

describe('focusSections', () => {
  const guess = (initiative: string) => ({ initiative, initiativeGuess: true as const })
  const areas = [
    area('atlas-2', { ownerRank: 3, ...guess('atlas') }), area('harbor-1', { ownerRank: 1, initiative: 'Harbor' }), area('loose', { ownerRank: 2 }),
    area('atlas-1', { ownerRank: 4, ...guess('atlas') }), area('harbor-idea', { status: 'suggested', priorityRank: 1, ...guess('harbor') }),
  ]
  const groups = threadGroups(areas, [request('a', 'working', 'atlas-1'), request('h', 'working', 'harbor-idea'), request('o', 'working', 'other'), request('s', 'working')])
  const shape = (arrangement: FocusArrangement) => focusSections(groups, arrangement).map((section) => [section.kind, section.kind === 'initiative' ? section.initiative : null, section.groups.map((group) => group.key)])

  it('is the one flat list, in priority order, when arranged by priority', () => {
    assert.deepEqual(shape('priority'), [['plain', null, ['harbor-1', 'loose', 'atlas-2', 'atlas-1', 'harbor-idea', 'other', 'not-sorted']]])
  })
  it('puts each initiative under its own heading, in the order of its best-ranked focus, with its focuses in priority order', () => {
    assert.deepEqual(shape('initiative').slice(0, 2), [['initiative', 'Harbor', ['harbor-1', 'harbor-idea']], ['initiative', 'atlas', ['atlas-2', 'atlas-1']]])
  })
  it('makes one heading of names that differ only by case, spelled as the owner filed it, even when the guess ranks first', () => {
    const mixed = threadGroups([area('g', { ownerRank: 1, ...guess('harbor ') }), area('o', { ownerRank: 2, initiative: 'Harbor' })], [])
    assert.deepEqual(focusSections(mixed, 'initiative').map((section) => section.kind === 'initiative' && [section.key, section.initiative, section.guess]), [['initiative:harbor', 'Harbor', false]])
  })
  it('marks a heading as a guess only while nobody filed any of its focuses there', () => {
    const sections = focusSections(groups, 'initiative')
    assert.deepEqual(sections.flatMap((section) => section.kind === 'initiative' ? [[section.initiative, section.guess]] : []), [['Harbor', false], ['atlas', true]])
  })
  it('lists focuses with no initiative last among the focuses, then what is not a focus, under no heading', () => {
    assert.deepEqual(shape('initiative').slice(2), [['no-initiative', null, ['loose']], ['plain', null, ['other', 'not-sorted']]])
  })
  it('leaves out a heading nothing is under', () => {
    const onlyFiled = threadGroups([area('atlas-1', { initiative: 'atlas' })], [])
    assert.deepEqual(focusSections(onlyFiled, 'initiative').map((section) => section.kind), ['initiative'])
  })
  it('reads an arrangement saved as "project" as by initiative, and drops a value it does not know', () => {
    assert.deepEqual(['project', 'initiative', 'priority', 'status', '', 7, null, 'toString'].map(savedFocusArrangement), ['initiative', 'initiative', 'priority', undefined, undefined, undefined, undefined, undefined])
  })
})

describe('editing initiatives', () => {
  const guess = (initiative: string) => ({ initiative, initiativeGuess: true as const })
  const areas = [
    area('kite-app', { ownerRank: 1, ...guess('kite-ios') }), area('kite-site', { ownerRank: 2, ...guess('kite-web') }), area('kite-store', { ownerRank: 3, ...guess('kite-web') }),
    area('lantern', { ownerRank: 4, initiative: 'Small bets' }), area('timer', { ownerRank: 5 }),
  ]
  const section = (key: string) => focusSections(threadGroups(areas, []), 'initiative').find((entry) => entry.key === key) as InitiativeSection

  it('renames a heading by filing every focus under it in one change', () => {
    assert.deepEqual(renameInitiative(section('initiative:kite-web'), '  Kite maps '), { action: 'set-initiative', focusAreaIds: ['kite-site', 'kite-store'], initiative: 'Kite maps' })
  })
  it('merges two headings when one is renamed to the other\'s name', () => {
    const change = renameInitiative(section('initiative:kite-ios'), 'small bets')!
    assert.deepEqual(change, { action: 'set-initiative', focusAreaIds: ['kite-app'], initiative: 'small bets' })
    const merged = areas.map((entry) => change.focusAreaIds!.includes(entry.id) ? { ...entry, initiative: 'Small bets', initiativeGuess: undefined } : entry)
    assert.deepEqual(focusSections(threadGroups(merged, []), 'initiative')[0].groups.map((group) => group.key), ['kite-app', 'lantern'])
  })
  it('files a guessed heading under its own name when the owner confirms it, and saves nothing for a name already filed or an empty one', () => {
    assert.deepEqual(renameInitiative(section('initiative:kite-ios'), 'kite-ios'), { action: 'set-initiative', focusAreaIds: ['kite-app'], initiative: 'kite-ios' })
    assert.equal(renameInitiative(section('initiative:small bets'), 'Small bets'), null)
    assert.equal(renameInitiative(section('initiative:small bets'), '   '), null)
  })
  it('names the focuses that had no initiative', () => {
    assert.deepEqual(renameInitiative(section('no-initiative'), 'Tools'), { action: 'set-initiative', focusAreaIds: ['timer'], initiative: 'Tools' })
  })
  it('moves one focus to another heading, and to none as a filing of its own that also takes it off a guess', () => {
    assert.deepEqual(moveToInitiative(areas[0], 'Small bets'), { action: 'set-initiative', focusAreaIds: ['kite-app'], initiative: 'Small bets' })
    assert.deepEqual(moveToInitiative(areas[3], null), { action: 'set-initiative', focusAreaIds: ['lantern'], initiative: '', noInitiative: true })
    assert.equal(moveToInitiative(areas[3], 'small bets'), null)
    // Already under no heading: nothing to save.
    assert.equal(moveToInitiative(areas[4], null), null)
    // A guess is not the owner's filing: None takes the focus off it, and choosing its heading files it there.
    assert.deepEqual(moveToInitiative(areas[0], null), fileUnderNone(['kite-app']))
    assert.deepEqual(moveToInitiative(areas[0], 'kite-ios'), { action: 'set-initiative', focusAreaIds: ['kite-app'], initiative: 'kite-ios' })
  })
  it('lists a focus filed under none with the unfiled ones, whatever its folders', () => {
    const none = [area('kite-app', { ownerRank: 1, initiativeNone: true }), area('lantern', { ownerRank: 2, initiative: 'Small bets' })]
    assert.deepEqual(focusSections(threadGroups(none, []), 'initiative').map((entry) => [entry.kind, entry.groups.map((group) => group.key)]), [['initiative', ['lantern']], ['no-initiative', ['kite-app']]])
  })
  it('merges one heading into another by filing every live focus under it, shown or not, in one change', () => {
    const more = [...areas, area('kite-old', { status: 'done', ...guess('kite-web') }), area('kite-gone', { status: 'dismissed', ...guess('kite-web') }), area('kite-merged', { mergedInto: 'kite-site', ...guess('kite-web') })]
    const change = mergeInitiatives('kite-web', 'Small bets', more)!
    assert.deepEqual(change, { action: 'set-initiative', focusAreaIds: ['kite-site', 'kite-store', 'kite-old'], initiative: 'Small bets' })
    // The saved note says so, and one Undo puts every focus back on its guess.
    assert.deepEqual(initiativeChange(change, more, 'kite-web'), { summary: { kind: 'merged', from: 'kite-web', to: 'Small bets' }, undo: [{ action: 'set-initiative', focusAreaIds: ['kite-site', 'kite-store', 'kite-old'], initiative: '' }] })
    assert.equal(mergeInitiatives('Small bets', 'small bets ', more), null)
    assert.equal(mergeInitiatives('nothing here', 'Small bets', more), null)
    assert.equal(mergeInitiatives('kite-web', '  ', more), null)
  })
  it('undoes a change by putting each focus back where the owner had it: its filing, or its guess', () => {
    const { summary, undo } = initiativeChange({ focusAreaIds: ['kite-site', 'lantern', 'timer'], initiative: 'Everything' }, areas)
    assert.deepEqual(summary, { kind: 'filed', count: 3, to: 'Everything' })
    assert.deepEqual(undo, [{ action: 'set-initiative', focusAreaIds: ['kite-site', 'timer'], initiative: '' }, { action: 'set-initiative', focusAreaIds: ['lantern'], initiative: 'Small bets' }])
    assert.equal(initiativeChange({ focusAreaIds: ['gone'], initiative: 'x' }, areas).undo, null)
    // A focus the owner had under no heading goes back there, not onto a guess.
    const none = [area('kite-app', { initiativeNone: true }), ...areas.slice(1)]
    assert.deepEqual(initiativeChange({ focusAreaIds: ['kite-app', 'kite-site'], initiative: 'Everything' }, none).undo, [fileUnderNone(['kite-app']), { action: 'set-initiative', focusAreaIds: ['kite-site'], initiative: '' }])
  })
  it('says whether a heading was renamed, merged into another, one focus was moved, or filed under none', () => {
    const summary = (focusAreaIds: string[], initiative: string, heading?: string) => initiativeChange({ focusAreaIds, initiative }, areas, heading).summary
    assert.deepEqual(summary(['kite-site', 'kite-store'], 'Kite maps', 'kite-web'), { kind: 'renamed', from: 'kite-web', to: 'Kite maps' })
    assert.deepEqual(summary(['kite-site', 'kite-store'], 'small bets', 'kite-web'), { kind: 'merged', from: 'kite-web', to: 'small bets' })
    assert.deepEqual(summary(['kite-app'], 'Kite maps', 'kite-ios'), { kind: 'renamed', from: 'kite-ios', to: 'Kite maps' })
    // The owner confirming a guessed name is a filing, not a rename.
    assert.deepEqual(summary(['kite-site', 'kite-store'], 'kite-web', 'kite-web'), { kind: 'filed', count: 2, to: 'kite-web' })
    // From the menu, a drop or a plan there is no heading: one focus was moved, several were filed.
    assert.deepEqual(summary(['kite-app'], 'Small bets'), { kind: 'moved', name: 'kite-app', to: 'Small bets' })
    assert.deepEqual(summary(['kite-site'], 'Brand new'), { kind: 'moved', name: 'kite-site', to: 'Brand new' })
    assert.deepEqual(summary(['kite-site', 'timer'], 'Tools'), { kind: 'filed', count: 2, to: 'Tools' })
    assert.deepEqual(initiativeChange(fileUnderNone(['lantern']), areas), { summary: { kind: 'unfiled', names: ['lantern'] }, undo: [{ action: 'set-initiative', focusAreaIds: ['lantern'], initiative: 'Small bets' }] })
  })
})

describe('reordering focuses', () => {
  it('moves one focus to another place in the flat list', () => {
    const order = ['a', 'b', 'c', 'd']
    assert.deepEqual(reorderWithin(order, movePeer(order, 'd', 1)), ['a', 'd', 'b', 'c'])
    assert.deepEqual(reorderWithin(order, movePeer(order, 'a', 3)), ['b', 'c', 'd', 'a'])
    assert.deepEqual(reorderWithin(order, movePeer(order, 'b', 2)), ['a', 'c', 'b', 'd'])
  })
  it('moves a focus inside its initiative and leaves every other focus where it was', () => {
    // atlas holds a1, a2, a3; harbor holds h1, h2; x has no initiative.
    const order = ['a1', 'h1', 'a2', 'x', 'h2', 'a3']
    const moved = reorderWithin(order, movePeer(['a1', 'a2', 'a3'], 'a3', 0))
    assert.deepEqual(moved, ['a3', 'h1', 'a1', 'x', 'h2', 'a2'])
    assert.deepEqual(moved.filter((id) => !id.startsWith('a')), ['h1', 'x', 'h2'])
    assert.deepEqual([moved.indexOf('h1'), moved.indexOf('x'), moved.indexOf('h2')], [1, 3, 4])
    assert.deepEqual([...moved].sort(), [...order].sort())
  })
  it('moves the focused grip one place with Arrow Up or Arrow Down in the flat list', () => {
    const order = ['a', 'b', 'c']
    assert.deepEqual(gripKeyMove('ArrowDown', order, 'a'), ['b', 'a', 'c'])
    assert.deepEqual(gripKeyMove('ArrowUp', order, 'c'), ['a', 'c', 'b'])
    assert.deepEqual(reorderWithin(order, gripKeyMove('ArrowUp', order, 'b')!), ['b', 'a', 'c'])
  })
  it('moves the grip only inside its initiative, and other initiatives keep their places', () => {
    const order = ['a1', 'h1', 'a2', 'x', 'h2', 'a3']
    const atlas = ['a1', 'a2', 'a3']
    assert.deepEqual(reorderWithin(order, gripKeyMove('ArrowDown', atlas, 'a1')!), ['a2', 'h1', 'a1', 'x', 'h2', 'a3'])
    assert.deepEqual(reorderWithin(order, gripKeyMove('ArrowUp', atlas, 'a3')!), ['a1', 'h1', 'a3', 'x', 'h2', 'a2'])
    // The last of its initiative stays put, even with other focuses below it on the page.
    assert.equal(gripKeyMove('ArrowDown', atlas, 'a3'), null)
    assert.equal(gripKeyMove('ArrowUp', atlas, 'a1'), null)
  })
  it('saves nothing for another key or a focus that is not a peer', () => {
    assert.equal(gripKeyMove('Enter', ['a', 'b'], 'a'), null)
    assert.equal(gripKeyMove(' ', ['a', 'b'], 'a'), null)
    assert.equal(gripKeyMove('ArrowDown', ['a', 'b'], 'z'), null)
  })
  it('changes nothing for a move out of range or of a focus that is not among the peers', () => {
    assert.deepEqual(movePeer(['a', 'b'], 'a', 2), ['a', 'b'])
    assert.deepEqual(movePeer(['a', 'b'], 'a', -1), ['a', 'b'])
    assert.deepEqual(movePeer(['a', 'b'], 'z', 0), ['a', 'b'])
    assert.deepEqual(reorderWithin(['a', 'b', 'c'], ['b']), ['a', 'b', 'c'])
  })
})

describe('moving a suggested focus', () => {
  const areas = [area('a', { ownerRank: 1 }), area('b', { ownerRank: 2 }), area('c', { ownerRank: 3 }), area('s1', { status: 'suggested', priorityRank: 1 }), area('s2', { status: 'suggested', priorityRank: 2 })]
  const order = ['a', 'b', 'c']
  const peers = ['a', 'b', 'c', 's1', 's2']

  it('gives every kept and suggested focus the grip, and no done, dismissed or merged one', () => {
    assert.deepEqual([...areas, area('d', { status: 'done' }), area('x', { status: 'dismissed' }), area('m', { status: 'suggested', mergedInto: 'a' })].filter(isOrderable).map((entry) => entry.id), peers)
  })
  it('keeps a suggested focus by listing it in the order, at the place it was dropped, as one change', () => {
    assert.deepEqual(placeInOrder(order, movePeer(peers, 's1', 1), 's1'), ['a', 's1', 'b', 'c'])
    assert.deepEqual(placeInOrder(order, movePeer(peers, 's2', 0), 's2'), ['s2', 'a', 'b', 'c'])
    // Moved among the suggestions only: it is kept after the last kept focus, and the one it passed stays a suggestion.
    assert.deepEqual(placeInOrder(order, movePeer(peers, 's2', 3), 's2'), ['a', 'b', 'c', 's2'])
    assert.deepEqual(placeInOrder(order, gripKeyMove('ArrowUp', peers, 's1')!, 's1'), ['a', 'b', 's1', 'c'])
    // Nothing kept in its section yet: it goes last in the whole order.
    assert.deepEqual(placeInOrder(order, ['s2', 's1'], 's2'), ['a', 'b', 'c', 's2'])
  })
  it('moves a kept focus among the kept ones only, and saves nothing new when it only passed suggestions', () => {
    assert.deepEqual(placeInOrder(order, movePeer(peers, 'c', 0), 'c'), ['c', 'a', 'b'])
    assert.deepEqual(placeInOrder(order, movePeer(peers, 'c', 4), 'c'), order)
    assert.deepEqual(placeInOrder(['a', 'h', 'b', 'c'], movePeer(peers, 'c', 0), 'c'), ['c', 'h', 'a', 'b'])
    assert.deepEqual(placeInOrder(order, peers, 'unknown'), order)
  })
  it('names the suggestions an order keeps, for the saved note and its Undo', () => {
    assert.deepEqual(keptByOrder(['a', 's1', 'b', 'c'], areas).map((entry) => entry.id), ['s1'])
    assert.deepEqual(keptByOrder(['c', 'a', 'b'], areas), [])
    assert.deepEqual(keptByOrder(undefined, areas), [])
  })
})

describe('the Move to focus choices on a thread', () => {
  const areas = [area('second', { ownerRank: 2 }), area('first', { ownerRank: 1 }), area('idea', { status: 'suggested', priorityRank: 1 }), area('finished', { status: 'done' }), area('merged', { mergedInto: 'first' })]
  const names = (focusAreaId?: string, canMoveFocus?: boolean) => moveChoices({ focusAreaId, canMoveFocus }, areas).map((choice) => `${choice.name ?? 'Other'}${choice.suggested ? ' (suggested)' : ''}${choice.current ? ' *' : ''}`)

  it('lists the kept focuses in the owner\'s order, then the suggested ones, then Other, with the current place marked', () => {
    assert.deepEqual(names('other'), ['first', 'second', 'idea (suggested)', 'Other *'])
    assert.deepEqual(names('second'), ['first', 'second *', 'idea (suggested)', 'Other'])
    // A request filed under a merged focus sits in the one it was merged into.
    assert.deepEqual(names('merged'), ['first *', 'second', 'idea (suggested)', 'Other'])
  })
  it('marks nothing for a thread not sorted yet', () => {
    assert.deepEqual(names(undefined), ['first', 'second', 'idea (suggested)', 'Other'])
  })
  it('offers nothing when the worker would refuse the move, or there is no focus to move to', () => {
    assert.deepEqual(names('other', false), [])
    assert.deepEqual(moveChoices({ focusAreaId: 'other' }, [area('gone', { status: 'dismissed' })]), [])
  })
})
