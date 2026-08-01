import { useState, useEffect } from 'react';
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

export async function submitSettings(
  newSettings: Settings,
  deps: SubmitSettingsDependencies,
): Promise<void> {
  const response = await deps.fetchImpl(API_ENDPOINTS.SETTINGS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newSettings)
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
): Promise<void> {
  deps.setIsSaving(true);
  deps.setSaveStatus('Saving...');

  try {
    await submitSettings(newSettings, deps);
  } catch (error) {
    console.error('Failed to save settings:', error);
    deps.setSaveStatus(`✗ Error: ${error instanceof Error ? error.message : 'Network error'}`);
  }

  deps.setIsSaving(false);
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  useEffect(() => {
    fetch(API_ENDPOINTS.SETTINGS)
      .then(async res => {
        if (!res.ok) {
          throw new Error(`Failed to load settings (${res.status})`);
        }
        return res.json();
      })
      .then(data => {
        setSettings({ ...DEFAULT_SETTINGS, ...data });
      })
      .catch(error => {
        console.error('Failed to load settings:', error);
      });
  }, []);

  return {
    settings,
    saveSettings: (newSettings: Settings) => saveSettings(newSettings, {
      fetchImpl: fetch.bind(globalThis) as typeof fetch,
      setSettings,
      setSaveStatus,
      setIsSaving,
    }),
    isSaving,
    saveStatus,
  };
}
