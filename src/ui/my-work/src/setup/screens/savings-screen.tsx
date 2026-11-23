import { ArrowRightIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import { CLOUD_SYNC_OFFER_TERMS, DEFAULT_CLOUD_SYNC_OFFER, type SetupCloudSyncOffer } from '../../../../../shared/setup-funnel.ts'
import { PLAN, type SetupUsage } from '../setup-data'
import type { MemoryBranch } from '../setup-flow'
import { money } from '../format'
import { PageHeading, SetupActions, SetupButton, type SetupBack } from './shared'

const monthly = (cents: number, t: (s: string) => string) => interpolate(t('{amount}/mo'), { amount: money(cents) })
const tokensLabel = (tokens: number, t: (s: string) => string) => interpolate(t('{count} tokens'), { count: new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens) })

/**
 * Step 4, Token Savings, result only (PROTO #route-savings-result). The persona and 30-day tokens come from the scan, and
 * only for a complete window; otherwise the line says the history is incomplete or missing (DATA-CONTRACT.md).
 * Cloud Sync preserves the configured memory provider. Saved hosted choices retain their original Pro receipt.
 * Cloud storage does not itself promise token savings; that claim belongs only to the legacy hosted plan.
 */
export function SavingsScreen({ usage, branch, cloudSyncOffer = DEFAULT_CLOUD_SYNC_OFFER, legacyHosted = false, alreadyPro = false, back, onContinue, onSkip }: {
  usage: SetupUsage | null
  branch: MemoryBranch
  cloudSyncOffer?: SetupCloudSyncOffer
  legacyHosted?: boolean
  alreadyPro?: boolean
  back?: SetupBack | null
  onContinue: () => void
  onSkip?: () => void
}) {
  const { t } = useI18n()
  const percent = usage?.efficiencyPercent ?? null
  const title = legacyHosted && percent !== null && percent > 0 ? interpolate(t('Based on your usage, CMEM Pro will make your token consumption {percent}% more efficient.'), { percent }) : t('Your AI usage.')
  const offer = CLOUD_SYNC_OFFER_TERMS[cloudSyncOffer]
  const cloudPrice = offer.interval === 'year'
    ? interpolate(t('{amount}/year'), { amount: money(offer.cents) })
    : monthly(offer.cents, t)
  const formatPeriodLabel = (periodLabel: string) =>
    periodLabel.replace(/^Last (\d+) days/, (_, days) => interpolate(t('Last {days} days'), { days }))
  // Title, then its evidence on the line under it (E6); the persona follows as a plain line.
  const source = usage && (usage.coverage === 'complete' ? `${formatPeriodLabel(usage.periodLabel)} · ${tokensLabel(usage.tokens, t)}` : t(usage.periodLabel))

  return (
    <section aria-labelledby="savings-title">
      <PageHeading id="savings-title" title={title} lead={source ? <span className="usage-period tabular">{source}</span> : undefined} />
      {usage?.persona && <p className="persona">{interpolate(t('You are a {persona}.'), { persona: t(usage.persona) })}</p>}
      <div className="panel is-memory price-card">
        {alreadyPro && branch === 'go' ? <>
          <h2>{t('Keep your existing plan')}</h2>
          <p className="result-terms">{t('Your existing Cloud Sync and memory configuration will be kept. No new checkout is needed.')}</p>
        </> : legacyHosted ? <>
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
        </> : branch === 'home' ? <>
          <h2>{t('At Home · Free')}</h2>
          <p className="result-terms">{t('Memory stays on this computer and uses your Claude account. No Cloud Sync subscription is required.')}</p>
        </> : <>
          <h2>{t('Cloud Sync')}</h2>
          <dl className="price-table">
            <div><dt>{t('Your plan')}</dt><dd>{cloudPrice}</dd></div>
            <div className="total"><dt>{t('Due today')}</dt><dd><strong>{money(offer.trialDays ? 0 : offer.cents)}</strong></dd></div>
          </dl>
          <div className="price-trial">
            <p className="result-trial tabular">{offer.trialDays
              ? t('A full 30-day free trial. Then $12/month.')
              : t('$99 today. Renews yearly. No trial.')}</p>
            <p className="result-terms">{t('Keep your existing memory provider. Hosted tokens are optional, paid separately after Cloud Sync, and have no trial.')}</p>
            {offer.trialDays > 0 && <p className="result-terms">{t('Token usage and hosted token purchases do not shorten your Cloud Sync trial.')}</p>}
          </div>
        </>}
      </div>
      <SetupActions back={back}>
        {onSkip && <SetupButton look="outline" onClick={onSkip}>{t('Skip for now')}</SetupButton>}
        <SetupButton onClick={onContinue}>
          {t(legacyHosted ? 'Continue with CMEM Pro' : branch === 'home' ? 'Continue at Home' : 'Continue with Cloud Sync')} <ArrowRightIcon aria-hidden="true" />
        </SetupButton>
      </SetupActions>
    </section>
  )
}
