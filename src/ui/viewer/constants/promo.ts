/**
 * cmem Pro trial promo for the viewer header.
 *
 * Mirrors `src/shared/pro-promo.ts` — the viewer's tsconfig pins rootDir to
 * this directory, so it cannot import the Node-side module. Change both
 * together when the offer or the URL moves.
 */

/** Trial landing URL, tagged so cmem.ai can attribute viewer-sourced signups. */
export const PRO_TRIAL_DAYS = 30;

export const PRO_TRIAL_URL = `https://cmem.ai/pro?from=viewer&trial=${PRO_TRIAL_DAYS}`;

/**
 * How much more plan usage running memory off-plan buys, as a "% more" figure.
 * Shared so every surface quotes the same number.
 */
export const PLAN_USAGE_GAIN_PERCENT = 100;

export const PRO_TRIAL_PITCH = `Get up to ${PLAN_USAGE_GAIN_PERCENT}% more usage from your plan — memory runs off-plan, free for ${PRO_TRIAL_DAYS} days`;

/** Header CTA label. The full pitch rides in the title/aria attributes. */
export const PRO_TRIAL_SHORT = 'Get up to 100% more usage from your plan';
