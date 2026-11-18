import { useLayoutEffect, useSyncExternalStore } from 'react'
import { resolveTheme, type ResolvedTheme, type ThemeChoice } from './theme'

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)'

function subscribeToSystemTheme(onChange: () => void) {
  const query = window.matchMedia(SYSTEM_DARK_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

const systemPrefersDark = () => window.matchMedia(SYSTEM_DARK_QUERY).matches

/**
 * Keeps <html> on the chosen theme (G8), following the operating system while the choice is "system". `lightOnly` is
 * the install funnel (setup), which draws one light canvas whatever the choice; it also removes a dark class the
 * pre-paint script set before setup opened. A layout effect, so a change lands before the browser paints it.
 */
export function useAppliedTheme(choice: ThemeChoice, lightOnly: boolean): ResolvedTheme {
  const systemDark = useSyncExternalStore(subscribeToSystemTheme, systemPrefersDark, () => false)
  const resolved: ResolvedTheme = lightOnly ? 'light' : resolveTheme(choice, systemDark)
  useLayoutEffect(() => { document.documentElement.classList.toggle('dark', resolved === 'dark') }, [resolved])
  return resolved
}
