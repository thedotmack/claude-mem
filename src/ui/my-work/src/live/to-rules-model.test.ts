// My Rules from the worker's rules (plan Phase 8): story suggestions laid over by saved my-rules rows. Made-up text.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { toWorkModel } from './to-work-model.ts'
import type { WorkViewRule, WorkViewSnapshot } from './work-view-api-types.ts'

const appRoot = new URL('../../', import.meta.url)
const baseSnapshot = JSON.parse(readFileSync(new URL('test-fixtures/work-view-snapshot.trimmed.json', appRoot), 'utf8')) as WorkViewSnapshot
const now = Date.parse('2026-10-21T12:00:00Z')

const suggestion: WorkViewRule = {
  ruleId: 'pref_0123456789ab', scopeId: 'everywhere', scopeTier: 'everywhere', scopeName: 'Everywhere', when: '', then: 'Water the tomatoes before noon.',
  setBy: 'learned', status: 'suggested', kind: 'correction', source: 'request-progress', timesSeen: 3, latestAt: '2026-10-18T10:00:00Z',
  quotes: [{ at: '2026-10-18T10:00:00Z', quote: 'they wilt if you wait', kind: 'correction' }], replacedBy: null, replacedAt: null, savedAt: null,
}
const ownRule: WorkViewRule = {
  ...suggestion, ruleId: 'own_aaaaaaaaaaaa', scopeId: 'project:garden planner', scopeTier: 'project', scopeName: 'garden planner', when: 'you plan beds', then: 'Leave a path.',
  setBy: 'owner', status: 'on', source: 'you', timesSeen: 1, quotes: [], savedAt: '2026-10-20T09:00:00Z',
}
const scopes = [{ id: 'everywhere', tier: 'everywhere' as const, name: 'Everywhere' }, { id: 'project:garden planner', tier: 'project' as const, name: 'garden planner' }]
const mapRules = (extra: Partial<WorkViewSnapshot>) => toWorkModel({ ...baseSnapshot, ...extra }, now)

test('suggested and owner rules keep their words, counts and scopes', () => {
  const model = mapRules({ rules: [suggestion, ownRule], ruleScopes: scopes, rulesLearning: { preferencesFound: 1, newSuggestions: 1, reviewsRead: 4, writtenAt: '2026-10-19T09:32:04Z' }, rulesFile: { path: '~/.claude-mem/MY-RULES.md', approvedCount: 1, loadedInClaudeCode: false } })
  assert.equal(model.rulesReadError, null)
  const [learned, own] = model.rules
  assert.deepEqual([learned.id, learned.status, learned.setBy, learned.when, learned.then, learned.timesSeen, learned.source], ['pref_0123456789ab', 'suggested', 'learned', '', 'Water the tomatoes before noon.', 3, 'request-progress'])
  assert.equal(learned.quotes[0].quote, 'they wilt if you wait')
  assert.equal(learned.quotes[0].kind, 'correction')
  assert.equal(learned.latestDaysAgo, 3)
  assert.ok(learned.records.some((record) => record.kind === 'Review'))
  assert.deepEqual([own.scopeId, own.setBy, own.source], ['project:garden planner', 'owner', 'you'])
  assert.ok(own.records.some((record) => record.label === 'Written in My Rules on this computer'))
  assert.deepEqual(model.rulesLearning, { preferencesFound: 1, newSuggestions: 1, reviewsRead: 4 })
  assert.equal(model.rulesFile?.loadedInClaudeCode, false)
  assert.equal(model.lastRuns.progress?.label, 'request-progress')
})

test('no story and no saved rules: no rules, no learning run, no error', () => {
  const model = mapRules({})
  assert.deepEqual([model.rules, model.ruleScopes, model.rulesLearning, model.rulesFile, model.rulesReadError, model.lastRuns.progress], [[], [], null, null, null, null])
})

test('a rule in an unlisted scope or from an unknown source empties My Rules with the reason', () => {
  assert.match(mapRules({ rules: [ownRule], ruleScopes: [scopes[0]] }).rulesReadError!, /scope the worker did not list/)
  assert.match(mapRules({ rules: [{ ...suggestion, source: 'somewhere' }], ruleScopes: scopes }).rulesReadError!, /unknown source/)
})
