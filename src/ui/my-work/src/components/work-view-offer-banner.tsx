import { useId, type ReactNode } from 'react'
import { ExternalLinkIcon } from 'lucide-react'
import { StickyBanner } from '@/components/aceternity/sticky-banner'
import type { Translate } from '@/components/bits'
import { buttonVariants } from '@/components/ui/button'
import { interpolate, useI18n } from '@/lib/i18n'
import type { WorkViewOffer } from '@/live/work-view-offers'
import { CopyText } from '@/setup/screens/shared'
import { CLOUD_SYNC_OFFER_TERMS } from '../../../../shared/setup-funnel.ts'

/** Where Cloud Sync starts on this computer: the installer's storage choice (Work View has no way to start it itself). */
const CLOUD_SYNC_COMMAND = 'npx claude-mem install'
const ACTION_CLASS_NAME = buttonVariants({ variant: 'outline', size: 'sm' })

/** What a press in the strip reports (useWorkViewOffer). */
interface OfferActions { onViewPlans: () => void }

/**
 * Each offer's words, one entry per offer (state-machines.md); each entry words its own literal text, so the catalog
 * test sees it.
 */
const OFFER_CONTENT: Record<WorkViewOffer, (t: Translate, actions: OfferActions) => { title: string; text: string; note: string; action: ReactNode }> = {
  hosted: (t, { onViewPlans }) => ({
    title: t('Want us to write your memories, too?'),
    text: t('With a hosted plan, cmem.ai writes them instead of your own provider.'),
    note: t('Plans start at $30/month in addition to Cloud Sync.'),
    action: (
      <a className={ACTION_CLASS_NAME} href="https://cmem.ai/hosted-tokens" target="_blank" rel="noopener noreferrer" onClick={onViewPlans}>
        {t('See plans and pricing')}<ExternalLinkIcon aria-hidden="true" />
      </a>
    ),
  }),
  'cloud-sync': (t) => ({
    // The first trial's length, from the one definition checkout uses.
    title: interpolate(t('Try Cloud Sync free for {days} days'), { days: CLOUD_SYNC_OFFER_TERMS.cloud_sync_monthly.trialDays }),
    text: t('Run this in a terminal on this computer. Setup opens in your browser, where you can choose Cloud Sync.'),
    note: t('No card needed for your first trial.'),
    action: (
      <CopyText text={CLOUD_SYNC_COMMAND} label={t('Copy command')} copiedStatus={t('Command copied.')} notCopiedStatus={t('Could not copy the command.')}
        className="flex min-w-0 flex-wrap items-center gap-1.5" valueClassName="rounded border border-control-edge bg-background px-2 py-1.5 font-mono text-xs"
        statusClassName="basis-full text-xs text-muted-foreground empty:hidden" buttonClassName={ACTION_CLASS_NAME} />
    ),
  }),
}

/** The one offer My Work shows on this computer (useWorkViewOffer), in the strip the sample page uses, until closed. */
export function WorkViewOfferBanner({ offer, onDismiss, onViewPlans }: { offer: WorkViewOffer; onDismiss: () => void } & OfferActions) {
  const { t } = useI18n()
  const titleId = useId()
  const content = OFFER_CONTENT[offer](t, { onViewPlans })
  return (
    // Keyed by offer, so a later offer opens a fresh strip instead of one already closed.
    <StickyBanner key={offer} hideOnScroll onDismiss={onDismiss}
      className="min-h-0 flex-wrap justify-start gap-x-4 gap-y-2 border-b border-border/70 bg-card/85 px-4 py-2 pr-12 text-sm backdrop-blur-md md:px-6 md:pr-12">
      <section aria-labelledby={titleId} className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p id={titleId} className="font-semibold">{content.title}</p>
          <p>{content.text} <span className="text-muted-foreground">{content.note}</span></p>
        </div>
        <div className="min-w-0">{content.action}</div>
      </section>
    </StickyBanner>
  )
}
