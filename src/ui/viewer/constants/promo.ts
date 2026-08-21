/**
 * cmem Pro trial promo for the viewer header.
 *
 * Mirrors `src/shared/pro-promo.ts` — the viewer's tsconfig pins rootDir to
 * this directory, so it cannot import the Node-side module. Change both
 * together when the offer or the URL moves.
 */

/** Trial landing URL, tagged so cmem.ai can attribute viewer-sourced signups. */
export const PRO_TRIAL_URL = 'https://cmem.ai/pro?from=viewer';

export const PRO_TRIAL_PITCH = 'Get 2x more use out of your Max plan for free (30-day trial, $30/mo)';

/** Header CTA label. The full pitch rides in the title/aria attributes. */
export const PRO_TRIAL_SHORT = 'Get 2x more from your Max plan';

// Pro fallback upsell (lockstep with src/shared/pro-promo.ts — no dollar
// allowance/cap values, ever; $30 is the public subscription price).
export const PRO_FALLBACK_UPSELL =
  'Trial allowance used — claude-mem switched to your fallback provider. Pay for your trial now and get 6x more usage for just $30:';

/** Dashboard URL, tagged so cmem.ai can attribute viewer-sourced pay-now clicks. */
export const PRO_FALLBACK_URL = 'https://cmem.ai/dashboard?from=fallback-viewer';
