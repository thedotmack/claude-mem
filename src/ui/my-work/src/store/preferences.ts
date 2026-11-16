// Where My Work saves how the person likes to see it, and in which version. Its own module with no imports, so the
// store (create-store.ts) and the pre-paint theme script (lib/theme-pre-paint.ts, put into index.html by
// vite.config.ts) read the same two values from one place.

/** The localStorage key of the saved display preferences. */
export const PREFERENCES_STORAGE_KEY = 'claude-mem:my-work:preferences'

/** Bump when a persisted field changes meaning; older saved preferences are then dropped, by the store and the script. */
export const PREFERENCES_VERSION = 1
