import { getLocale, t } from '../../i18n';

/** The full local stamp ("11/15/2026, 6:04:17 PM"): shown on hover, focus and tap, never as the line people scan. */
export function formatDate(epoch: number): string {
  return new Date(epoch).toLocaleString(getLocale());
}

/** The short local time people scan in a list: "6:07 pm" in English, the locale's own short time elsewhere. */
export function formatShortTime(epoch: number): string {
  const locale = getLocale();
  const english = locale === 'en';
  const text = new Date(epoch).toLocaleTimeString(locale, english
    ? { hour: 'numeric', minute: '2-digit', hour12: true }
    : { hour: 'numeric', minute: '2-digit' });
  // en-US writes "6:07 PM" with a narrow no-break space; the timeline reads "6:07 pm".
  return english ? text.replace(/\s?(AM|PM)$/, (_, period: string) => `\u202f${period.toLowerCase()}`) : text;
}

/** "Nov 15": the day on the day rail. */
export function formatShortDate(epoch: number, locale: string = getLocale()): string {
  return new Date(epoch).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

/** A count in the reader's language ("1,234", "1 234"): the one formatter for every count the viewer shows. */
export function formatCount(value: number): string {
  return value.toLocaleString(getLocale());
}

/** Calendar day in local time, for grouping rows under one day label. */
export function localDayKey(epoch: number): string {
  const date = new Date(epoch);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** Whole local days between two stamps (0 = same day, 1 = the day before). */
function daysBefore(epoch: number, now: number): number {
  const day = new Date(epoch); day.setHours(12, 0, 0, 0);
  const today = new Date(now); today.setHours(12, 0, 0, 0);
  return Math.round((today.getTime() - day.getTime()) / 86_400_000);
}

/**
 * The label above the first row of a day: "Today · Nov 15", "Yesterday · Nov 14",
 * "Thursday · Nov 13" within the last week, otherwise the date (with the year when it differs).
 */
export function formatDayLabel(epoch: number, now: number = Date.now()): string {
  const locale = getLocale();
  const date = new Date(epoch);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const monthDay = date.toLocaleDateString(locale, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  const age = daysBefore(epoch, now);
  if (age === 0) return `${t('Today')} · ${monthDay}`;
  if (age === 1) return `${t('Yesterday')} · ${monthDay}`;
  // Six days back is the oldest a weekday name still points at one day.
  if (age > 1 && age < 7) return `${date.toLocaleDateString(locale, { weekday: 'long' })} · ${monthDay}`;
  return monthDay;
}
