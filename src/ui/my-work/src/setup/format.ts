import { getLocale } from '@/lib/i18n'

// Small formatting and preference helpers shared by the funnel screens.

/** PROTO savings.js `money`: whole dollars when there are no cents. */
export const money = (cents: number) => new Intl.NumberFormat(getLocale() === 'en' ? 'en-US' : getLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100)

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and OpenCode". */
export const joinNames = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Keeps typed or pasted text within `max` characters, counted as the worker counts them (UTF-16 units), and says
 * whether it had to cut, so the box can say so (owner rule: never cut text silently). A cut never splits a character.
 */
export function capText(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false }
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max
  return { text: text.slice(0, end), cut: true }
}
