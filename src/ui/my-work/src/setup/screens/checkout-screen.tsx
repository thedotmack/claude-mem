import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon } from 'lucide-react'
import { GlareCard } from '@/components/aceternity/glare-card'
import { interpolate, useI18n } from '@/lib/i18n'
import { PLAN, type SetupCheckoutView } from '../setup-data'
import { money } from '../format'
import { PageHeading } from './shared'

const perMonth = (cents: number, t: (s: string) => string) => interpolate(t('{amount} / month'), { amount: money(cents) })

/** The card-and-lock picture in 06-checkout-ux-09-pass5.png. */
function SecureCardArt() {
  return (
    <svg viewBox="0 0 230 170" aria-hidden="true">
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
 * Step 5, On The Go only (PROTO #route-checkout-pro). Continue asks the terminal to open the CMEM Pro checkout (sign-in,
 * then Stripe); the page moves on to Finish Setup when the terminal reports it paid. While it is open, Continue opens it again.
 */
export function CheckoutScreen({ checkout, installerStopped, onBack, onContinue }: { checkout: SetupCheckoutView | null; installerStopped: boolean; onBack: () => void; onContinue: () => void }) {
  const { t } = useI18n()
  const open = checkout?.state === 'requested' || checkout?.state === 'waiting'
  return (
    <section aria-labelledby="checkout-title">
      <PageHeading id="checkout-title" title={t('Checkout')} lead={t('CMEM Pro · Cloud Sync included')} />
      <div className="checkout-grid">
        <div className="panel is-memory checkout-receipt">
          <dl className="receipt">
            <div><dt>{t('CMEM Pro after trial')}</dt><dd>{perMonth(PLAN.monthlyCents, t)}</dd></div>
            <div><dt>{t('Cloud Sync')}</dt><dd><s>{perMonth(PLAN.cloudSyncCents, t)}</s> <strong className="free">{t('Free')}</strong></dd></div>
            <div><dt>{t('Total after trial')}</dt><dd><s>{perMonth(PLAN.monthlyCents + PLAN.cloudSyncCents, t)}</s> <strong>{perMonth(PLAN.monthlyCents, t)}</strong></dd></div>
            <div className="due"><dt>{t('Due today')}</dt><dd>$0</dd></div>
          </dl>
          <div className="checkout-notes">
            <p>{t('Your trial ends after 30 days or when included usage runs out, whichever comes first. Billing starts then.')}</p>
            <p>{t('Usage automatically upgrades Pro $30 → Heavy $70 → Max $100/month, plus overages.')}</p>
          </div>
          <details className="checkout-terms">
            <summary><ChevronDownIcon aria-hidden="true" />{t('Trial and billing details')}</summary>
            <ul>
              <li>{t('A card is required. Prepaid cards are not eligible for the trial.')}</li>
              <li>{t('Upgrade price differences are prorated and charged immediately. Overages are billed at renewal.')}</li>
              <li>{t('Other AI charges still apply. Cancel in your account.')}</li>
            </ul>
          </details>
        </div>
        <div className="panel checkout-handoff">
          {/* setup.css sizes the glare card to the art and drops its dark foil frame for the light funnel. */}
          <div className="checkout-glare"><GlareCard className="checkout-glare-face"><SecureCardArt /></GlareCard></div>
          <h2>{t('Secure checkout with Stripe')}</h2>
          <p>{t('Add your card, then return to finish setup.')}</p>
          {open && <p className="checkout-status" role="status">{t('Checkout is open in your browser.')}</p>}
          {checkout?.state === 'failed' && <p className="scan-error" role="alert">{checkout.error}</p>}
        </div>
      </div>
      <div className="actions">
        <button type="button" className="secondary" onClick={onBack}><ArrowLeftIcon aria-hidden="true" />{t('Back')}</button>
        {/* No installer is left to open checkout; the page's alert says how to restart. */}
        {!installerStopped && <button type="button" className="primary" onClick={onContinue}>{open ? t('Open checkout again') : t('Continue to Finish Setup')} <ArrowRightIcon aria-hidden="true" /></button>}
      </div>
    </section>
  )
}
