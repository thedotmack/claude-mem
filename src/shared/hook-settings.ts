/**
 * Per-process settings cache for hook handlers.
 *
 * Plan 05 Phase 4 (PATHFINDER-2026-04-22): each hook process is short-lived,
 * but multiple handlers within a single hook invocation independently call
 * `SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)` and re-read the
 * settings file from disk. Settings cannot mutate during a single hook
 * invocation, so we memoize the first read for the lifetime of the process.
 *
 * One helper, N callers (Principle 6). Every hook handler that needs settings
 * imports `loadFromFileOnce()` from here instead of calling
 * `SettingsDefaultsManager.loadFromFile` directly.
 */

import {
  SettingsDefaultsManager,
  type SettingsDefaults,
} from './SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from './paths.js';

let cachedSettings: SettingsDefaults | null = null;

/**
 * Load settings from disk on first call, return the memoized value thereafter.
 *
 * Cache lifetime is the process — hooks are short-lived (typically <1s), so a
 * settings change made by the user is picked up the next time Claude Code
 * spawns a hook process. There is no in-process invalidation API because there
 * is no in-process mutation path.
 */
export function loadFromFileOnce(): SettingsDefaults {
  if (cachedSettings !== null) return cachedSettings;
  cachedSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return cachedSettings;
}
