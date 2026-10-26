// The savings screen's view of the scan's token usage. Pure, so `npm test` runs it under node.

export type Persona = 'Cracked Dev' | 'Heavy AI User' | 'Medium AI User' | 'Light AI User'
export type UsageCoverage = 'complete' | 'partial' | 'none'

/** Mirrors the worker's SetupTokenUsage (src/services/prompt-import/token-usage.ts), the scan state's `usage`. */
export interface SetupScanUsage {
  windowDays: number
  agents: Array<{ id: string; label: string; detected: boolean; recordsTokens: boolean; tokens: number }>
  totalTokens: number
  coverage: UsageCoverage
  persona: Persona | null
  efficiencyPercent: number | null
}

export interface SetupUsage {
  coverage: UsageCoverage
  /** "Last 30 days · Claude Code · Codex" for a complete window; otherwise what is missing (DATA-CONTRACT.md). */
  periodLabel: string
  /** Shown only for a complete window. */
  tokens: number
  /** Only for a complete 30-day window. */
  persona: Persona | null
  /** Only from real claude-mem observation history (upgraders). */
  efficiencyPercent: number | null
}

/** The savings screen's view of the scan's token usage. A partial or empty window omits the period and persona. */
export function toSetupUsage(usage: SetupScanUsage): SetupUsage {
  const used = usage.agents.filter((agent) => agent.detected && agent.recordsTokens && agent.tokens > 0).map((agent) => agent.label)
  const periodLabel = usage.coverage === 'complete' ? [`Last ${usage.windowDays} days`, ...used].join(' · ')
    : usage.coverage === 'partial' ? 'Usage history is incomplete.' : 'No usage history found.'
  return {
    coverage: usage.coverage,
    periodLabel,
    tokens: usage.totalTokens,
    persona: usage.coverage === 'complete' ? usage.persona : null,
    efficiencyPercent: usage.efficiencyPercent !== null && usage.efficiencyPercent > 0 ? usage.efficiencyPercent : null,
  }
}
