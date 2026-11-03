import { en } from './translations/en.ts'
import { zhCN } from './translations/zh-CN.ts'
import type { Language } from './types.ts'

export type { Language, LanguageInfo } from './types.ts'
export { SUPPORTED_LANGUAGES } from './types.ts'
export * from './formatters.ts'

const TRANSLATIONS: Record<Language, Record<string, string>> = {
  en,
  'zh-CN': zhCN,
}

/** Translates a key with fallback to English and string interpolation. */
export function translate(
  key: string,
  params?: Record<string, string | number>,
  language: Language = 'en'
): string {
  const dict = TRANSLATIONS[language] ?? TRANSLATIONS.en
  let message = dict[key] ?? TRANSLATIONS.en[key] ?? key

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      message = message.replaceAll(`{${k}}`, String(v))
    }
  }

  return message
}

export const t = translate

/** Resolves any language string/locale into a supported Language. */
export function normalizeLanguage(lang?: string | null): Language | null {
  if (!lang) return null
  const cleaned = lang.trim().toLowerCase()
  if (cleaned === 'zh' || cleaned.startsWith('zh-') || cleaned.startsWith('zh_')) {
    return 'zh-CN'
  }
  if (cleaned === 'en' || cleaned.startsWith('en-') || cleaned.startsWith('en_')) {
    return 'en'
  }
  return null
}

/** Detects initial language with standard priority order. */
export function detectInitialLanguage({
  urlParam,
  savedPreference,
  workerLanguage,
  browserLanguage,
}: {
  urlParam?: string | null
  savedPreference?: string | null
  workerLanguage?: string | null
  browserLanguage?: string | null
}): Language {
  return (
    normalizeLanguage(urlParam) ??
    normalizeLanguage(savedPreference) ??
    normalizeLanguage(workerLanguage) ??
    normalizeLanguage(browserLanguage) ??
    'en'
  )
}

