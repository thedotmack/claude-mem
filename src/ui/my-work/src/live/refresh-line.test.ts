import assert from 'node:assert/strict'
import { test } from 'node:test'
import { myworkFr } from '../../../i18n/mywork-fr.ts'
import { myworkKo } from '../../../i18n/mywork-ko.ts'
import { myworkTr } from '../../../i18n/mywork-tr.ts'
import { myworkZh } from '../../../i18n/mywork-zh.ts'
import { REFRESH_START_REFUSAL, WAITING_FOR_AGENT_REASON } from '../../../../shared/work-view-refresh-reasons.ts'
import type { AutoRefresh } from './work-data-source.ts'
import { REFRESH_LINE_STATES, pageStartsRefresh, refreshLineState, refreshRecordKey, shownRefreshLine, type RefreshPressAnswer } from './refresh-line.ts'

test('the refresh line reads each worker run state as one of its four states', () => {
  assert.equal(refreshLineState(null), 'up-to-date', 'before the first refresh the last saved run shows')
  assert.equal(refreshLineState({ state: 'idle' }), 'up-to-date')
  assert.equal(refreshLineState({ state: 'ok' }), 'up-to-date')
  assert.equal(refreshLineState({ state: 'running' }), 'updating')
  assert.equal(refreshLineState({ state: 'failed' }), 'failed')
  assert.equal(refreshLineState({ state: 'waiting-for-agent' }), 'waiting-for-agent')
  // Every state the line has is one the worker's states can reach.
  const reached = new Set((['idle', 'ok', 'running', 'failed', 'waiting-for-agent'] as const).map((state) => refreshLineState({ state })))
  assert.deepEqual([...reached].sort(), [...REFRESH_LINE_STATES].sort())
})

test('only the page this computer’s worker serves can start a refresh', () => {
  assert.equal(pageStartsRefresh('local'), true)
  assert.equal(pageStartsRefresh('cloud'), false, 'the refresh route answers loopback only')
  assert.equal(pageStartsRefresh('sample'), false, 'the sample has its own pretend button')
  assert.equal(pageStartsRefresh(null), false)
})

const FAILED: AutoRefresh = { state: 'failed', finishedAt: 'Nov 16 at 12:19 pm', finishedAtIso: '2026-11-16T20:19:00.000Z', error: 'database is locked' }
const press = (state: string, shown: AutoRefresh | null = FAILED): RefreshPressAnswer => ({ state, atIso: '2026-11-16T22:31:00.000Z', recordAtPress: refreshRecordKey(shown) })

test('Try again always shows its outcome, even when the worker had nothing due (it looked dead)', () => {
  // Nothing was due: the worker keeps its failed record, and the line adds "Nothing new to refresh" under it.
  assert.deepEqual(shownRefreshLine(FAILED, press('idle')), { state: 'failed', failedAtIso: null, nothingNew: true })
  // A run started: the line reads updating at once, before the worker's record says so.
  assert.deepEqual(shownRefreshLine(FAILED, press('running')), { state: 'updating', failedAtIso: null, nothingNew: false })
  // It failed again before starting: the line shows the new failure's time, not the old one's.
  assert.deepEqual(shownRefreshLine(FAILED, press('failed')), { state: 'failed', failedAtIso: '2026-11-16T22:31:00.000Z', nothingNew: false })
})

test('once the worker’s record changes, the line shows that record: up to date, or a failure with its own time', () => {
  const ok: AutoRefresh = { state: 'ok', finishedAt: 'Nov 16 at 2:35 pm', finishedAtIso: '2026-11-16T22:35:00.000Z', error: null }
  assert.deepEqual(shownRefreshLine(ok, press('running')), { state: 'up-to-date', failedAtIso: null, nothingNew: false })
  const failedAgain: AutoRefresh = { ...FAILED, finishedAt: 'Nov 16 at 2:36 pm', finishedAtIso: '2026-11-16T22:36:00.000Z' }
  assert.deepEqual(shownRefreshLine(failedAgain, press('running')), { state: 'failed', failedAtIso: null, nothingNew: false })
  assert.deepEqual(shownRefreshLine({ ...FAILED, state: 'running', finishedAt: null, finishedAtIso: undefined }, press('running')), { state: 'updating', failedAtIso: null, nothingNew: false })
  // With no press, the record is all there is.
  assert.deepEqual(shownRefreshLine(FAILED, null), { state: 'failed', failedAtIso: null, nothingNew: false })
})

test('the worker’s sentences the line shows as they are have words in every My Work language', () => {
  for (const sentence of [...Object.values(REFRESH_START_REFUSAL), ...Object.values(WAITING_FOR_AGENT_REASON)]) {
    for (const [locale, catalog] of Object.entries({ zh: myworkZh, ko: myworkKo, tr: myworkTr, fr: myworkFr })) {
      assert.ok(catalog[sentence], `${locale} has no words for “${sentence}”`)
    }
  }
})
