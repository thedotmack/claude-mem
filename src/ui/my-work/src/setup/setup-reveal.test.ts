// Run with `npm test`. The Reveal's sets from the live work view snapshot (install-funnel plan Phase 5).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { promptStamp, recordedNextStepText, revealFromSnapshot, type SnapshotWithSetup, type WorkerExtraction } from './setup-reveal.ts'
import { NEXT_STEP_NOT_RECORDED, NO_WORK_YET } from '../live/to-work-model.ts'
import type { WorkViewFocusArea } from '../live/work-view-api-types.ts'

const extraction = (state: WorkerExtraction['state']): WorkerExtraction => ({ state, reason: 'setup-scan', step: null, agent: null, startedAt: null, finishedAt: null, error: null })
const base = (changes: Partial<SnapshotWithSetup> = {}): SnapshotWithSetup => ({
  version: 1, generatedAt: '2026-10-22T12:00:00Z', agents: [{ id: 'a1', label: 'Codex', platformSource: 'codex', sessionTitle: null, project: null, contentSessionId: null }],
  humanRequests: [], unlinkedWork: [], revision: '1', source: { kind: 'local', connected: true, error: null, lastCheckedAt: null },
  goals: null, rules: [], story: null, setup: { extraction: extraction('running') }, ...changes,
})
const goalItem = (id: string, rank: number) => ({ id, task: `Focus area: ${id}`, kind: 'focus-area' as const, rank, title: id, goal: null, focusArea: null, focusAreaId: null, product: null, latestAt: '2026-10-21 17:42', timesAsked: 3, status: 'todo', evidence: [{ at: '2026-10-21 17:42', quote: 'ship it' }] })

