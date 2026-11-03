import { useSyncExternalStore } from 'react';
import { viewerZh } from './viewer-zh';
import { myworkZh } from './mywork-zh';
import { setupZh } from './setup-zh';
import { settingsZh } from './settings-zh';
import { LANGUAGE_STORAGE_KEY, parseLocale, type Locale } from './locale';

export type { Locale } from './locale';
export { interpolate } from './locale';
const messages: Record<string, string> = { ...viewerZh, ...myworkZh, ...setupZh, ...settingsZh };
const listeners = new Set<() => void>();
let sessionLocale: Locale = 'en';

export function getLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
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
  } catch {
    // Use the in-memory preference for browsers without local storage access.
  }
  notify();
}

function subscribe(listener: () => void): () => void {
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
  return getLocale() === 'zh-CN' ? messages[english] ?? english : english;
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, () => 'en' as Locale);
  return { t, locale, setLocale };
}
