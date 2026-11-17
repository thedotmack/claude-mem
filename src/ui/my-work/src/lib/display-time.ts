import { getLocale, type Locale } from '@/lib/i18n'
import { storyHeadingInReaderClock } from '@/live/build-story'

const WORDS: Partial<Record<Locale, Record<string, string>>> = {
  'zh-CN': { Today: '今天', Yesterday: '昨天', am: '上午', pm: '下午' },
  ko: { Today: '오늘', Yesterday: '어제', am: '오전', pm: '오후' },
  tr: { Today: 'Bugün', Yesterday: 'Dün', am: 'ÖÖ', pm: 'ÖS' },
  fr: { Today: 'Aujourd’hui', Yesterday: 'Hier' },
}

/**
 * A recorded instant (an ISO time) in the reader's own clock (G9, plan rule 9): short, "6:09 pm" today or "Nov 15,
 * 6:09 pm" on another day, with the full stamp for its tooltip. Twelve-hour, except French, which reads a 24-hour clock
 * as displayTime does. Null when the value is not an ISO time, so a caller never prints a raw stamp as a time.
 */
export function clockTime(iso: string, now: number = Date.now()): { short: string; full: string } | null {
  const at = Date.parse(iso)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso) || !Number.isFinite(at)) return null
  const locale = getLocale()
  const date = new Date(at)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  const short = new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }), hour: 'numeric', minute: '2-digit', hour12: locale !== 'fr',
  }).format(date)
  return {
    // English writes the half of the day in lower case, as the rest of My Work does ("3:45 pm").
    short: locale === 'en' ? short.replace(/\s?(AM|PM)$/, (_, half: string) => ` ${half.toLowerCase()}`) : short,
    full: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long' }).format(date),
  }
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
  const at = Date.parse(iso)
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso) || !Number.isFinite(at)) return null
  const locale = getLocale()
  const date = new Date(at)
  const sameYear = new Date(now).getFullYear() === date.getFullYear()
  return {
    short: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(date),
    full: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long' }).format(date),
  }
}

/** Localize recorded display dates without changing model timestamps or their sort keys. */
export function displayTime(value: string): string {
  const locale = getLocale()
  const words = WORDS[locale]
  if (!words || !value) return value
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  let text = value.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b/g, (_, month, day) =>
    new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(2026, months.indexOf(month), Number(day))))
    .replace(/\b(Today|Yesterday)\b/g, (word: string) => words[word] ?? word)
  if (locale === 'fr') {
    return text.replace(/\b(0?[1-9]|1[0-2]):([0-5]\d) ?(am|pm)\b/g, (_, hour, minutes, half) => {
      const hours = Number(hour) % 12 + (half === 'pm' ? 12 : 0)
      return `${String(hours).padStart(2, '0')}:${minutes}`
    })
  }
  // Korean and Turkish put the am/pm word before the time: "3:45 pm" reads "오후 3:45" and "ÖS 3:45".
  if (locale === 'ko' || locale === 'tr') text = text.replace(/\b(\d{1,2}:\d{2}) ?(am|pm)\b/g, (_, time: string, half: string) => `${words[half]} ${time}`)
  return text.replace(/\b(am|pm)\b/g, (half: string) => words[half] ?? half)
}
