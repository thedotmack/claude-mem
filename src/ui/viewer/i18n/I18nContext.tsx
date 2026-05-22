import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { translations, localeLabels } from './translations';
export type { Locale } from './translations';
import type { Locale } from './translations';

const STORAGE_KEY = 'claude-mem-locale';
const VALID_LOCALES = new Set(Object.keys(localeLabels));

// Quick-lookup: browser language prefix → locale
const BROWSER_LOCALE_MAP: Record<string, Locale> = {
  zh: 'zh', es: 'es', fr: 'fr', de: 'de',
  ja: 'ja', ko: 'ko', pt: 'pt', ru: 'ru',
};

function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && VALID_LOCALES.has(stored)) return stored as Locale;
  } catch { /* localStorage unavailable */ }

  try {
    const lang = navigator.language;
    const base = lang.split('-')[0];
    if (BROWSER_LOCALE_MAP[base]) return BROWSER_LOCALE_MAP[base];
  } catch { /* navigator unavailable */ }

  return 'en';
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: (key: string) => key,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* */ }
  }, []);

  const t = useCallback((key: string): string => {
    return translations[locale]?.[key] ?? translations.en?.[key] ?? key;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
