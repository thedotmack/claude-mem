import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { logger } from '../../utils/logger.js';

export const DEFAULT_OBSERVATION_BATCH_SIZE = 5;
export const MAX_OBSERVATION_BATCH_SIZE = 25;
export const OBSERVATION_BATCH_SIZE_CACHE_MS = 1000;

export function parseObservationBatchSize(value: unknown): number {
  const parsed = parseInt(String(value), 10);
  if (isNaN(parsed)) return DEFAULT_OBSERVATION_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_OBSERVATION_BATCH_SIZE, parsed));
}

export class ObservationBatchSizeResolver {
  private cached: { value: number; loadedAt: number } | null = null;

  constructor(
    private readonly settingsPath: string = USER_SETTINGS_PATH,
    private readonly cacheTtlMs: number = OBSERVATION_BATCH_SIZE_CACHE_MS
  ) {}

  get(now: number = Date.now()): number {
    if (this.cached && now - this.cached.loadedAt < this.cacheTtlMs) {
      return this.cached.value;
    }

    const settings = SettingsDefaultsManager.loadFromFile(this.settingsPath);
    const configuredValue = String(settings.CLAUDE_MEM_OBSERVATION_BATCH_SIZE);
    const value = parseObservationBatchSize(configuredValue);
    if (configuredValue.trim() !== String(value)) {
      logger.debug('SESSION', 'Observation batch size setting normalized', {
        configuredValue,
        value,
        max: MAX_OBSERVATION_BATCH_SIZE,
      });
    }
    this.cached = { value, loadedAt: now };
    return value;
  }
}
