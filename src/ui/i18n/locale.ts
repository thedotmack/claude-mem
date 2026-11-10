/** Each locale's name in its own language, in the order the language pickers list them. */
export const LOCALE_NAMES = { en: 'English', 'zh-CN': '简体中文', ko: '한국어', tr: 'Türkçe' } as const;
export type Locale = keyof typeof LOCALE_NAMES;
export const LOCALES = Object.keys(LOCALE_NAMES) as Locale[];
export const LANGUAGE_STORAGE_KEY = ['claude', 'mem', 'ui', 'language'].join('-');

/** Only application chrome is translated; stored memories and user text stay verbatim. */
export function parseLocale(value: string | null): Locale {
  return LOCALES.find(locale => locale === value) ?? 'en';
}

export function interpolate(message: string, values: Record<string, string | number>): string {
  return message.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match);
}

export function placeholders(message: string): string[] {
  return [...new Set(message.match(/\{\w+\}/g) ?? [])].sort();
}
