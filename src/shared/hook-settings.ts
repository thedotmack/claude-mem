
import {
  SettingsDefaultsManager,
  type SettingsDefaults,
} from './SettingsDefaultsManager.js';
import { normalizeLocalApiToken } from './local-api-token.js';
import { USER_SETTINGS_PATH } from './paths.js';

let cachedSettings: SettingsDefaults | null = null;

export function loadFromFileOnce(): SettingsDefaults {
  if (cachedSettings !== null) return cachedSettings;
  cachedSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return cachedSettings;
}

/**
 * The local API token (#5141), from settings.json alone: applyEnvOverrides is off, so the
 * environment cannot switch the mode. Empty means off. Read-only: never creates the file.
 */
export function readLocalApiToken(): string {
  return normalizeLocalApiToken(
    SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, false, { readOnly: true }).CLAUDE_MEM_LOCAL_API_TOKEN,
  );
}

/** Test seam: each production hook process loads once and then exits. */
export function resetHookSettingsCacheForTesting(): void {
  cachedSettings = null;
}
