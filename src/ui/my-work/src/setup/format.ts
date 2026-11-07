// Small formatting and preference helpers shared by the funnel screens.

/** PROTO savings.js `money`: whole dollars when there are no cents. */
export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100)

/** "Claude Code", "Claude Code and Codex", "Claude Code, Codex and OpenCode". */
export const joinNames = (names: string[]) => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
