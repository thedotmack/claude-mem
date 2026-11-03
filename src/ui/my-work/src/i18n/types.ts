export type Language = 'en' | 'zh-CN'

export interface LanguageInfo {
  id: Language
  label: string
  shortLabel: string
}

export const SUPPORTED_LANGUAGES: LanguageInfo[] = [
  { id: 'en', label: 'English', shortLabel: 'EN' },
  { id: 'zh-CN', label: '简体中文', shortLabel: '中文' },
]

export type TranslationKey = string
