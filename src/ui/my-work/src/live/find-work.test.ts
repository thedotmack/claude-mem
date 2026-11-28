// Find work matches the loaded work only: focus areas by name and goal, requests by title and summary, rules in use.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { sampleSource } from './sample-source.ts'
import { ruleInUse } from '../data-rules.ts'
import { findWork, FIND_RESULT_GROUPS, matchesWords } from './find-work.ts'

const MODEL = await sampleSource.loadWorkModel()

describe('Find work', () => {
  it('matches every typed word, in any order and case, and nothing when no word is typed', () => {
    assert.equal(matchesWords('viewer sync', 'Keep the remote pro Viewer in SYNC'), true)
    assert.equal(matchesWords('sync viewer', 'Keep the remote pro viewer in sync'), true)
    assert.equal(matchesWords('viewer cloud', 'Keep the remote pro viewer in sync'), false)
    assert.equal(matchesWords('  ', 'anything'), false)
    assert.equal(matchesWords('', 'anything'), false)
    // The words may sit in different fields (a request's title and its summary).
    assert.equal(matchesWords('price page', 'Fix the price', 'on the admin page'), true)
    assert.equal(matchesWords('goal', 'A name', null, undefined), false)
  })

  it('finds focus areas by name and goal, requests by title and summary, and only rules in use', () => {
    const [area] = MODEL.focusAreas.filter((entry) => entry.status === 'kept' && entry.goal)
    const byGoal = findWork(area.goal!, MODEL)
    assert.ok(byGoal.areas.some((row) => row.area.id === area.id), 'an area is found by its goal')
    assert.ok(findWork(area.name, MODEL).areas.some((row) => row.area.id === area.id), 'an area is found by its name')

    const [request] = MODEL.requests.filter((entry) => entry.title && entry.summary)
    assert.ok(findWork(request.title!, MODEL).requests.some((entry) => entry.id === request.id), 'a request by its title')
    assert.ok(findWork(request.summary!, MODEL).requests.some((entry) => entry.id === request.id), 'a request by its summary')

    const inUse = MODEL.rules.find(ruleInUse)!
    assert.deepEqual(findWork(inUse.then, MODEL).rules.map((rule) => rule.id).includes(inUse.id), true)
    const waiting = MODEL.rules.find((rule) => !ruleInUse(rule))
    assert.ok(waiting, 'the sample has a rule that is not in use')
    assert.equal(findWork(waiting.then, MODEL).rules.some((rule) => rule.id === waiting.id), false, 'a learned or switched-off rule is not in use')
  })

  it('counts every area\'s requests and keeps nothing a match did not earn; nothing typed finds nothing', () => {
    const empty = findWork('', MODEL)
    for (const group of FIND_RESULT_GROUPS) assert.deepEqual(empty[group], [], group)
    const all = findWork('e', MODEL)
    for (const row of all.areas) {
      assert.equal(row.requests.length, MODEL.requests.filter((request) => request.focusAreaId === row.area.id).length, row.area.name)
    }
    // A merged or dismissed area is never a result: it opens another area, or none.
    assert.equal(all.areas.some((row) => row.area.mergedInto || row.area.status === 'dismissed'), false)
  })
})
