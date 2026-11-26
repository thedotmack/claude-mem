import { ArrowRightIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleFoldTrigger } from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { interpolate, useI18n } from '@/lib/i18n'
import { CLOUD_SYNC_OFFER_TERMS, DEFAULT_CLOUD_SYNC_OFFER, type SetupCheckoutState, type SetupCloudSyncOffer } from '../../../../../shared/setup-funnel.ts'
import { PLAN, type SetupCheckoutView } from '../setup-data'
import { money } from '../format'
import { CopyText, PageHeading, SetupActions, SetupButton, SetupError, type SetupBack } from './shared'

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
  requested: 'Opening secure checkout…',
  waiting: 'Waiting for checkout to finish…',
  paid: 'Checkout finished.',
  failed: null,
}

const TRIAL_STATUS: Record<SetupCheckoutState, string | null> = {
  requested: 'Opening Cloud Sync…',
  waiting: 'Waiting for this device to connect…',
  paid: 'Cloud Sync connected.',
  failed: null,
}

/**
 * The code cmem.ai asks for once the person has started the trial or checkout, shown while the checkout waits. An
 * installer that resumed setup runs hidden, so its terminal note is never seen: this is where people find the code.
 * The copy button is Finish Setup's Copy URL (CopyText).
 */
function DeviceCode({ code, trial }: { code: string; trial: boolean }) {
  const { t } = useI18n()
  return (
    <div className="device-code" role="group" aria-labelledby="device-code-label">
      <p className="device-code-label" id="device-code-label">{t('Your device code')}</p>
      <CopyText text={code} label={t('Copy code')} copiedStatus={t('Code copied.')} notCopiedStatus={t('Select and copy the code above.')}
        className="device-code-row" valueClassName="device-code-value" statusClassName="device-code-status">
        <p className="device-code-hint">{t(trial ? 'cmem.ai asks for this code after you start your free trial.' : 'cmem.ai asks for this code after checkout.')}</p>
      </CopyText>
    </div>
  )
}

/** A code past its expiry no longer connects this device, so the page stops offering it (no expiry: it stays). */
const codeLive = (checkout: SetupCheckoutView) => !!checkout.userCode
  && (!checkout.expiresAt || Number.isNaN(Date.parse(checkout.expiresAt)) || Date.now() < Date.parse(checkout.expiresAt))

