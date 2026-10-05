import { useState, useEffect, useRef } from 'react';
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
  // CLAUDE_CODE_PATH is file/env only (spawn binary). Never POST it, even
  // when GET echoed it into local state.
  const { CLAUDE_CODE_PATH: _fileOnly, ...writableSettings } = newSettings;
  const response = await deps.fetchImpl(API_ENDPOINTS.SETTINGS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(writableSettings)
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
  const savedRevision = useRef(0);

  useEffect(() => {
    const revisionAtLoad = savedRevision.current;
    let active = true;
    fetch(API_ENDPOINTS.SETTINGS)
      .then(async res => {
        if (!res.ok) {
          throw new Error(`Failed to load settings (${res.status})`);
        }
        return res.json();
      })
      .then(data => {
        // An initial GET can finish after the user has already saved. Its
        // older snapshot must not replace that successfully committed state.
        if (!active) return;
        if (savedRevision.current === revisionAtLoad) {
          setSettings({ ...DEFAULT_SETTINGS, ...data });
        } else {
          // This file-only value cannot be submitted by the form. Retain it
          // from the load while preserving every successfully saved field.
          setSettings(current => current.CLAUDE_CODE_PATH === data.CLAUDE_CODE_PATH
            ? current
            : { ...current, CLAUDE_CODE_PATH: data.CLAUDE_CODE_PATH });
        }
      })
      .catch(error => {
        console.error('Failed to load settings:', error);
      });
    return () => { active = false; };
  }, []);

  return {
    settings,
    saveSettings: (newSettings: Settings) => saveSettings(newSettings, {
      fetchImpl: fetch.bind(globalThis) as typeof fetch,
      setSettings: nextSettings => {
        savedRevision.current++;
        setSettings(nextSettings);
      },
      setSaveStatus,
      setIsSaving,
    }),
    isSaving,
    saveStatus,
  };
}
