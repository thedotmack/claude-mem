import { getLocale, interpolate, t, type Locale } from '@/lib/i18n'
import { storyHeadingInReaderClock } from '@/live/build-story'

/**
 * The one formatter for the times people read (G9, plan rule 9): local, short and in the reader's language, with the
 * full stamp for a tooltip. Every part comes from the browser's own words for the reader's language (Intl) and the
 * catalogs (t()), never from English text: a day ("Nov 14"; French "14 nov."), a clock ("3:10 pm"; French "15:10", a
 * 24-hour clock), and the two joined by the catalog's words for it ("{date}, {time}"; Chinese "{date} {time}"), the
 * same entry the classic viewer joins its stamps with (viewer SessionDetailPage).
 */

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T/
const isIsoTime = (value: string) => ISO_TIME.test(value) && Number.isFinite(Date.parse(value))

/** The words for today and yesterday, which Intl has no short form for in a day's place. */
const DAY_WORDS: Partial<Record<Locale, Record<'Today' | 'Yesterday', string>>> = {
  'zh-CN': { Today: '今天', Yesterday: '昨天' },
  ko: { Today: '오늘', Yesterday: '어제' },
  tr: { Today: 'Bugün', Yesterday: 'Dün' },
  fr: { Today: 'Aujourd’hui', Yesterday: 'Hier' },
}

/** A day as the reader writes it short: "Nov 14", with the year when it is not this year's (`withYear`). */
function dayWords(date: Date, locale: Locale, withYear = false): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) }).format(date)
}

/** A clock time in the reader's clock: twelve-hour ("3:10 pm"; English writes the half of the day in lower case, as the
 * rest of My Work does), except French, which reads a 24-hour clock with two-digit hours ("09:05", "15:10": CLDR's
 * French short time, and the French localization's own choice, tests/ui-display-time.test.ts). */
function clockWords(date: Date, locale: Locale): string {
  const clock = new Intl.DateTimeFormat(locale, { hour: locale === 'fr' ? '2-digit' : 'numeric', minute: '2-digit', hour12: locale !== 'fr' }).format(date)
  return locale === 'en' ? clock.replace(/\s?(AM|PM)$/, (_, half: string) => ` ${half.toLowerCase()}`) : clock
}

/** A day and a time together, joined in the reader's language: "Nov 14, 3:10 pm"; Korean "11월 14일 오후 3:10". */
const dayAndTime = (day: string, time: string) => interpolate(t('{date}, {time}'), { date: day, time })

const fullStamp = (date: Date, locale: Locale) => new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long' }).format(date)

/**
 * A recorded instant (an ISO time) in the reader's own clock: "6:09 pm" today, or "Nov 15, 6:09 pm" on another day
 * ("Nov 15, 2025, 6:09 pm" when it is not this year's, as clockTimeOrDay says a day), with the full stamp for its
 * tooltip. Null when the value is not an ISO time, so a caller never prints a raw stamp as a time.
 */
export function clockTime(iso: string, now: number = Date.now()): { short: string; full: string } | null {
  if (!isIsoTime(iso)) return null
  const locale = getLocale()
  const date = new Date(Date.parse(iso))
  const today = new Date(now)
  if (today.toDateString() === date.toDateString()) return { short: clockWords(date, locale), full: fullStamp(date, locale) }
  const day = dayWords(date, locale, today.getFullYear() !== date.getFullYear())
  return { short: dayAndTime(day, clockWords(date, locale)), full: fullStamp(date, locale) }
}

/**
 * A recorded instant for a compact line (a record, a review, a rule's latest quote): the clock time today, the day on
 * any other ("1:56 pm", "Oct 19"; the year when it is not this year's), with the full stamp for its tooltip. Null when
 * the value is not an ISO time.
 */
export function clockTimeOrDay(iso: string, now: number = Date.now()): { short: string; full: string } | null {
  if (!isIsoTime(iso)) return null
  const locale = getLocale()
  const date = new Date(Date.parse(iso))
  const today = new Date(now)
  const short = today.toDateString() === date.toDateString() ? clockWords(date, locale) : dayWords(date, locale, today.getFullYear() !== date.getFullYear())
  return { short, full: fullStamp(date, locale) }
}

