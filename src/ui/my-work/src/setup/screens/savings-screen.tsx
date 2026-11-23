import { ArrowRightIcon } from 'lucide-react'
import { interpolate, useI18n } from '@/lib/i18n'
import type { SetupUsage } from '../setup-data'
import { PageHeading, SetupActions, SetupButton, type SetupBack } from './shared'

/** The installer has confirmed standalone Cloud Sync. Usage comes from the original scan. */
export function SavingsScreen({ usage, back, onViewPlans, onContinue }: {
  usage: SetupUsage | null
  back?: SetupBack | null
  onViewPlans: () => void
  onContinue: () => void
}) {
  const { t, locale } = useI18n()
  const count = new Intl.NumberFormat(locale).format(usage?.tokens ?? 0)
  const period = usage?.periodLabel.replace(/^Last (\d+) days/, (_, days) => interpolate(t('Last {days} days'), { days }))
  const usageText = usage?.coverage === 'complete' ? interpolate(t('{count} tokens'), { count })
    : usage?.coverage === 'partial' && usage.tokens > 0 ? interpolate(t('At least {count} recorded tokens'), { count })
    : t('No token count is available from your setup scan.')

  return (
    <section aria-labelledby="savings-title">
      <PageHeading id="savings-title" title={t('You’ve got Cloud Sync.')} lead={t('We can write your memories for you, too.')} />
      <div className="panel is-memory price-card">
        <h2>{t('Your AI usage')}</h2>
        <dl className="price-table"><div><dt>{usage?.coverage === 'complete' ? period : t('Recorded usage')}</dt><dd>{usageText}</dd></div></dl>
        {usage?.coverage === 'partial' && <p className="result-terms">{t('Some tools did not report token counts.')}</p>}
        <p className="result-terms">{t('Plans start at $30/month in addition to Cloud Sync.')}</p>
      </div>
      <SetupActions back={back}>
        <SetupButton look="outline" asChild><a href="https://cmem.ai/hosted-tokens" target="_blank" rel="noopener noreferrer" onClick={onViewPlans}>{t('See plans and pricing')}</a></SetupButton>
        <SetupButton onClick={onContinue}>{t('Continue setup')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
      </SetupActions>
    </section>
  )
}
