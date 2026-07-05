
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { paths } from '../../shared/paths.js';
import { ModeManager } from '../domain/ModeManager.js';
import type { ContextConfig } from './types.js';

// Mirrors SettingsDefaultsManager.DEFAULTS for the three numeric context
// fields. Kept here as the last-line-of-defense default so a corrupted
// settings.json (manual edits writing null / "" / non-numeric strings) can't
// surface NaN downstream — see asInt below for why that matters.
const FALLBACK_TOTAL_OBSERVATION_COUNT = 50;
const FALLBACK_FULL_OBSERVATION_COUNT = 0;
const FALLBACK_SESSION_COUNT = 10;

// parseInt('', 10) and parseInt(undefined as any, 10) both return NaN.
// SettingsDefaultsManager.loadFromFile guarantees these keys exist under
// the happy path, but a settings.json edited by hand or written by a
// pre-migration tool can carry null / "" / non-numeric values; the spread
// in SettingsDefaultsManager that overlays user values then copies the
// bad type over the string default. NaN flows from here into SQL LIMIT
// bindings and Array.prototype.slice indices, which Postgres rejects and
// JS silently coerces to empty results — a silent context truncation.
function asInt(value: unknown, fallback: number): number {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadContextConfig(): ContextConfig {
  const settingsPath = paths.settings();
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

  const mode = ModeManager.getInstance().getActiveMode();
  const observationTypes = new Set(mode.observation_types.map(t => t.id));
  const observationConcepts = new Set(mode.observation_concepts.map(c => c.id));

  return {
    totalObservationCount: asInt(
      settings.CLAUDE_MEM_CONTEXT_OBSERVATIONS,
      FALLBACK_TOTAL_OBSERVATION_COUNT,
    ),
    fullObservationCount: asInt(
      settings.CLAUDE_MEM_CONTEXT_FULL_COUNT,
      FALLBACK_FULL_OBSERVATION_COUNT,
    ),
    sessionCount: asInt(settings.CLAUDE_MEM_CONTEXT_SESSION_COUNT, FALLBACK_SESSION_COUNT),
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
