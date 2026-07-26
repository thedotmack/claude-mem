import { useState, useEffect } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'claude-mem-theme';

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'system' || stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch (e: unknown) {
    console.warn('Failed to read theme preference from localStorage:', e instanceof Error ? e.message : String(e));
  }
  return 'system';
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') {
    return getSystemTheme();
  }
  return preference;
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(getStoredPreference);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolveTheme(preference));
  }, [preference]);

  useEffect(() => {
    if (preference !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [preference]);

  const setThemePreference = (newPreference: ThemePreference) => {
    try {
      localStorage.setItem(STORAGE_KEY, newPreference);
      setPreference(newPreference);
    } catch (e: unknown) {
      console.warn('Failed to save theme preference to localStorage:', e instanceof Error ? e.message : String(e));
      setPreference(newPreference);
    }
  };

  return {
    preference,
    setThemePreference
  };
}
