import { ArrowRightIcon } from 'lucide-react'
import { PLAN, type SetupUsage } from '../setup-data'
import type { MemoryBranch } from '../setup-flow'
import { money } from '../format'

const monthly = (cents: number) => `${money(cents)}/mo`
const tokensLabel = (tokens: number) => `${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)} tokens`

/**
 * Step 4, Token Savings, result only (PROTO #route-savings-result). The persona and 30-day tokens come from the scan, and
 * only for a complete window; otherwise the line says the history is incomplete or missing (DATA-CONTRACT.md).
 * "% more efficient" shows only with real claude-mem observation history. The price card is plan prices (D6).
 * "Use my existing token plan" stays off On The Go: there is no standalone Cloud Sync price yet (gap G1).
 */
export function SavingsScreen({ usage, branch, onPro, onExistingPlan, onSkip }: {
  usage: SetupUsage | null
  branch: MemoryBranch
  onPro: () => void
  onExistingPlan: () => void
  onSkip: () => void
}) {
  const percent = usage?.efficiencyPercent ?? null
  const title = percent !== null && percent > 0 ? `Based on your usage, CMEM Pro will make your token consumption ${percent}% more efficient.` : 'Your AI usage.'
  return (
    <section aria-labelledby="savings-title">
      <div className="page-heading">
        <h1 id="savings-title" tabIndex={-1}>{title}</h1>
        {usage?.persona && <p className="persona">You are a {usage.persona}.</p>}
        {usage && <p className="usage-period">{usage.coverage === 'complete' ? `${usage.periodLabel} · ${tokensLabel(usage.tokens)}` : usage.periodLabel}</p>}
      </div>
      <div className="panel is-memory price-card">
        <h2>Monthly price after your trial</h2>
        <dl className="price-table">
          <div><dt>{PLAN.name}</dt><dd>{monthly(PLAN.monthlyCents)}</dd></div>
          <div><dt>Cloud Sync</dt><dd><s>{monthly(PLAN.cloudSyncCents)}</s> <strong className="free">Free</strong></dd></div>
          <div className="total"><dt>Total</dt><dd><s>{monthly(PLAN.monthlyCents + PLAN.cloudSyncCents)}</s> <strong>{monthly(PLAN.monthlyCents)}</strong></dd></div>
        </dl>
      </div>
      <p className="result-trial">$0 today · 30 day free trial</p>
      <p className="result-terms">Trial ends after 30 days or when included usage runs out, whichever comes first.</p>
      <div className="savings-actions">
        <button type="button" className="primary" onClick={onPro}>Continue with CMEM Pro <ArrowRightIcon aria-hidden="true" /></button>
        {branch === 'home' && (
          <button type="button" className="existing-plan" onClick={onExistingPlan}>
            <span>Use my existing token plan to generate memories of my work.</span>
            <small>At Home · Free</small>
          </button>
        )}
        <button type="button" className="text-action" onClick={onSkip}>Skip for now</button>
      </div>
    </section>
  )
}
