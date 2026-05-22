import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { translations } from './translations';
export type { Locale } from './translations';
import type { Locale } from './translations';

const STORAGE_KEY = 'claude-mem-locale';

function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'en' || stored === 'zh') return stored;
  } catch { /* localStorage unavailable */ }

  try {
    const lang = navigator.language;
    if (lang.startsWith('zh')) return 'zh';
  } catch { /* navigator unavailable */ }

  return 'en';
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
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
