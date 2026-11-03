import { formatPromptDay as i18nFormatPromptDay, formatPromptTime as i18nFormatPromptTime } from '../i18n/formatters.ts'
import type { Language } from '../i18n/types.ts'

// Goal prompt stamps are `MM-DD HH:MM` (the exact minute typed, no invented timezone), `MM-DD` when only the day
// was recorded, or '' when no time was recorded.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 18, 22:11", or "Oct 18" for a bare day. Locale-aware with language parameter. */
export const formatPromptTime = (at: string, language: Language = 'en') => i18nFormatPromptTime(at, language)
export const formatPromptDay = (at: string, language: Language = 'en') => i18nFormatPromptDay(at, language)
/** Day-of-year-ish key so an ask's latest prompt can be compared with a ship date like "Oct 15". */
export const promptDayKey = (at: string) => Number(at.slice(0, 2)) * 100 + Number(at.slice(3, 5))
export const shipDayKey = (day: string) => (MONTHS.indexOf(day.slice(0, 3)) + 1) * 100 + Number(day.slice(4))
