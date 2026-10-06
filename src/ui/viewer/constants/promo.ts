/**
 * cmem Pro trial promo for the viewer header.
 *
 * Mirrors `src/shared/pro-promo.ts` — the viewer's tsconfig pins rootDir to
 * this directory, so it cannot import the Node-side module. Change both
 * together when the offer or the URL moves.
 */

/**
 * The standard free trial cmem.ai grants, in days.
 */
export const PRO_TRIAL_MAX_DAYS = 30;

/** Public offer label, mirrored from the Node-side shared module. */
export const PRO_TRIAL_LABEL = `${PRO_TRIAL_MAX_DAYS} Day Free Trial`;

/** Trial landing URL, tagged so cmem.ai can attribute viewer-sourced signups. */
export const PRO_TRIAL_URL = 'https://cmem.ai/pro?from=viewer';

/**
 * How much more plan usage running memory off-plan buys, as a "% more" figure.
 * Shared so every surface quotes the same number.
 */
export const PLAN_USAGE_GAIN_PERCENT = 100;

export const PRO_TRIAL_PITCH = `${PRO_TRIAL_LABEL} — memory runs off-plan. Get up to ${PLAN_USAGE_GAIN_PERCENT}% more usage from your plan`;

/** Header CTA label. The full pitch rides in the title/aria attributes. */
export const PRO_TRIAL_SHORT = PRO_TRIAL_LABEL;
