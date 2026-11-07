import { useSyncExternalStore } from 'react';
import { getLocale, setLocale, subscribeLocale, t, type Locale } from './core';

export * from './core';

export function useI18n() {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, () => 'en' as Locale);
  return { t, locale, setLocale };
}
