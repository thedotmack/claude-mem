// My Work's binding for the shared UI catalog. It imports My Work's own React, so components rendered from this
// package never mix two React copies (src/ui/i18n sits outside this package and would resolve the root one).
import { useSyncExternalStore } from 'react'
import { getLocale, setLocale, subscribeLocale, t, type Locale } from '../../../i18n/core'

export * from '../../../i18n/core'

export function useI18n() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => 'en' as Locale)
  return { t, locale, setLocale }
}
