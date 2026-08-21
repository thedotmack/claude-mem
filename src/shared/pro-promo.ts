/**
 * cmem Pro 30-day-trial promo copy — the single source of truth for every place
 * claude-mem tells an existing user the trial exists.
 *
 * Almost nobody running the free plugin knows the trial is there, so the pitch
 * rides along with the messages they already read: the session-start banner,
 * the per-message context banner, the first-session welcome hint, the installer
 * "Next Steps" block, and the viewer header. Keeping the wording and the URL
 * here means the funnel copy changes in one edit instead of five.
 *
 * The viewer keeps its own copy in `src/ui/viewer/constants/promo.ts` — its
 * tsconfig pins rootDir to the viewer directory, so it cannot import this file.
 * Change both together.
 */

/** Landing page for the trial (cmem-pro `src/app/(landing)/pro/page.tsx`). */
export const PRO_TRIAL_URL = 'https://cmem.ai/pro';

/**
 * Where a click came from. Passed through as `?from=` so cmem.ai can attribute
 * signups per surface — the landing page only special-cases `installer`, every
 * other value is attribution-only and renders the standard offer.
 */
export type ProPromoSource =
  | 'installer'
  | 'session-start'
  | 'context-banner'
  | 'welcome-hint'
  | 'viewer'
  /** Hand-written links in the cursor-hooks setup docs — no TS caller. */
  | 'docs';

/** Trial landing URL tagged with the surface the user clicked from. */
export function proTrialUrl(source: ProPromoSource): string {
  return `${PRO_TRIAL_URL}?from=${source}`;
}

/** The offer itself, without a URL — for surfaces that link separately. */
export const PRO_TRIAL_PITCH = 'Get 2x more use out of your Max plan for free (30-day trial, $30/mo)';

/**
 * One-line pitch + link, for plain-text surfaces (hook banners, welcome hint).
 * Callers that want ANSI styling should compose from PRO_TRIAL_PITCH and
 * proTrialUrl() instead so the escape codes stay at the presentation layer.
 */
export function proTrialLine(source: ProPromoSource): string {
  return `${String.fromCodePoint(0x2728)} ${PRO_TRIAL_PITCH} ${proTrialUrl(source)}`;
}

// --- Pro fallback upsell -----------------------------------------------------
// Shown ONLY while the pro-fallback marker is active (src/shared/pro-fallback.ts):
// the trial allowance ran out and memory generation moved to the user's
// fallback provider. NO dollar allowance/cap values here, ever — $30 is the
// subscription price, which is public.

/** Account dashboard, where "pay for your trial now" happens. */
export const PRO_DASHBOARD_URL = 'https://cmem.ai/dashboard';

/** Dashboard URL tagged with the fallback surface the user clicked from. */
export function proFallbackUrl(source: ProPromoSource): string {
  return `${PRO_DASHBOARD_URL}?from=fallback-${source}`;
}

// Cap-hit framing is a celebration, not a paywall: the user out-used the trial
// because the product works, fallback already kept them running, and THIS is
// the best-timed upgrade moment. Never phrase it as "limit reached, pay now."
export const PRO_FALLBACK_UPSELL =
  "Achievement unlocked: you're one of the heaviest memory users this cycle, so claude-mem switched to your fallback provider — nothing stopped. Want it all back? Pay for your trial now and get 6x more usage for just $30:";

/** One-line upsell + link, for plain-text surfaces (hook banners). */
export function proFallbackLine(source: ProPromoSource): string {
  return `${String.fromCodePoint(0x1F3C6)} ${PRO_FALLBACK_UPSELL} ${proFallbackUrl(source)}`;
}
