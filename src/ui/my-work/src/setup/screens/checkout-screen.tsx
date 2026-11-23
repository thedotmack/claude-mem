import { ArrowRightIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { interpolate, useI18n } from '@/lib/i18n'
import { CLOUD_SYNC_OFFER_TERMS, DEFAULT_CLOUD_SYNC_OFFER, type SetupCheckoutState, type SetupCloudSyncOffer } from '../../../../../shared/setup-funnel.ts'
import { PLAN, type SetupCheckoutView } from '../setup-data'
import { money } from '../format'
import { PageHeading, SetupActions, SetupButton, SetupError, type SetupBack } from './shared'

const perMonth = (cents: number, t: (s: string) => string) => interpolate(t('{amount} / month'), { amount: money(cents) })

/** The card-and-lock picture in 06-checkout-ux-09-pass5.png, drawn small and still (E7: the panel was 40% picture). */
function SecureCardArt() {
  return (
    <svg viewBox="0 0 230 170" aria-hidden="true" className="checkout-art">
      <circle cx="148" cy="77" r="72" fill="#dfe2fc" />
      <rect x="18" y="62" width="146" height="96" rx="9" fill="#eef0fc" stroke="#a9b0ea" strokeWidth="2" />
      <rect x="34" y="80" width="44" height="10" rx="5" fill="#cdd2f5" />
      <rect x="34" y="104" width="34" height="8" rx="4" fill="#cdd2f5" />
      <rect x="74" y="104" width="54" height="8" rx="4" fill="#cdd2f5" />
      <rect x="34" y="126" width="50" height="8" rx="4" fill="#cdd2f5" />
      <circle cx="160" cy="74" r="32" fill="#7378ef" />
      <rect x="148" y="72" width="24" height="19" rx="4" fill="#fff" />
      <path d="M152 72v-6a8 8 0 0 1 16 0v6" fill="none" stroke="#fff" strokeWidth="4" />
      <circle cx="160" cy="80" r="2.6" fill="#7378ef" />
      <rect x="159" y="80" width="2" height="6" rx="1" fill="#7378ef" />
    </svg>
  )
}

/**
 * The line under "Secure checkout with Stripe" for each checkout state (E7): asked and open both wait for the person
 * to finish in the browser tab; a paid checkout moves the page on, and a failed one shows its own alert instead.
 */
const CHECKOUT_STATUS: Record<SetupCheckoutState, string | null> = {
  requested: 'Waiting for checkout to finish…',
  waiting: 'Waiting for checkout to finish…',
  paid: 'Checkout finished.',
  failed: null,
}

/**
 * Step 5, On The Go only. "Open checkout" asks the terminal to open the selected product and offer's checkout
 * (sign-in, then Stripe) in a new browser tab; the page moves on to Finish Setup when the terminal reports it paid.
 * While it is open, the same button opens it again. Once paid (reached again by Back), Continue goes on to Finish
 * Setup and nothing is asked of the terminal.
 */
export function CheckoutScreen({ checkout, asked, installerStopped, cloudSyncOffer = DEFAULT_CLOUD_SYNC_OFFER, legacyHosted = false, back, onOpen, onContinue }: {
  checkout: SetupCheckoutView | null
  /** The page's ask was accepted; the installer's first report may not have arrived yet. */
  asked: boolean
  installerStopped: boolean
  cloudSyncOffer?: SetupCloudSyncOffer
  /** Only a saved pre-Cloud-Sync choice may continue the legacy hosted bundle. */
  legacyHosted?: boolean
  back?: SetupBack | null
  onOpen: () => void
  /** On to Finish Setup after a paid checkout, without sending the checkout request again. */
  onContinue: () => void
}) {
  const { t } = useI18n()
  const state: SetupCheckoutState | null = checkout?.state ?? (asked ? 'requested' : null)
  const status = state && CHECKOUT_STATUS[state]
  const offer = CLOUD_SYNC_OFFER_TERMS[cloudSyncOffer]
  const cloudPrice = offer.interval === 'year'
    ? interpolate(t('{amount} / year'), { amount: money(offer.cents) })
    : perMonth(offer.cents, t)
  return (
    <section aria-labelledby="checkout-title">
      <PageHeading id="checkout-title" title={t('Checkout')} lead={t(legacyHosted ? 'CMEM Pro · Cloud Sync included' : 'Cloud Sync · Keep your existing memory provider')} />
      <div className="checkout-grid">
        <div className="panel is-memory checkout-receipt">
          {legacyHosted ? <>
          <dl className="receipt">
            <div className="due"><dt>{t('Due today')}</dt><dd>{money(0)}</dd></div>
            <div><dt>{t('CMEM Pro after trial')}</dt><dd>{perMonth(PLAN.monthlyCents, t)}</dd></div>
            <div><dt>{t('Cloud Sync')}</dt><dd><s>{perMonth(PLAN.cloudSyncCents, t)}</s> <strong className="free">{t('Free')}</strong></dd></div>
            <div><dt>{t('Total after trial')}</dt><dd><s>{perMonth(PLAN.monthlyCents + PLAN.cloudSyncCents, t)}</s> <strong>{perMonth(PLAN.monthlyCents, t)}</strong></dd></div>
          </dl>
          <div className="checkout-notes">
            <p>{t('Your trial ends after 30 days or when included usage runs out, whichever comes first. Billing starts then.')}</p>
            <p>{t('Usage automatically upgrades Pro $30 → Heavy $70 → Max $100/month, plus overages.')}</p>
          </div>
          <Collapsible className="checkout-terms">
            <CollapsibleFoldTrigger>{t('Trial and billing details')}</CollapsibleFoldTrigger>
            <CollapsibleContent forceMount>
              <ul>
                <li>{t('A card is required. Prepaid cards are not eligible for the trial.')}</li>
                <li>{t('Upgrade price differences are prorated and charged immediately. Overages are billed at renewal.')}</li>
                <li>{t('Other AI charges still apply. Cancel in your account.')}</li>
              </ul>
            </CollapsibleContent>
          </Collapsible>
          </> : <>
            <dl className="receipt">
              <div className="due"><dt>{t('Due today')}</dt><dd>{money(offer.trialDays ? 0 : offer.cents)}</dd></div>
              <div><dt>{t(offer.trialDays ? 'Cloud Sync after 30 days' : 'Cloud Sync annual plan')}</dt><dd>{cloudPrice}</dd></div>
              <div><dt>{t('Memory generation')}</dt><dd>{t('Your existing provider')}</dd></div>
            </dl>
            <div className="checkout-notes">
              <p>{offer.trialDays
                ? t('Your Cloud Sync trial lasts a full 30 days. Your first $12 monthly charge is due when that trial ends.')
                : t('$99 is charged today. Your Cloud Sync subscription renews at $99 each year. There is no trial.')}</p>
              <p>{t('Hosted tokens are optional, paid separately after Cloud Sync, and have no trial.')}</p>
            </div>
            <Collapsible className="checkout-terms">
              <CollapsibleFoldTrigger>{t('Billing details')}</CollapsibleFoldTrigger>
              <CollapsibleContent forceMount>
                <ul>
                  <li>{t('A card is required. Review the amount and renewal date in Stripe before confirming.')}</li>
                  {offer.trialDays > 0 && <li>{t('Token usage, hosted token purchases, and token plan changes cannot shorten the Cloud Sync trial.')}</li>}
                  <li>{t('Cloud Sync keeps your configured memory provider. Its existing charges still apply.')}</li>
                  <li>{t('Manage or cancel Cloud Sync in your account.')}</li>
                </ul>
              </CollapsibleContent>
            </Collapsible>
          </>}
        </div>
        <div className="panel checkout-handoff">
          <SecureCardArt />
          <h2>{t('Secure checkout with Stripe')}</h2>
          <p>{t('Checkout opens in a new browser tab. Add your card, then come back here.')}</p>
          {status && (state === 'paid' ? <p className="checkout-status" role="status">{t(status)}</p>
            : <p className="checkout-status" role="status"><Spinner className="checkout-spinner" />{t(status)}</p>)}
          {checkout?.state === 'failed' && <SetupError title={t('Checkout didn’t finish.')} check={t('Open checkout again to try once more.')} detail={checkout.error} />}
        </div>
      </div>
      <SetupActions back={back}>
        {/* Paid: the way on. Otherwise "Open checkout", unless no installer is left to open it (the page's alert says how to restart). */}
        {state === 'paid' ? <SetupButton onClick={onContinue}>{t('Continue')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
          : !installerStopped && <SetupButton onClick={onOpen}>{state ? t('Open checkout again') : t('Open checkout')} <ArrowRightIcon aria-hidden="true" /></SetupButton>}
      </SetupActions>
    </section>
  )
}
