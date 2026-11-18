// Decision G8: the theme is on <html> before the first paint, so the loading and error screens are dark for a dark
// user instead of flashing light. This is the script that does it. vite.config.ts puts it inline in index.html's
// <head> (in the dev server and the build), where it runs before the page draws anything; the app's own code loads
// later, so the script cannot import it. Its values come from their one definitions instead of being typed again:
// the choices from lib/theme.ts, the storage key and version from store/preferences.ts. Plain JavaScript in a string,
// so the dev server, the build and the tests all get the same text. No imports beyond those: vite.config.ts and the
// browser tests load this file outside the app.
import { THEME_CHOICES, type ResolvedTheme, type ThemeChoice } from './theme.ts'
import { OLDEST_MIGRATED_PREFERENCES_VERSION, PREFERENCES_STORAGE_KEY, PREFERENCES_VERSION } from '../store/preferences.ts'

/** The choice that follows the operating system, and the one resolved theme that puts `.dark` on <html>. */
const FOLLOWS_SYSTEM: ThemeChoice = 'system'
const DARK: ResolvedTheme = 'dark'

/** Where index.html wants the script; vite.config.ts puts it there and fails the build when the mark is missing. */
export const THEME_PRE_PAINT_MARK = '<!-- theme-pre-paint -->'

/**
 * G8 order: a known `?theme=` for this visit, then the saved choice, then the system. The install funnel (`?setup=1`)
 * is light only. The saved theme is read from the versions the store migrates (OLDEST_MIGRATED_PREFERENCES_VERSION up to
 * PREFERENCES_VERSION; the theme means the same in each) and dropped from any other, as the store drops it, so the
 * first frame and the app agree. Saved preferences that cannot be read (blocked storage, broken JSON) leave the
 * system's theme and say why in the console; the store then starts from the same defaults.
 */
export const THEME_PRE_PAINT_SCRIPT = `(function (choices, followsSystem, dark, key, oldest, version) {
  var params = new URLSearchParams(location.search)
  if (params.get('setup') === '1') return
  var choice = params.get('theme')
  if (choices.indexOf(choice) < 0) {
    choice = followsSystem
    try {
      var saved = JSON.parse(localStorage.getItem(key) || 'null')
      if (saved && saved.version >= oldest && saved.version <= version && saved.state && choices.indexOf(saved.state.theme) >= 0) choice = saved.state.theme
    } catch (error) {
      console.warn('[my-work] The saved theme could not be read, so the page follows the system theme:', error)
    }
  }
  var resolved = choice === followsSystem ? (matchMedia('(prefers-color-scheme: dark)').matches ? dark : null) : choice
  if (resolved === dark) document.documentElement.classList.add('dark')
})(${JSON.stringify(THEME_CHOICES)}, ${JSON.stringify(FOLLOWS_SYSTEM)}, ${JSON.stringify(DARK)}, ${JSON.stringify(PREFERENCES_STORAGE_KEY)}, ${JSON.stringify(OLDEST_MIGRATED_PREFERENCES_VERSION)}, ${JSON.stringify(PREFERENCES_VERSION)})`

/** index.html with the script where its mark is. Fails loudly when the mark is missing, so a build never ships without it. */
export function withThemePrePaintScript(html: string): string {
  if (!html.includes(THEME_PRE_PAINT_MARK)) throw new Error(`index.html has no ${THEME_PRE_PAINT_MARK} mark for the pre-paint theme script (decision G8)`)
  // A function, so no `$` in the script is read as a replacement pattern.
  return html.replace(THEME_PRE_PAINT_MARK, () => `<script>${THEME_PRE_PAINT_SCRIPT}</script>`)
}
