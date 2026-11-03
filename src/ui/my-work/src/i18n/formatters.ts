import type { Language } from './types.ts'

const lowercaseMeridiem = (text: string) =>
  text.replace(/\s?(AM|PM)$/, (_, meridiem: string) => ` ${meridiem.toLowerCase()}`)

export function getLocale(language: Language): string {
  return language === 'zh-CN' ? 'zh-CN' : 'en-US'
}

/** Formats date and time e.g. "Oct 20, 1:16 pm" or "10月20日 13:16". */
export function formatDateTime(epochOrDate: number | Date | string, language: Language = 'en'): string {
  const epoch = typeof epochOrDate === 'number'
    ? epochOrDate
    : typeof epochOrDate === 'string'
      ? Date.parse(epochOrDate)
      : epochOrDate.getTime()
  if (!Number.isFinite(epoch)) return ''

  if (language === 'zh-CN') {
    const d = new Date(epoch)
    const month = d.getMonth() + 1
    const day = d.getDate()
    const hours = String(d.getHours()).padStart(2, '0')
    const minutes = String(d.getMinutes()).padStart(2, '0')
    return `${month}月${day}日 ${hours}:${minutes}`
  }

  return lowercaseMeridiem(
    new Date(epoch).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  )
}

/** "1:56 pm" / "13:56" today, "Oct 19" / "10月19日" before. */
export function formatRecordTime(epoch: number, now: number = Date.now(), language: Language = 'en'): string {
  if (!Number.isFinite(epoch)) return ''
  const sameDay = new Date(epoch).toDateString() === new Date(now).toDateString()

  if (language === 'zh-CN') {
    if (sameDay) {
      const d = new Date(epoch)
      const hours = String(d.getHours()).padStart(2, '0')
      const minutes = String(d.getMinutes()).padStart(2, '0')
      return `${hours}:${minutes}`
    }
    const d = new Date(epoch)
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }

  return sameDay
    ? lowercaseMeridiem(new Date(epoch).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }))
    : new Date(epoch).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Formats duration into e.g. "Just started" / "刚刚开始", "5 min" / "5 分钟", "2 hr" / "2 小时", "1 day" / "1 天". */
export function formatDuration(milliseconds: number, language: Language = 'en'): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000))
  if (language === 'zh-CN') {
    if (minutes < 1) return '刚刚开始'
    if (minutes < 60) return `${minutes} 分钟`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时`
    const days = Math.floor(hours / 24)
    return `${days} 天`
  }

  if (minutes < 1) return 'Just started'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Formats prompt timestamp day like "Oct 18" or "10月18日". */
export function formatPromptDay(at: string, language: Language = 'en'): string {
  if (!at) return language === 'zh-CN' ? '未记录时间' : 'Time not recorded'
  const monthNum = Number(at.slice(0, 2))
  const dayNum = Number(at.slice(3, 5))
  if (language === 'zh-CN') {
    return `${monthNum}月${dayNum}日`
  }
  return `${MONTHS_EN[monthNum - 1]} ${dayNum}`
}

/** Formats prompt timestamp like "Oct 18, 22:11" or "10月18日 22:11". */
export function formatPromptTime(at: string, language: Language = 'en'): string {
  if (!at) return language === 'zh-CN' ? '未记录时间' : 'Time not recorded'
  if (at.length > 5) {
    const day = formatPromptDay(at, language)
    const time = at.slice(6)
    return language === 'zh-CN' ? `${day} ${time}` : `${day}, ${time}`
  }
  return formatPromptDay(at, language)
}

/** Formats numbers with locale rules e.g. "1,234". */
export function formatNumber(value: number, language: Language = 'en', options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(language), options).format(value)
}

/** Measured pace ship estimate e.g. "at this pace, about Oct 23" or "按此速度，预计约 10月23日". */
export function formatEstimate(readings: { at: string; percent: number }[], shipped: boolean, language: Language = 'en'): string | null {
  if (shipped) return null
  const dated = readings
    .map((reading) => ({ at: Date.parse(reading.at), percent: reading.percent }))
    .filter((reading) => Number.isFinite(reading.at) && Number.isFinite(reading.percent))
    .sort((a, b) => a.at - b.at)
  if (dated.length < 2) return null
  const [first, last] = dated.slice(-2)
  if (last.percent <= first.percent || last.at <= first.at || last.percent >= 100) return null
  const percentPerMs = (last.percent - first.percent) / (last.at - first.at)
  const targetEpoch = last.at + (100 - last.percent) / percentPerMs

  if (language === 'zh-CN') {
    const d = new Date(targetEpoch)
    const dateStr = `${d.getMonth() + 1}月${d.getDate()}日`
    return `按此速度，预计约 ${dateStr}`
  }

  const dateStr = new Date(targetEpoch).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `at this pace, about ${dateStr}`
}
