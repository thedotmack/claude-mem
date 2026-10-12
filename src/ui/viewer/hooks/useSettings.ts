import { useState, useEffect, useCallback } from 'react';
import { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';
import { describeSaveFailure } from '../utils/save-error';

export interface SubmitSettingsDependencies {
  fetchImpl: typeof fetch;
  setSettings: (settings: Settings) => void;
  setSaveStatus: (status: string) => void;
  setIsSaving: (isSaving: boolean) => void;
  setStatusTimeout?: (callback: () => void, delay: number) => void;
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
    deps.setSaveStatus(await describeSaveFailure(response));
    deps.setIsSaving(false);
    return;
  }

  const result = await response.json();

  if (result.success) {
    deps.setSettings(newSettings);
    deps.setSaveStatus('✓ Saved');
    (deps.setStatusTimeout ?? setTimeout)(
      () => deps.setSaveStatus(''),
      TIMING.SAVE_STATUS_DISPLAY_DURATION_MS,
    );
  } else {
    deps.setSaveStatus(`✗ Error: ${result.error}`);
  }
}

export async function saveSettings(
  newSettings: Settings,
  deps: SubmitSettingsDependencies,
  loaded?: Settings,
): Promise<void> {
  deps.setIsSaving(true);
  deps.setSaveStatus('Saving...');

  try {
    await submitSettings(newSettings, deps, loaded);
  } catch (error) {
    console.error('Failed to save settings:', error);
    deps.setSaveStatus(`✗ Error: ${error instanceof Error ? error.message : 'Network error'}`);
  }

  deps.setIsSaving(false);
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // `settings` holds DEFAULT_SETTINGS until the first GET succeeds. A save
  // before then would post those defaults over settings.json (provider,
  // worker port, blank API keys), so the modal keeps Save off until loaded.
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

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
        setLoadError(`Could not load settings: ${error instanceof Error ? error.message : String(error)}`);
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
