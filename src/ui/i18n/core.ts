// The locale store and catalog lookup, with no React import: the viewer and My Work each resolve their own
// React copy, and a hook importing React from here would put two copies in a bundle that resolves from this folder.
import { viewerZh } from './viewer-zh';
import { myworkZh } from './mywork-zh';
import { setupZh } from './setup-zh';
import { settingsZh } from './settings-zh';
import { viewerKo } from './viewer-ko';
import { myworkKo } from './mywork-ko';
import { setupKo } from './setup-ko';
import { settingsKo } from './settings-ko';
import { myworkTr } from './mywork-tr';
import { viewerFr } from './viewer-fr';
import { myworkFr } from './mywork-fr';
import { setupFr } from './setup-fr';
import { settingsFr } from './settings-fr';
import { LANGUAGE_STORAGE_KEY, parseLocale, type Locale } from './locale';

export type { Locale } from './locale';
export { interpolate, LOCALES, LOCALE_NAMES } from './locale';
const catalogs: Partial<Record<Locale, Record<string, string>>> = {
  'zh-CN': { ...viewerZh, ...myworkZh, ...setupZh, ...settingsZh },
  ko: { ...viewerKo, ...myworkKo, ...setupKo, ...settingsKo },
  tr: myworkTr,
  fr: { ...viewerFr, ...myworkFr, ...setupFr, ...settingsFr },
};
const listeners = new Set<() => void>();
let sessionLocale: Locale = 'en';
let hasUnpersistedChoice = false;

export function getLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  if (hasUnpersistedChoice) return sessionLocale;
  // Storage may be denied by browser privacy settings. Language selection still
  // works for this page; persisting it is optional, rendering the UI is not.
  try {
    sessionLocale = parseLocale(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    // Keep the explicit choice in memory when persistence is unavailable.
  }
  return sessionLocale;
}

function notify(): void {
  document.documentElement.lang = getLocale();
  listeners.forEach(listener => listener());
}

export function setLocale(locale: Locale): void {
  sessionLocale = locale;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
    hasUnpersistedChoice = false;
  } catch {
    // A readable but full/read-only store must not overwrite this page's choice.
    hasUnpersistedChoice = true;
  }
  notify();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) notify();
  };
  if (listeners.size === 1) {
    document.documentElement.lang = getLocale();
  }
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** The exact English source text is also the catalog key and English default. */
export function t(english: string): string {
  return catalogs[getLocale()]?.[english] ?? english;
}
