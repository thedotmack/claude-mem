export type Locale = 'en' | 'zh-CN';
export const LANGUAGE_STORAGE_KEY = ['claude', 'mem', 'ui', 'language'].join('-');

/** Only application chrome is translated; stored memories and user text stay verbatim. */
export function parseLocale(value: string | null): Locale {
  return value === 'zh-CN' ? 'zh-CN' : 'en';
}

export function interpolate(message: string, values: Record<string, string | number>): string {
  return message.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}

export function placeholders(message: string): string[] {
  return [...new Set(message.match(/\{\w+\}/g) ?? [])].sort();
}
