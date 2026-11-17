import { ArrowRightIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { PLAN, type SetupUsage } from '../setup-data'
import type { MemoryBranch } from '../setup-flow'
import { money } from '../format'
import { PageHeading, SetupActions, SetupButton, type SetupBack } from './shared'

const monthly = (cents: number, t: (s: string) => string) => interpolate(t('{amount}/mo'), { amount: money(cents) })
const tokensLabel = (tokens: number, t: (s: string) => string) => interpolate(t('{count} tokens'), { count: new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens) })

/**
 * Step 4, Token Savings, result only (PROTO #route-savings-result). The persona and 30-day tokens come from the scan, and
 * only for a complete window; otherwise the line says the history is incomplete or missing (DATA-CONTRACT.md).
 * "% more efficient" shows only with real claude-mem observation history. The price card is plan prices (D6).
 * "Use my existing token plan" stays off On The Go: there is no standalone Cloud Sync price yet (gap G1).
 */
export function SavingsScreen({ usage, branch, back, onPro, onExistingPlan, onSkip }: {
  usage: SetupUsage | null
  branch: MemoryBranch
  back?: SetupBack | null
  onPro: () => void
  onExistingPlan: () => void
  onSkip: () => void
}) {
  const { t } = useI18n()
  const percent = usage?.efficiencyPercent ?? null
  const title = percent !== null && percent > 0 ? interpolate(t('Based on your usage, CMEM Pro will make your token consumption {percent}% more efficient.'), { percent }) : t('Your AI usage.')
  const formatPeriodLabel = (periodLabel: string) =>
    periodLabel.replace(/^Last (\d+) days/, (_, days) => interpolate(t('Last {days} days'), { days }))
  // Title, then its evidence on the line under it (E6); the persona follows as a plain line.
  const source = usage && (usage.coverage === 'complete' ? `${formatPeriodLabel(usage.periodLabel)} · ${tokensLabel(usage.tokens, t)}` : t(usage.periodLabel))

  return (
    <section aria-labelledby="savings-title">
      <PageHeading id="savings-title" title={title} lead={source ? <span className="usage-period tabular">{source}</span> : undefined} />
      {usage?.persona && <p className="persona">{interpolate(t('You are a {persona}.'), { persona: t(usage.persona) })}</p>}
      <div className="panel is-memory price-card">
        <h2>{t('Monthly price after your trial')}</h2>
        <dl className="price-table">
          <div><dt>{PLAN.name}</dt><dd>{monthly(PLAN.monthlyCents, t)}</dd></div>
          <div><dt>{t('Cloud Sync')}</dt><dd><s>{monthly(PLAN.cloudSyncCents, t)}</s> <strong className="free">{t('Free')}</strong></dd></div>
          <div className="total"><dt>{t('Total')}</dt><dd><s>{monthly(PLAN.monthlyCents + PLAN.cloudSyncCents, t)}</s> <strong>{monthly(PLAN.monthlyCents, t)}</strong></dd></div>
        </dl>
        <div className="price-trial">
          <p className="result-trial tabular">{t('$0 today · 30 day free trial')}</p>
          <p className="result-terms">{t('Trial ends after 30 days or when included usage runs out, whichever comes first.')}</p>
        </div>
      </div>
      {branch === 'home' && (
        <SetupButton look="outline" className="existing-plan" onClick={onExistingPlan}>
          <span>{t('Use my existing token plan to generate memories of my work.')}</span>
          <small>{t('At Home · Free')}</small>
        </SetupButton>
      )}
      <SetupActions back={back}>
        <SetupButton look="outline" onClick={onSkip}>{t('Skip for now')}</SetupButton>
        <SetupButton onClick={onPro}>{t('Continue with CMEM Pro')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
      </SetupActions>
    </section>
  )
}
