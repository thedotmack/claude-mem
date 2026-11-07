import { getLocale } from '@/lib/i18n'

/** Localize recorded display dates without changing model timestamps or their sort keys. */
export function displayTime(value: string): string {
  if (getLocale() !== 'zh-CN' || !value) return value
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) {
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return value.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b/g, (_, month, day) =>
    new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(new Date(2026, months.indexOf(month), Number(day))))
    .replace(/\bToday\b/g, '今天').replace(/\bYesterday\b/g, '昨天').replace(/\bam\b/g, '上午').replace(/\bpm\b/g, '下午')
}
