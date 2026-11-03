import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  translate,
  normalizeLanguage,
  detectInitialLanguage,
  formatDateTime,
  formatRecordTime,
  formatDuration,
  formatPromptDay,
  formatPromptTime,
  formatEstimate,
} from './index.ts'

test('i18n translate returns translated string for zh-CN and en', () => {
  assert.equal(translate('nav.work', undefined, 'en'), 'My Work')
  assert.equal(translate('nav.work', undefined, 'zh-CN'), '我的工作')
  assert.equal(translate('state.working', undefined, 'en'), 'Working')
  assert.equal(translate('state.working', undefined, 'zh-CN'), '进行中')
})

test('i18n fallback to en when key is untranslated in zh-CN', () => {
  // If a key doesn't exist in zh-CN, it falls back to English
  assert.equal(translate('some.unknown.key', undefined, 'zh-CN'), 'some.unknown.key')
})

test('i18n parameter interpolation works correctly', () => {
  assert.equal(translate('summary.manyNeedYou', { count: 5 }, 'en'), '5 need you. First:')
  assert.equal(translate('summary.manyNeedYou', { count: 5 }, 'zh-CN'), '有 5 项任务需要你处理。首先：')
  assert.equal(translate('card.askedBy', { name: 'Alice' }, 'en'), 'asked by Alice')
  assert.equal(translate('card.askedBy', { name: 'Alice' }, 'zh-CN'), '由 Alice 提出')
})

test('normalizeLanguage handles various locale formats', () => {
  assert.equal(normalizeLanguage('zh'), 'zh-CN')
  assert.equal(normalizeLanguage('zh-CN'), 'zh-CN')
  assert.equal(normalizeLanguage('zh_CN'), 'zh-CN')
  assert.equal(normalizeLanguage('zh-TW'), 'zh-CN')
  assert.equal(normalizeLanguage('en'), 'en')
  assert.equal(normalizeLanguage('en-US'), 'en')
  assert.equal(normalizeLanguage('en_GB'), 'en')
  assert.equal(normalizeLanguage(null), null)
  assert.equal(normalizeLanguage('fr'), null)
})

test('detectInitialLanguage respects precedence order', () => {
  assert.equal(
    detectInitialLanguage({ urlParam: 'zh', savedPreference: 'en', workerLanguage: 'en', browserLanguage: 'en' }),
    'zh-CN'
  )
  assert.equal(
    detectInitialLanguage({ urlParam: null, savedPreference: 'zh-CN', workerLanguage: 'en', browserLanguage: 'en' }),
    'zh-CN'
  )
  assert.equal(
    detectInitialLanguage({ urlParam: null, savedPreference: null, workerLanguage: 'zh', browserLanguage: 'en' }),
    'zh-CN'
  )
  assert.equal(
    detectInitialLanguage({ urlParam: null, savedPreference: null, workerLanguage: null, browserLanguage: 'zh-CN' }),
    'zh-CN'
  )
  assert.equal(
    detectInitialLanguage({ urlParam: null, savedPreference: null, workerLanguage: null, browserLanguage: 'es' }),
    'en'
  )
})

test('formatDuration formats in en and zh-CN', () => {
  assert.equal(formatDuration(0, 'en'), 'Just started')
  assert.equal(formatDuration(0, 'zh-CN'), '刚刚开始')
  assert.equal(formatDuration(15 * 60000, 'en'), '15 min')
  assert.equal(formatDuration(15 * 60000, 'zh-CN'), '15 分钟')
  assert.equal(formatDuration(2 * 3600000, 'en'), '2 hr')
  assert.equal(formatDuration(2 * 3600000, 'zh-CN'), '2 小时')
  assert.equal(formatDuration(24 * 3600000, 'en'), '1 day')
  assert.equal(formatDuration(24 * 3600000, 'zh-CN'), '1 天')
  assert.equal(formatDuration(48 * 3600000, 'en'), '2 days')
  assert.equal(formatDuration(48 * 3600000, 'zh-CN'), '2 天')
})

test('formatPromptDay and formatPromptTime format correctly', () => {
  assert.equal(formatPromptDay('10-18', 'en'), 'Oct 18')
  assert.equal(formatPromptDay('10-18', 'zh-CN'), '10月18日')
  assert.equal(formatPromptTime('10-18 22:11', 'en'), 'Oct 18, 22:11')
  assert.equal(formatPromptTime('10-18 22:11', 'zh-CN'), '10月18日 22:11')
})

test('formatDateTime and formatRecordTime format correctly', () => {
  const epoch = 1776412800000 // Fixed timestamp
  const enFormatted = formatDateTime(epoch, 'en')
  const zhFormatted = formatDateTime(epoch, 'zh-CN')
  assert.ok(enFormatted.length > 0)
  assert.ok(zhFormatted.length > 0)

  const sameDayNow = epoch + 5 * 60 * 1000 // 5 minutes later, same day
  const enSameDay = formatRecordTime(epoch, sameDayNow, 'en')
  const zhSameDay = formatRecordTime(epoch, sameDayNow, 'zh-CN')
  assert.ok(/am|pm/i.test(enSameDay))
  assert.ok(/\d{2}:\d{2}/.test(zhSameDay))

  const differentDayNow = epoch + 48 * 60 * 60 * 1000 // 2 days later
  const enDiffDay = formatRecordTime(epoch, differentDayNow, 'en')
  const zhDiffDay = formatRecordTime(epoch, differentDayNow, 'zh-CN')
  assert.ok(enDiffDay.length > 0)
  assert.ok(zhDiffDay.includes('月') && zhDiffDay.includes('日'))
})

test('formatEstimate formats pace estimate correctly', () => {
  const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12)).toISOString()
  const readings = [{ at: at(20), percent: 40 }, { at: at(21), percent: 60 }]
  assert.equal(formatEstimate(readings, false, 'en'), 'at this pace, about Oct 23')
  assert.equal(formatEstimate(readings, false, 'zh-CN'), '按此速度，预计约 10月23日')
  assert.equal(formatEstimate(readings, true, 'zh-CN'), null)
})
