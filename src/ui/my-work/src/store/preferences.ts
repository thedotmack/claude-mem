// Where My Work saves how the person likes to see it, and in which version. Its own module with no imports, so the
// store (create-store.ts) and the pre-paint theme script (lib/theme-pre-paint.ts, put into index.html by
// vite.config.ts) read the same values from one place.

/** The localStorage key of the saved display preferences. */
export const PREFERENCES_STORAGE_KEY = 'claude-mem:my-work:preferences'

/**
 * Bump when a persisted field changes meaning, and teach the store's migration (create-store.ts migratePreferences)
 * what an older version's fields mean now. Versions older than OLDEST_MIGRATED_PREFERENCES_VERSION, or newer than this
 * one, are dropped, by the store and by the pre-paint script alike.
 *
 * 2 (16.0.0): the home board opens compact (page-01). Version 1 saved `focusArtwork: 'full'`, the old default, on every
 * visit as if the person had chosen it: zustand persist writes the saved fields after every state change, and
 * `focusArtwork` was saved from 15.19.0 on. So a version-1 'full' is not a choice, and the migration drops it.
 */
export const PREFERENCES_VERSION = 2

/** The oldest saved version the store migrates instead of dropping. Its theme means what the current version's does. */
export const OLDEST_MIGRATED_PREFERENCES_VERSION = 1
