/**
 * cmem Pro trial promo for the viewer header.
 *
 * Mirrors `src/shared/pro-promo.ts` — the viewer's tsconfig pins rootDir to
 * this directory, so it cannot import the Node-side module. Change both
 * together when the offer or the URL moves.
 */

/** Trial landing URL, tagged so cmem.ai can attribute viewer-sourced signups. */
export const PRO_TRIAL_URL = 'https://cmem.ai/pro?from=viewer';

/**
 * How much more plan usage running memory off-plan buys, as a "% more" figure.
 * Shared so every surface quotes the same number.
 */
export const PLAN_USAGE_GAIN_PERCENT = 100;

export const PRO_TRIAL_PITCH = `Get up to ${PLAN_USAGE_GAIN_PERCENT}% more usage from your plan — memory runs off-plan, free for 7 days`;

/** Header CTA label. The full pitch rides in the title/aria attributes. */
export const PRO_TRIAL_SHORT = 'Get up to 100% more usage from your plan';

/**
 * Backup add-on upsell (pro-backup plan Phase 4). Mirrors
 * `src/shared/pro-promo.ts` backupAddonUrl('viewer')/BACKUP_ADDON_PITCH —
 * change both together. Price-free on purpose: no dollar values in promo copy.
 */
export const BACKUP_ADDON_URL = 'https://cmem.ai/dashboard?from=backup-viewer';

export const BACKUP_ADDON_PITCH =
  'Cloud backups are a cmem Pro add-on. Your local snapshots are safe — add encrypted cloud copies:';
