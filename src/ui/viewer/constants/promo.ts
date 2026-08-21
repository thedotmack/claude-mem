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
