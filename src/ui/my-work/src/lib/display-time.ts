import { getLocale, type Locale } from '@/lib/i18n'

const WORDS: Partial<Record<Locale, Record<string, string>>> = {
  'zh-CN': { Today: '今天', Yesterday: '昨天', am: '上午', pm: '下午' },
  ko: { Today: '오늘', Yesterday: '어제', am: '오전', pm: '오후' },
  tr: { Today: 'Bugün', Yesterday: 'Dün', am: 'ÖÖ', pm: 'ÖS' },
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
  // Korean and Turkish put the am/pm word before the time: "3:45 pm" reads "오후 3:45" and "ÖS 3:45".
  if (locale === 'ko' || locale === 'tr') text = text.replace(/\b(\d{1,2}:\d{2}) ?(am|pm)\b/g, (_, time: string, half: string) => `${words[half]} ${time}`)
  return text.replace(/\b(am|pm)\b/g, (half: string) => words[half] ?? half)
}
