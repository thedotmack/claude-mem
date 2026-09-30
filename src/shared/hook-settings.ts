
import {
  SettingsDefaultsManager,
  type SettingsDefaults,
} from './SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from './paths.js';

let cachedSettings: SettingsDefaults | null = null;

export function loadFromFileOnce(): SettingsDefaults {
  if (cachedSettings !== null) return cachedSettings;
  cachedSettings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return cachedSettings;
}
