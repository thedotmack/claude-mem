/**
 * cmem Pro trial promo for the viewer header.
 *
 * Mirrors `src/shared/pro-promo.ts` — the viewer's tsconfig pins rootDir to
 * this directory, so it cannot import the Node-side module. Change both
 * together when the offer or the URL moves.
 */

/** Trial length offered, in days. Mirrors PRO_TRIAL_DAYS in the shared module. */
export const PRO_TRIAL_DAYS = 30;

/**
 * Trial landing URL, tagged so cmem.ai can attribute viewer-sourced signups.
 * `trial=` is explicit — without it cmem.ai buckets the visitor into 7/14/30.
 */
export const PRO_TRIAL_URL = `https://cmem.ai/pro?from=viewer&trial=${PRO_TRIAL_DAYS}`;

export const PRO_TRIAL_PITCH = `Get 2x more use out of your Max plan for free (${PRO_TRIAL_DAYS}-day trial, $30/mo)`;

/** Header CTA label. The full pitch rides in the title/aria attributes. */
export const PRO_TRIAL_SHORT = 'Get 2x more from your Max plan';
