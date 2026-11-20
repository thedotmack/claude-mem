import { useState, useEffect, useCallback } from 'react';
import { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { API_ENDPOINTS } from '../constants/api';
import { describeSaveFailure } from '../utils/save-error';

/**
 * How the last save ended, as the Settings dialog shows it. One writer: saveSettings() and submitSettings() below,
 * through `setSaveStatus`; the dialog words it through SAVE_OUTCOME_WORDS (ContextSettingsModal.tsx), a Record over it.
 *
 *   none ──the worker accepts a save──> saved
 *   none ──the worker refuses it, or cannot be reached──> failed
 *   saved | failed ──the next Save starts──> none
 *
 * It was read from a ✓ or ✗ inside the translated status text, so a translation without the glyph would have
 * dropped "Saved at …" and "Could not save settings.".
 */
export const SAVE_OUTCOMES = ['none', 'saved', 'failed'] as const;
export type SaveOutcome = (typeof SAVE_OUTCOMES)[number];

export interface SaveStatus {
  outcome: SaveOutcome;
  /** Why the save failed, as the worker or the network said it (shown under Details); null unless `failed`. */
  reason: string | null;
}

export const NO_SAVE_STATUS: SaveStatus = { outcome: 'none', reason: null };

export interface SubmitSettingsDependencies {
  fetchImpl: typeof fetch;
  setSettings: (settings: Settings) => void;
  setSaveStatus: (status: SaveStatus) => void;
  setIsSaving: (isSaving: boolean) => void;
}

/**
 * POST the settings. With `loaded` (what this tab last read or saved), only
 * the keys that differ from it are sent, so a save from a tab opened earlier
 * doesn't put back values changed elsewhere since (#4597).
 */
export async function submitSettings(
  newSettings: Settings,
  deps: SubmitSettingsDependencies,
  loaded?: Settings,
): Promise<void> {
  // CLAUDE_CODE_PATH is file/env only (spawn binary). Never POST it, even
  // when GET echoed it into local state.
  const { CLAUDE_CODE_PATH: _fileOnly, ...writableSettings } = newSettings;
  const posted = loaded
    ? Object.fromEntries(Object.entries(writableSettings).filter(
      ([key, value]) => value !== loaded[key as keyof Settings],
    ))
    : writableSettings;
  const response = await deps.fetchImpl(API_ENDPOINTS.SETTINGS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(posted)
  });

  if (!response.ok) {
    deps.setSaveStatus({ outcome: 'failed', reason: await describeSaveFailure(response) });
    deps.setIsSaving(false);
    return;
  }

  const result = await response.json();

  if (result.success) {
    deps.setSettings(newSettings);
    deps.setSaveStatus({ outcome: 'saved', reason: null });
  } else {
    deps.setSaveStatus({ outcome: 'failed', reason: `✗ Error: ${result.error}` });
  }
}

export async function saveSettings(
  newSettings: Settings,
  deps: SubmitSettingsDependencies,
  loaded?: Settings,
): Promise<void> {
  deps.setIsSaving(true);
  // A new save starts from no outcome, so "Saved at …" and "Could not save settings." always describe this one.
  deps.setSaveStatus(NO_SAVE_STATUS);

  try {
    await submitSettings(newSettings, deps, loaded);
  } catch (error) {
    console.error('Failed to save settings:', error);
    deps.setSaveStatus({ outcome: 'failed', reason: `✗ Error: ${error instanceof Error ? error.message : 'Network error'}` });
  }

  deps.setIsSaving(false);
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // `settings` holds DEFAULT_SETTINGS until the first GET succeeds. A save
  // before then would post those defaults over settings.json (provider,
  // worker port, blank API keys), so the modal keeps Save off until loaded.
  const [isLoaded, setIsLoaded] = useState(false);
  // Why the first GET failed, as the network or the worker said it ("HTTP 500"): the dialog says it could not load
  // the settings in plain words and folds this under Details (G17).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(NO_SAVE_STATUS);

  useEffect(() => {
    let active = true;
    fetch(API_ENDPOINTS.SETTINGS)
      .then(async res => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        if (!active) return;
        setSettings({ ...DEFAULT_SETTINGS, ...data });
        setIsLoaded(true);
      })
      .catch(error => {
        console.error('Failed to load settings:', error);
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, [loadAttempt]);

  /** Re-run the initial GET after it failed. */
  const reload = useCallback(() => {
    setLoadError(null);
    setLoadAttempt(attempt => attempt + 1);
  }, []);

  return {
    settings,
    isLoaded,
    loadError,
    reload,
    saveSettings: (newSettings: Settings) => saveSettings(newSettings, {
      fetchImpl: fetch.bind(globalThis) as typeof fetch,
      setSettings,
      setSaveStatus,
      setIsSaving,
    }, settings),
    isSaving,
    saveStatus,
  };
}
