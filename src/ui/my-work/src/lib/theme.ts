// The theme a person picks for My Work (decision G8). One state, saved with the display preferences
// (store/create-store.ts), put on <html> before the first paint by the inline script that vite.config.ts writes into
// index.html (lib/theme-pre-paint.ts), and kept there afterwards by useAppliedTheme (lib/use-applied-theme.ts).
// "System" follows the operating system, including when it changes. No React and no DOM here, so the store, its node
// tests and vite.config.ts can load it.

/**
 * The one definition of the theme choice. The pre-paint script is written from it (lib/theme-pre-paint.ts), and
 * tests/ui/my-work/theme-first-paint.browser.test.ts runs that script for each value against the store's own answer.
 */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const
export type ThemeChoice = (typeof THEME_CHOICES)[number]
export type ResolvedTheme = Exclude<ThemeChoice, 'system'>

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEME_CHOICES.includes(value as ThemeChoice)
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (choice !== 'system') return choice
  return systemDark ? 'dark' : 'light'
}
