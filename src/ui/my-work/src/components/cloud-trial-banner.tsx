import { interpolate, useI18n } from '@/lib/i18n'

export function CloudTrialBanner({ trialEndsAt }: { trialEndsAt: string }) {
  const { t, locale } = useI18n()
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(Date.parse(trialEndsAt))
  return (
    <section aria-label={t('Cloud Sync trial')} className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 bg-red-800 px-4 py-3 text-sm text-white sm:px-6">
      <div className="min-w-0">
        <p className="font-semibold">{interpolate(t('Your Cloud Sync trial ends on {date} (UTC).'), { date })}</p>
        <p>{t('Add a card to keep Cloud Sync and your private Work View for $12/month after your trial.')}</p>
      </div>
      <a className="inline-flex min-h-11 shrink-0 items-center rounded-md bg-white px-4 py-2 font-semibold text-red-900 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        href="/api/viewer/cloud-sync-renew">{t('Add a card')}</a>
    </section>
  )
}