describe('the Reveal from the live snapshot', () => {
  it('nothing landed yet: every set is still extracting', () => {
    assert.deepEqual(revealFromSnapshot(base()), { goals: null, work: null, rules: null, focusAreas: null, requests: [], requestReadErrorCount: 0 })
  })
  it('goals land first, in rank order, with the typed minute', () => {
    const goals = { listId: 'l', listName: 'owner-goals', history: false, project: 'p', updatedAt: '', periodStart: null, periodEnd: null, summary: null, generatedAt: '2026-10-22T00:00:00Z', windowDays: 30, sourcePromptCount: 9, mapPath: null, areas: [goalItem('second', 2), goalItem('first', 1)], asks: [] }
    const reveal = revealFromSnapshot(base({ goals }))
    assert.deepEqual(reveal.goals, [{ id: 'first', rank: 1, title: 'first', timesAsked: 3, latestAt: '10-21 17:42' }, { id: 'second', rank: 2, title: 'second', timesAsked: 3, latestAt: '10-21 17:42' }])
    assert.equal(reveal.work, null)
  })
  it('work lands from the request groups, as the worker orders them; a review without evidence has no bar', () => {
    const work = [
      { groupId: 'g_new', title: 'New thing', platform: 'codex', lastActiveAt: '2026-10-21T17:42:00.000Z', progressPercent: 40 },
      { groupId: 'g_old', title: 'Old thing', platform: 'claude', lastActiveAt: '2026-10-19T11:05:00.000Z', progressPercent: null },
    ]
    const reveal = revealFromSnapshot(base({ setup: { extraction: extraction('running'), work } }))
    assert.deepEqual(reveal.work?.map((item) => [item.id, item.title, item.agent, item.progressPercent, item.lastActiveAt]),
      [['g_new', 'New thing', 'codex', 40, promptStamp('2026-10-21T17:42:00.000Z')], ['g_old', 'Old thing', 'claude', undefined, promptStamp('2026-10-19T11:05:00.000Z')]])
    assert.equal(reveal.rules, null)
  })
  it('rules land with the story, quoted; dismissed rules and unquoted ones stay out', () => {
    const rule = (ruleId: string, status: string, quotes: { at: string | null; quote: string; kind: string }[]) => ({ ruleId, scopeId: 'everywhere', scopeTier: 'everywhere' as const, scopeName: 'Everywhere', when: '', then: `Rule ${ruleId}`, setBy: 'learned' as const, status: status as 'on', kind: 'directive', source: 'request-progress', timesSeen: 1, latestAt: null, quotes, replacedBy: null, replacedAt: null, savedAt: null })
    const quote = [{ at: '2026-10-20T10:00:00.000Z', quote: 'never open a draft PR', kind: 'directive' }]
    const reveal = revealFromSnapshot(base({ story: { groups: 1, story: { narrative: 'x', writtenAt: null } }, rules: [rule('kept', 'suggested', quote), rule('gone', 'dismissed', quote), rule('bare', 'on', [])] }))
    assert.deepEqual(reveal.rules, [{ id: 'kept', text: 'Rule kept', quote: 'never open a draft PR', quotedAt: promptStamp('2026-10-20T10:00:00.000Z') }])
  })
  it('a finished run leaves the sets it found nothing for empty, not loading', () => {
    assert.deepEqual(revealFromSnapshot(base({ setup: { extraction: extraction('ok') } })), { goals: [], work: [], rules: [], focusAreas: [], requests: [], requestReadErrorCount: 0 })
    assert.deepEqual(revealFromSnapshot(base({ setup: { extraction: extraction('failed') } })), { goals: [], work: [], rules: [], focusAreas: [], requests: [], requestReadErrorCount: 0 })
    assert.deepEqual(revealFromSnapshot(base({ setup: { extraction: extraction('waiting-for-agent') } })), { goals: null, work: null, rules: null, focusAreas: null, requests: [], requestReadErrorCount: 0 })
  })
  it('a saved focus area lands before work or rules, preserving its id, owner order, words and scope', () => {
    const area = (focusAreaId: string, ownerRank: number): WorkViewFocusArea => ({
      focusAreaId, name: `Area ${focusAreaId}`, goal: 'Ship a useful work view.', about: 'The viewer and its onboarding payoff.',
      status: 'kept', priorityRank: 1, ownerRank, source: 'owner-goals', mergedInto: null, evidence: null, decidedBy: 'owner', savedAt: null,
    })
    const goals = {
      listId: 'l', listName: 'owner-goals', history: false, project: 'p', updatedAt: '', periodStart: null, periodEnd: null,
      summary: null, generatedAt: '2026-10-22T00:00:00Z', windowDays: 30, sourcePromptCount: 9, mapPath: null,
      areas: [{ ...goalItem('g1', 1), focusAreaId: 'fa_work' }], asks: [],
    }
    const reveal = revealFromSnapshot(base({ goals, focusAreas: [area('fa_other', 2), area('fa_work', 1)] }))
    assert.deepEqual(reveal.focusAreas?.map((item) => item.id), ['fa_work', 'fa_other'])
    assert.equal(reveal.focusAreas?.[0].goal, 'Ship a useful work view.')
    assert.equal(reveal.focusAreas?.[0].about, 'The viewer and its onboarding payoff.')
    assert.deepEqual(reveal.focusAreas?.[0].quotes, [{ quote: 'ship it', at: '10-21 17:42' }])
    assert.equal(reveal.focusAreas?.[0].timesAsked, 3)
    assert.equal(reveal.work, null)
    assert.equal(reveal.rules, null)
  })
  it('request membership uses recorded placement and merge targets; similar words never create a placement', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../test-fixtures/work-view-snapshot.trimmed.json', import.meta.url), 'utf8')) as SnapshotWithSetup
    const template = fixture.humanRequests[0]
    const area = (focusAreaId: string, mergedInto: string | null = null): WorkViewFocusArea => ({
      focusAreaId, name: 'Viewer', goal: null, status: 'kept', priorityRank: null, ownerRank: null,
      source: 'owner', mergedInto, evidence: null, decidedBy: 'owner', savedAt: null,
    })
    const { focusAreaId: _unused, ...unplaced } = template
    const reveal = revealFromSnapshot({ ...fixture,
      focusAreas: [area('fa_old', 'fa_work'), area('fa_work')],
      humanRequests: [{ ...template, id: 'placed', focusAreaId: 'fa_old' }, { ...unplaced, id: 'unplaced' }],
    })
    assert.deepEqual(reveal.requests?.map((request) => [request.id, request.focusAreaId]), [['placed', 'fa_work'], ['unplaced', undefined]])
    assert.deepEqual(reveal.focusAreas?.map((item) => item.id), ['fa_old', 'fa_work'])
    assert.equal(reveal.requests?.[0].progress.percent, null, 'unreviewed source work must not acquire progress')
  })
  it('owner-goals words without a saved focus-area id do not invent a new area', () => {
    const goals = {
      listId: 'l', listName: 'owner-goals', history: false, project: 'p', updatedAt: '', periodStart: null, periodEnd: null,
      summary: null, generatedAt: '2026-10-22T00:00:00Z', windowDays: 30, sourcePromptCount: 9, mapPath: null,
      areas: [goalItem('g1', 1)], asks: [],
    }
    assert.equal(revealFromSnapshot(base({ goals })).focusAreas, null)
    assert.deepEqual(revealFromSnapshot(base({ goals, setup: { extraction: extraction('ok') } })).focusAreas, [])
  })
  it('an unreadable request is counted separately from no recorded work while readable requests survive', () => {
    const fixture = JSON.parse(readFileSync(new URL('../../test-fixtures/work-view-snapshot.trimmed.json', import.meta.url), 'utf8')) as SnapshotWithSetup
    const template = fixture.humanRequests[0]
    const reveal = revealFromSnapshot({ ...fixture, humanRequests: [
      { ...template, id: 'readable' },
      { ...template, id: 'unreadable', lifecycle: { status: 'shipped', explicit: true }, completedAtEpoch: null },
    ] })
    assert.equal(reveal.requestReadErrorCount, 1)
    assert.deepEqual(reveal.requests?.map((request) => request.id), ['readable'])
  })
})

