import { t } from '@/lib/i18n'

// Goal prompt stamps are `MM-DD HH:MM` (the exact minute typed, no invented timezone), `MM-DD` when only the day
// was recorded, or '' when no time was recorded.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const timeNotRecorded = () => t('Time not recorded')

/**
 * "22:11" → "10:11 pm": quote times read on the 12-hour clock the rest of My Work uses (G9, plan rule 9; they were
 * 24-hour here and 12-hour on My Rules). The stamp's own minute; no timezone is added. displayTime then writes it in
 * the reader's language (French keeps a 24-hour clock).
 */
function twelveHour(time: string): string {
  const [hours, minutes] = time.split(':').map(Number)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return time
  return `${hours % 12 || 12}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'am' : 'pm'}`
}

/** "Oct 18, 10:11 pm", or "Oct 18" for a bare day. */
export const formatPromptTime = (at: string) => !at ? timeNotRecorded() : at.length > 5 ? `${formatPromptDay(at)}, ${twelveHour(at.slice(6))}` : formatPromptDay(at)
export const formatPromptDay = (at: string) => !at ? timeNotRecorded() : `${MONTHS[Number(at.slice(0, 2)) - 1]} ${Number(at.slice(3, 5))}`
/** Day-of-year-ish key so an ask's latest prompt can be compared with a ship date like "Oct 15". */
export const promptDayKey = (at: string) => Number(at.slice(0, 2)) * 100 + Number(at.slice(3, 5))
export const shipDayKey = (day: string) => (MONTHS.indexOf(day.slice(0, 3)) + 1) * 100 + Number(day.slice(4))