/** Renders the screen again just after `at` (ISO), so a code leaves it when it expires even if no frame arrives. */
function useRenderAfter(at: string | null | undefined) {
  const [, setRenders] = useState(0)
  useEffect(() => {
    const when = at ? Date.parse(at) : Number.NaN
    if (Number.isNaN(when) || when <= Date.now()) return
    // Capped at setTimeout's longest wait (pairings expire in minutes; a longer delay would fire at once).
    const timer = setTimeout(() => setRenders((renders) => renders + 1), Math.min(when - Date.now() + 1, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [at])
}

/**
 * The plan selection requests checkout. Keep the local tab available while the terminal
 * opens sign-in and Stripe. A completed pairing advances to Finish Setup.
 * A manual reopen also supports in-progress checkouts created by an older installer.
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
  useRenderAfter(checkout?.expiresAt)
  const state: SetupCheckoutState | null = checkout?.state ?? (asked ? 'requested' : null)
  const offer = CLOUD_SYNC_OFFER_TERMS[cloudSyncOffer]
  const monthlyTrial = !legacyHosted && offer.trialDays > 0
  const status = state && (monthlyTrial ? TRIAL_STATUS : CHECKOUT_STATUS)[state]
  const cloudPrice = offer.interval === 'year'
    ? interpolate(t('{amount} / year'), { amount: money(offer.cents) })
    : perMonth(offer.cents, t)
  return (
    <section aria-labelledby="checkout-title">
      <PageHeading id="checkout-title" title={t(monthlyTrial ? 'Activate Cloud Sync' : 'Checkout')} lead={t(legacyHosted ? 'CMEM Pro · Cloud Sync included' : 'Cloud Sync')} />
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
            <p>{t('Your Pro trial lasts 30 days. Billing starts on your renewal date unless you cancel.')}</p>
            <p>{t('When your hosted credits run out, hosted generation pauses. Claude-Mem can continue with your configured backup provider.')}</p>
          </div>
          <Collapsible className="checkout-terms">
            <CollapsibleFoldTrigger>{t('Trial and billing details')}</CollapsibleFoldTrigger>
            <CollapsibleContent forceMount>
              <ul>
                <li>{t('A card is required. Prepaid cards are not eligible for the trial.')}</li>
                <li>{t('Other AI charges still apply. Cancel in your account.')}</li>
              </ul>
            </CollapsibleContent>
          </Collapsible>
          </> : <>
            <dl className="receipt">
              <div className="due"><dt>{t(monthlyTrial ? 'Due today for your first trial' : 'Due today')}</dt><dd>{money(offer.trialDays ? 0 : offer.cents)}</dd></div>
              <div><dt>{t(offer.trialDays ? 'If you continue after 30 days' : 'Cloud Sync annual plan')}</dt><dd>{cloudPrice}</dd></div>
            </dl>
            <div className="checkout-notes">
              <p>{t(offer.trialDays ? 'No card needed for your first trial. Add a card later if you want to continue.' : '$99 today. Renews yearly. No trial.')}</p>
            </div>
            <Collapsible className="checkout-terms">
              <CollapsibleFoldTrigger>{t('Billing details')}</CollapsibleFoldTrigger>
              <CollapsibleContent forceMount>
                <ul>
                  <li>{t(monthlyTrial ? 'Your first charge is due when the trial ends only if you choose to renew.' : 'A card is required. Review the amount and renewal date in Stripe before confirming.')}</li>
                  <li>{t('Manage or cancel Cloud Sync in your account.')}</li>
                </ul>
              </CollapsibleContent>
            </Collapsible>
          </>}
        </div>
        <div className="panel checkout-handoff">
          {!monthlyTrial && <SecureCardArt />}
          <h2>{t(monthlyTrial ? 'Connect your device' : 'Secure checkout with Stripe')}</h2>
          <p>{t(monthlyTrial ? 'Confirm your plan in the new tab and connect this device. Setup continues here.' : 'Finish checkout in the new tab, then connect this device. Setup continues here.')}</p>
          {status && (state === 'paid' ? <p className="checkout-status" role="status">{t(status)}</p>
            : <p className="checkout-status" role="status"><Spinner className="checkout-spinner" />{t(status)}</p>)}
          {/* No installer left means nothing waits on that pairing any more, so its code is not offered. */}
          {/* Keyed by the code, so a fresh pairing's code starts with no copy status left from the old one. */}
          {state === 'waiting' && !installerStopped && checkout?.userCode && codeLive(checkout) && <DeviceCode key={checkout.userCode} code={checkout.userCode} trial={monthlyTrial} />}
          {checkout?.state === 'failed' && <SetupError title={t(monthlyTrial ? 'Cloud Sync setup didn’t finish.' : 'Checkout didn’t finish.')} check={t(monthlyTrial ? 'Reopen Cloud Sync setup to try again.' : 'Open checkout again to try once more.')} detail={checkout.error} />}
        </div>
      </div>
      <SetupActions back={back}>
        {/* Paid: the way on. Otherwise "Open checkout", unless no installer is left to open it (the page's alert says how to restart). */}
        {state === 'paid' ? <SetupButton onClick={onContinue}>{t('Continue')} <ArrowRightIcon aria-hidden="true" /></SetupButton>
          : !installerStopped && <SetupButton onClick={onOpen} disabled={state === 'requested'}>{state === 'requested' ? t(monthlyTrial ? 'Opening Cloud Sync…' : 'Opening checkout…') : state ? t(monthlyTrial ? 'Reopen Cloud Sync setup' : 'Open checkout again') : t(monthlyTrial ? 'Open Cloud Sync setup' : 'Open checkout')} <ArrowRightIcon aria-hidden="true" /></SetupButton>}
      </SetupActions>
    </section>
  )
}
