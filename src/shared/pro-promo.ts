/**
 * cmem Pro trial promo copy — the single source of truth for every place
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
  /** One-time session-start notice after the cmem gateway stops serving the account and memory falls back on-plan. */
  | 'fallback'
  /** Hand-written links in the cursor-hooks setup docs — no TS caller. */
  | 'docs';

/**
 * The standard free trial cmem.ai grants, in days. The server assigns the
 * duration at claim time; promo links carry only source attribution.
 */
export const PRO_TRIAL_MAX_DAYS = 30;

/** Public offer label shared by the installer and promotional surfaces. */
export const PRO_TRIAL_LABEL = `${PRO_TRIAL_MAX_DAYS} Day Free Trial`;

/** Trial landing URL tagged with the surface the user clicked from. */
export function proTrialUrl(source: ProPromoSource): string {
  return `${PRO_TRIAL_URL}?from=${source}`;
}

/**
 * How much more plan usage running memory off-plan buys, as a "% more" figure.
 * Shared so every surface quotes the same number.
 */
export const PLAN_USAGE_GAIN_PERCENT = 100;

/** The offer itself, without a URL — for surfaces that link separately. */
export const PRO_TRIAL_PITCH = `${PRO_TRIAL_LABEL} — memory runs off-plan. Get up to ${PLAN_USAGE_GAIN_PERCENT}% more usage from your plan`;

/**
 * One-line pitch + link, for plain-text surfaces (hook banners, welcome hint).
 * Callers that want ANSI styling should compose from PRO_TRIAL_PITCH and
 * proTrialUrl() instead so the escape codes stay at the presentation layer.
 */
export function proTrialLine(source: ProPromoSource): string {
  return `${String.fromCodePoint(0x2728)} ${PRO_TRIAL_PITCH} ${proTrialUrl(source)}`;
}

// ---------------------------------------------------------------------------
// Backup add-on upsell (pro-backup plan Phase 4)
// ---------------------------------------------------------------------------

/**
 * Which surface rendered the backup-addon upsell — passed through as
 * `?from=backup-<source>` so cmem.ai can attribute add-on purchases per
 * surface. `backup-addon` is what the sync hub itself embeds in its 403 body.
 */
export type BackupAddonSource =
  | 'worker'
  | 'doctor'
  | 'status'
  | 'viewer'
  /** The hub's own 403 addon_required body (workers/sync-hub). */
  | 'addon';

/** Dashboard URL where the backup add-on is purchased, tagged per surface. */
export function backupAddonUrl(source: BackupAddonSource): string {
  return `https://cmem.ai/dashboard?from=backup-${source}`;
}

/**
 * The upsell itself, without a URL. Deliberately price-free: the add-on SKU
 * price lives in cmem-pro-mvp/Stripe, and no dollar value ever belongs in
 * this file (see the promo conventions above).
 */
export const BACKUP_ADDON_PITCH =
  'Cloud backups are a cmem Pro add-on. Your local snapshots are safe — add encrypted cloud copies:';

/** One-line upsell + attributed link, for plain-text surfaces. */
export function backupAddonLine(source: BackupAddonSource): string {
  return `${BACKUP_ADDON_PITCH} ${backupAddonUrl(source)}`;
}
