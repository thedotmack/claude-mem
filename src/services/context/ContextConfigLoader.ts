
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import { ModeManager } from '../domain/ModeManager.js';
import { logger } from '../../utils/logger.js';
import type { ContextConfig } from './types.js';

function parseCsvSetting(raw: string | undefined): string[] | null {
  const values = (raw ?? '').split(',').map(v => v.trim()).filter(v => v !== '');
  return values.length > 0 ? values : null;
}

// Settings keep the ids of whatever mode was active when they were written, so
// after a CLAUDE_MEM_MODE switch they can name ids the active mode never emits
// and filter every observation out. Keep only the active mode's ids; if none
// survive (or nothing is configured), use the mode's full list.
function filterToActiveModeIds(settingKey: string, raw: string | undefined, modeIds: string[]): Set<string> {
  const configuredIds = parseCsvSetting(raw);
  if (!configuredIds) return new Set(modeIds);

  const validIds = configuredIds.filter(id => modeIds.includes(id));
  const discardedIds = configuredIds.filter(id => !modeIds.includes(id));
  if (discardedIds.length > 0) {
    logger.warn('CONFIG', `${settingKey} has ids not in the active mode; ignoring them`, {
      discardedIds: discardedIds.join(','),
      fallingBackToModeList: validIds.length === 0,
    });
  }
  return new Set(validIds.length > 0 ? validIds : modeIds);
}

export function loadContextConfig(): ContextConfig {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

  const mode = ModeManager.getInstance().getActiveMode();
  // CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES / _CONCEPTS are documented in
  // configuration.mdx and persisted by SettingsRoutes; they narrow the mode's
  // lists, never widen them. Empty keeps the mode-wide default.
  const observationTypes = filterToActiveModeIds(
    'CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES',
    settings.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES,
    mode.observation_types.map(t => t.id)
  );
  const observationConcepts = filterToActiveModeIds(
    'CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS',
    settings.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS,
    mode.observation_concepts.map(c => c.id)
  );

  return {
    totalObservationCount: parseInt(settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS, 10),
    fullObservationCount: parseInt(settings.CLAUDE_MEM_CONTEXT_FULL_COUNT, 10),
    sessionCount: parseInt(settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT, 10),
    showReadTokens: settings.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true',
    showWorkTokens: settings.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true',
    showSavingsAmount: settings.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true',
    showSavingsPercent: settings.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT === 'true',
    observationTypes,
    observationConcepts,
    fullObservationField: settings.CLAUDE_MEM_CONTEXT_FULL_FIELD as 'narrative' | 'facts',
    showLastSummary: settings.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true',
    showLastMessage: settings.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true',
  };
}
