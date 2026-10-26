import { ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon } from 'lucide-react'
import { PLAN, type SetupCheckoutView } from '../setup-data'
import { money } from '../format'
import { PageHeading } from './shared'

const perMonth = (cents: number) => `${money(cents)} / month`

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
  const open = checkout?.state === 'requested' || checkout?.state === 'waiting'
  return (
    <section aria-labelledby="checkout-title">
      <PageHeading id="checkout-title" title="Checkout" lead="CMEM Pro · Cloud Sync included" />
      <div className="checkout-grid">
        <div className="panel is-memory checkout-receipt">
          <dl className="receipt">
            <div><dt>CMEM Pro after trial</dt><dd>{perMonth(PLAN.monthlyCents)}</dd></div>
            <div><dt>Cloud Sync</dt><dd><s>{perMonth(PLAN.cloudSyncCents)}</s> <strong className="free">Free</strong></dd></div>
            <div><dt>Total after trial</dt><dd><s>{perMonth(PLAN.monthlyCents + PLAN.cloudSyncCents)}</s> <strong>{perMonth(PLAN.monthlyCents)}</strong></dd></div>
            <div className="due"><dt>Due today</dt><dd>$0</dd></div>
          </dl>
          <div className="checkout-notes">
            <p>Your trial ends after 30 days or when included usage runs out, whichever comes first. Billing starts then.</p>
            <p>Usage automatically upgrades Pro $30 → Heavy $70 → Max $100/month, plus overages.</p>
          </div>
          <details className="checkout-terms">
            <summary><ChevronDownIcon aria-hidden="true" />Trial and billing details</summary>
            <ul>
              <li>A card is required. Prepaid cards are not eligible for the trial.</li>
              <li>Upgrade price differences are prorated and charged immediately. Overages are billed at renewal.</li>
              <li>Other AI charges still apply. Cancel in your account.</li>
            </ul>
          </details>
        </div>
        <div className="panel checkout-handoff">
          <SecureCardArt />
          <h2>Secure checkout with Stripe</h2>
          <p>Add your card, then return to finish setup.</p>
          {open && <p className="checkout-status" role="status">Checkout is open in your browser.</p>}
          {checkout?.state === 'failed' && <p className="scan-error" role="alert">{checkout.error}</p>}
        </div>
      </div>
      <div className="actions">
        <button type="button" className="secondary" onClick={onBack}><ArrowLeftIcon aria-hidden="true" />Back</button>
        {/* No installer is left to open checkout; the page's alert says how to restart. */}
        {!installerStopped && <button type="button" className="primary" onClick={onContinue}>{open ? 'Open checkout again' : 'Continue to Finish Setup'} <ArrowRightIcon aria-hidden="true" /></button>}
      </div>
    </section>
  )
}
