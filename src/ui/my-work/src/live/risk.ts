// How risky a request is, as the row's leading dot: its colour and the words it says. One table, read by the thread
// rows and the board cards. The rating comes from the last memory review; a request no review rated is never guessed.
import type { Request, Risk } from '../data.ts'

/** Green to red. Solid colours: the dot is the only place risk is coloured, so nothing else on the row is tinted. */
export const RISK: Record<Risk, { label: string; dot: string }> = {
  low: { label: 'Risk: low', dot: 'bg-risk-low' },
  medium: { label: 'Risk: medium', dot: 'bg-risk-medium' },
  high: { label: 'Risk: high', dot: 'bg-risk-high' },
}

/** No review has rated it: a hollow, muted ring, so it reads as empty and not as a fourth level. */
export const UNRATED = { label: 'Not rated yet', dot: 'border border-muted-foreground/60 bg-transparent' } as const

type Translate = (text: string) => string
const asWritten: Translate = (text) => text

export function riskDot(risk: Request['risk']): string {
  return risk ? RISK[risk.level].dot : UNRATED.dot
}

/** What the dot says on hover, on keyboard focus and to a screen reader: the level, then the review's reason. */
export function riskLabel(risk: Request['risk'], t: Translate = asWritten): string {
  if (!risk) return t(UNRATED.label)
  return risk.reason ? `${t(RISK[risk.level].label)}. ${risk.reason}` : t(RISK[risk.level].label)
}
