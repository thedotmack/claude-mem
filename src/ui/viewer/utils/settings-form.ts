import type { Settings } from '../types';

/**
 * The Settings dialog's sections, in list order. One definition: the section list, the panels and the
 * words for each (SECTION_WORDS in ContextSettingsModal.tsx, a Record over this type) take it from here.
 * One section shows at a time; the others stay one click away in the list.
 */
export const SETTINGS_SECTIONS = ['loading', 'display', 'context', 'images', 'backups', 'provider', 'fallbacks', 'advanced'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/**
 * The values the worker accepts for each number field: the same bounds SettingsRoutes.validateSettings enforces
 * (its reasons are there, e.g. the backup bounds). A field outside them says so under itself before Save.
 * tests/viewer/settings-dialog.test.ts reads the worker's messages and fails if these drift.
 */
export const SETTING_RANGES = {
  CLAUDE_MEM_CONTEXT_OBSERVATIONS: { min: 0, max: 200, decimals: false },
  CLAUDE_MEM_CONTEXT_SESSION_COUNT: { min: 0, max: 50, decimals: false },
  CLAUDE_MEM_CONTEXT_FULL_COUNT: { min: 0, max: 20, decimals: false },
  CLAUDE_MEM_BACKUP_INTERVAL_HOURS: { min: 1, max: 168, decimals: true },
  CLAUDE_MEM_BACKUP_RETAIN_COUNT: { min: 1, max: 100, decimals: false },
  CLAUDE_MEM_WORKER_PORT: { min: 1024, max: 65535, decimals: false },
} as const satisfies Partial<Record<keyof Settings, { min: number; max: number; decimals: boolean }>>;
export type RangedSetting = keyof typeof SETTING_RANGES;

/**
 * What the dialog's footer says about the form. One writer: settingsFooterState() below; the dialog words
 * each state through FOOTER_WORDS, a Record<SettingsFooterState, …> in ContextSettingsModal.tsx.
 *
 *   loading ──GET answers──> clean ──a field changes──> dirty ──Save──> saving ──saved──> saved
 *   loading ──GET fails──> load-failed ──Retry──> loading     saving ──refused──> dirty (the reason under Details)
 *   dirty ──the change is undone──> clean                      saved ──a field changes──> dirty
 */
export const SETTINGS_FOOTER_STATES = ['loading', 'load-failed', 'clean', 'dirty', 'saving', 'saved'] as const;
export type SettingsFooterState = (typeof SETTINGS_FOOTER_STATES)[number];

export function settingsFooterState({ isLoaded, loadError, isSaving, changedCount, savedAt }: {
  isLoaded: boolean;
  loadError: string | null;
  isSaving: boolean;
  /** How many settings the form changed and did not save yet. */
  changedCount: number;
  /** When this dialog last saw a save succeed with nothing changed since; null otherwise. */
  savedAt: number | null;
}): SettingsFooterState {
  if (!isLoaded) return loadError ? 'load-failed' : 'loading';
  if (isSaving) return 'saving';
  if (changedCount > 0) return 'dirty';
  return savedAt === null ? 'clean' : 'saved';
}

/**
 * The settings whose value in the form differs from the saved settings, in a stable order. CLAUDE_CODE_PATH is
 * file and environment only (submitSettings never posts it), so it never counts as a change.
 */
export function changedSettingKeys(form: Settings, saved: Settings): (keyof Settings)[] {
  const keys = new Set([...Object.keys(saved), ...Object.keys(form)] as (keyof Settings)[]);
  return [...keys].filter(key => key !== 'CLAUDE_CODE_PATH' && (form[key] ?? '') !== (saved[key] ?? '')).sort();
}

/** True when a number field's value is one the worker would refuse (the field shows why under it). */
export function outOfRange(value: string | undefined, setting: RangedSetting): boolean {
  const { min, max, decimals } = SETTING_RANGES[setting];
  const text = (value ?? '').trim();
  if (!(decimals ? /^\d+(\.\d+)?$/ : /^\d+$/).test(text)) return true;
  const number = Number(text);
  return number < min || number > max;
}
