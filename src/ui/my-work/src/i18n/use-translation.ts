import { useStore } from '../store/index.ts'
import type { Language } from './types.ts'
import { translate } from './index.ts'
import * as formatters from './formatters.ts'

/** React hook for accessing translations and locale-aware formatters. */
export function useTranslation() {
  const language = useStore((state) => state.view.language)
  const setLanguage = useStore.use.setLanguage()

  const t = (key: string, params?: Record<string, string | number>) =>
    translate(key, params, language)

  return {
    t,
    language,
    locale: formatters.getLocale(language),
    setLanguage: (lang: Language) => setLanguage(lang),
    formatDateTime: (epochOrDate: number | Date | string) =>
      formatters.formatDateTime(epochOrDate, language),
    formatRecordTime: (epoch: number, now?: number) =>
      formatters.formatRecordTime(epoch, now, language),
    formatDuration: (ms: number) => formatters.formatDuration(ms, language),
    formatPromptDay: (at: string) => formatters.formatPromptDay(at, language),
    formatPromptTime: (at: string) => formatters.formatPromptTime(at, language),
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
      formatters.formatNumber(value, language, options),
    formatEstimate: (readings: { at: string; percent: number }[], shipped: boolean) =>
      formatters.formatEstimate(readings, shipped, language),
  }
}