/**
 * A build story heading's date as the recap and the sheet show it: a day and time, which request-progress writes in
 * UTC, in the reader's own date and clock (live/build-story.ts storyHeadingInReaderClock: "Nov 17 01:13" reads "Nov 16,
 * 5:13 pm" in Los Angeles), or a day or a range of days as written ("Nov 9-10"); then worded for the reader by
 * displayTime, as "written …" is (French reads 24-hour). `writtenAtIso` is the story's writing time (BuildStory).
 */
export function displayRecordedDate(value: string, writtenAtIso: string | null | undefined, now: number = Date.now()): string {
  return displayTime(storyHeadingInReaderClock(value, writtenAtIso, now) ?? value)
}

/**
 * A recorded day (an ISO time) as a short date in the reader's language (G9, plan rule 9): "Oct 30", with the year when
 * it is not this year's, and the full stamp for a tooltip or a screen reader. Null when the value is not an ISO time.
 */
export function clockDay(iso: string, now: number = Date.now()): { short: string; full: string } | null {
  if (!isIsoTime(iso)) return null
  const locale = getLocale()
  const date = new Date(Date.parse(iso))
  return { short: dayWords(date, locale, new Date(now).getFullYear() !== date.getFullYear()), full: fullStamp(date, locale) }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/**
 * English time words as fixtures, goal prompt stamps (lib/prompt-time.ts) and older models write them, in one pass: a
 * day with a time ("Nov 14, 3:10 pm", or "Nov 14 at 3:10 pm" as newer browsers join en-US), a day, a clock time, and
 * Today or Yesterday. Each part is re-said in the reader's words above, so none of the English reaches the screen.
 */
const ENGLISH_TIME_WORDS = new RegExp(`\\b(${MONTHS.join('|')}) (\\d{1,2})(?:(?:,| at) (\\d{1,2}):([0-5]\\d) ?(am|pm))?\\b|\\b(\\d{1,2}):([0-5]\\d) ?(am|pm)\\b|\\b(Today|Yesterday)\\b`, 'g')
// A leap year, so "Feb 29" is a day; only the month and the day are read from it.
const WORDS_YEAR = 2024
const englishClock = (hour: string, minutes: string, half: string) => new Date(WORDS_YEAR, 0, 1, Number(hour) % 12 + (half === 'pm' ? 12 : 0), Number(minutes))

/**
 * A time as recorded, in the reader's words: an ISO time through clockTime; English time words (a fixture's, a goal
 * prompt's stamp, an older model's) re-said part by part, as ENGLISH_TIME_WORDS reads them; anything else as written
 * (a range of days, "—"). The model's timestamps and sort keys are never changed.
 */
export function displayTime(value: string): string {
  if (!value) return value
  if (isIsoTime(value)) return clockTime(value)!.short
  const locale = getLocale()
  return value.replace(ENGLISH_TIME_WORDS, (match, month?: string, day?: string, hour?: string, minutes?: string, half?: string, clockHour?: string, clockMinutes?: string, clockHalf?: string, relativeDay?: 'Today' | 'Yesterday') => {
    if (month && day) {
      const date = dayWords(new Date(WORDS_YEAR, MONTHS.indexOf(month), Number(day)), locale)
      return hour && minutes && half ? dayAndTime(date, clockWords(englishClock(hour, minutes, half), locale)) : date
    }
    if (clockHour && clockMinutes && clockHalf) return clockWords(englishClock(clockHour, clockMinutes, clockHalf), locale)
    return relativeDay ? DAY_WORDS[locale]?.[relativeDay] ?? relativeDay : match
  })
}

/**
 * A recorded time for a sentence, in the reader's words: from its ISO instant when the model carries one (`form`: the
 * clock with the day on another day, clockTime; or the clock today and the day before, clockTimeOrDay), else from the
 * words a fixture or an older model carries (displayTime).
 */
export function recordedTimeWords(iso: string | null | undefined, words: string, form: 'time' | 'time-or-day' = 'time'): string {
  const fromIso = iso ? (form === 'time' ? clockTime(iso) : clockTimeOrDay(iso)) : null
  return fromIso?.short ?? displayTime(words)
}