describe('recordedNextStepText', () => {
  // The reader's words: English here, as t() answers with no catalog for the language.
  const english = (text: string) => text
  it('prints a recorded next step and leaves out the filler for a missing one (G3)', () => {
    assert.equal(recordedNextStepText({ next: { who: 'human', text: '  Write the release notes ' } }, english), 'Write the release notes')
    assert.equal(recordedNextStepText({ next: { who: 'bot', text: NEXT_STEP_NOT_RECORDED } }, english), null)
    assert.equal(recordedNextStepText({ next: { who: 'bot', text: '   ' } }, english), null)
  })
  it('leaves out the filler of a request that has only asks: it is not a next step either (G3)', () => {
    assert.equal(recordedNextStepText({ next: { who: 'bot', text: NO_WORK_YET } }, english), null)
    // As the Reveal gets it: the mapper writes the missing value for a request with no agent work (G3, never the
    // English filler), and the Reveal drops it.
    const fixture = JSON.parse(readFileSync(new URL('../../test-fixtures/work-view-snapshot.trimmed.json', import.meta.url), 'utf8')) as SnapshotWithSetup
    const asksOnly = { ...fixture.humanRequests[0], id: 'asks-only', items: [], activity: [], progress: null, humanCopy: null }
    const [request] = revealFromSnapshot({ ...fixture, humanRequests: [asksOnly] }).requests ?? []
    assert.equal(request?.next?.missing, 'no-agent-work')
    assert.equal(request?.next?.text, undefined)
    assert.equal(recordedNextStepText(request, english), null)
  })
  it('asks the one rule My Work asks (nextStepShown): every missing value and older filler is left out, and a checked or blocked request prints its step in the reader’s words', () => {
    assert.equal(recordedNextStepText({ next: { who: 'bot', missing: 'not-recorded' } }, english), null)
    assert.equal(recordedNextStepText({ next: { who: 'bot', missing: 'no-agent-work' } }, english), null)
    assert.equal(recordedNextStepText({ next: { who: 'human', kind: 'unblock', missing: 'not-recorded' } }, english), null)
    assert.equal(recordedNextStepText({ next: { who: 'human', text: `Unblock: ${NO_WORK_YET}` } }, english), null)
    assert.equal(recordedNextStepText({ next: { who: 'human', kind: 'ship' } }, english), 'Ship it')
    assert.equal(recordedNextStepText({ next: { who: 'human', kind: 'unblock', text: 'Grant the deploy token' } }, english), 'Unblock: Grant the deploy token')
    // What older workers wrote for the same two steps reads the same (G19).
    assert.equal(recordedNextStepText({ next: { who: 'human', text: 'Ship it' } }, english), 'Ship it')
    assert.equal(recordedNextStepText({ next: { who: 'human', text: 'Unblock: Grant the deploy token' } }, english), 'Unblock: Grant the deploy token')
    const french = (text: string) => ({ 'Ship it': 'À publier', 'Unblock: {step}': 'Débloquer : {step}' } as Record<string, string>)[text] ?? text
    assert.equal(recordedNextStepText({ next: { who: 'human', kind: 'ship' } }, french), 'À publier')
    assert.equal(recordedNextStepText({ next: { who: 'human', kind: 'unblock', text: 'Grant the deploy token' } }, french), 'Débloquer : Grant the deploy token')
  })
})
