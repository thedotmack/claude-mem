/** Formats a Date as a local YYYY-MM-DD string. */
export function toLocalDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Returns today's date as a YYYY-MM-DD string in local time. */
export function getTodayString(): string {
  return toLocalDateKey(new Date());
}
