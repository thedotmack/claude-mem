import { useState, useEffect } from 'react';
import { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';

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

  const submitSettings = async (newSettings: Settings) => {
    const response = await fetch(API_ENDPOINTS.SETTINGS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings)
    });

    if (!response.ok) {
      setSaveStatus(`✗ Error: ${response.status === 401 ? 'Unauthorized' : response.statusText}`);
      setIsSaving(false);
      return;
    }

    const result = await response.json();

    if (result.success) {
      setSettings(newSettings);
      setSaveStatus('✓ Saved');
      setTimeout(() => setSaveStatus(''), TIMING.SAVE_STATUS_DISPLAY_DURATION_MS);
    } else {
      setSaveStatus(`✗ Error: ${result.error}`);
    }
  };

  const saveSettings = async (newSettings: Settings) => {
    setIsSaving(true);
    setSaveStatus('Saving...');

    try {
      await submitSettings(newSettings);
    } catch (error) {
      console.error('Failed to save settings:', error);
      setSaveStatus(`✗ Error: ${error instanceof Error ? error.message : 'Network error'}`);
    }

    setIsSaving(false);
  };

  return { settings, saveSettings, isSaving, saveStatus };
}
