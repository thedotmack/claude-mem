
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ContextConfig } from './types.js';

function parseCsvSetting(raw: string | undefined): string[] | null {
  const values = (raw ?? '').split(',').map(v => v.trim()).filter(v => v !== '');
  return values.length > 0 ? values : null;
}

export function loadContextConfig(): ContextConfig {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

  const mode = ModeManager.getInstance().getActiveMode();
  // CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES / _CONCEPTS are documented in
  // configuration.mdx and persisted by SettingsRoutes, but these two sets were
  // built from the mode file alone — so a user narrowing their injected context
  // got the mode's full list regardless. Empty keeps the mode-wide default.
  const observationTypes = new Set(
    parseCsvSetting(settings.CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES) ?? mode.observation_types.map(t => t.id)
  );
  const observationConcepts = new Set(
    parseCsvSetting(settings.CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS) ?? mode.observation_concepts.map(c => c.id)
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
