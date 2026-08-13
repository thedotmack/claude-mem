/**
 * cmem Pro 7-day-trial promo copy — the single source of truth for every place
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
export const PRO_TRIAL_PITCH = 'Get cmem Pro — 7-day free trial: cloud sync + memory model';

/**
 * One-line pitch + link, for plain-text surfaces (hook banners, welcome hint).
 * Callers that want ANSI styling should compose from PRO_TRIAL_PITCH and
 * proTrialUrl() instead so the escape codes stay at the presentation layer.
 */
export function proTrialLine(source: ProPromoSource): string {
  return `${String.fromCodePoint(0x2728)} ${PRO_TRIAL_PITCH} ${proTrialUrl(source)}`;
}
