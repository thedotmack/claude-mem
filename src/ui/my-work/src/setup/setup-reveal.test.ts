// Run with `npm test`. The Reveal's sets from the live work view snapshot (install-funnel plan Phase 5).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promptStamp, revealFromSnapshot, type SnapshotWithSetup, type WorkerExtraction } from './setup-reveal.ts'

const extraction = (state: WorkerExtraction['state']): WorkerExtraction => ({ state, reason: 'setup-scan', step: null, agent: null, startedAt: null, finishedAt: null, error: null })
const base = (changes: Partial<SnapshotWithSetup> = {}): SnapshotWithSetup => ({
  version: 1, generatedAt: '2026-10-22T12:00:00Z', agents: [{ id: 'a1', label: 'Codex', platformSource: 'codex', sessionTitle: null, project: null, contentSessionId: null }],
  humanRequests: [], unlinkedWork: [], revision: '1', source: { kind: 'local', connected: true, error: null, lastCheckedAt: null },
  goals: null, rules: [], story: null, setup: { extraction: extraction('running') }, ...changes,
})
const goalItem = (id: string, rank: number) => ({ id, task: `Priority: ${id}`, kind: 'priority' as const, rank, title: id, product: null, latestAt: '2026-10-21 17:42', timesAsked: 3, status: 'todo', evidence: [{ at: '2026-10-21 17:42', quote: 'ship it' }] })

describe('the Reveal from the live snapshot', () => {
  it('nothing landed yet: every set is still extracting', () => {
    assert.deepEqual(revealFromSnapshot(base()), { goals: null, work: null, rules: null })
  })
  it('goals land first, in rank order, with the typed minute', () => {
    const goals = { listId: 'l', listName: 'owner-goals', history: false, project: 'p', updatedAt: '', periodStart: null, periodEnd: null, summary: null, generatedAt: '2026-10-22T00:00:00Z', windowDays: 30, sourcePromptCount: 9, mapPath: null, priorities: [goalItem('second', 2), goalItem('first', 1)], openAsks: [] }
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
    assert.deepEqual(revealFromSnapshot(base({ setup: { extraction: extraction('ok') } })), { goals: [], work: [], rules: [] })
    assert.deepEqual(revealFromSnapshot(base({ setup: { extraction: extraction('waiting-for-agent') } })), { goals: null, work: null, rules: null })
  })
})
