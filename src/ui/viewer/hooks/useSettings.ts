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
    // Load initial settings
    fetch(API_ENDPOINTS.SETTINGS)
      .then(res => res.json())
      .then(data => {
        setSettings({
          CLAUDE_MEM_MODEL: data.CLAUDE_MEM_MODEL || DEFAULT_SETTINGS.CLAUDE_MEM_MODEL,
          CLAUDE_MEM_CONTEXT_OBSERVATIONS: data.CLAUDE_MEM_CONTEXT_OBSERVATIONS || DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_OBSERVATIONS,
          CLAUDE_MEM_WORKER_PORT: data.CLAUDE_MEM_WORKER_PORT || DEFAULT_SETTINGS.CLAUDE_MEM_WORKER_PORT
        });
      })
      .catch(error => {
        console.error('Failed to load settings:', error);
      });
  }, []);

  const saveSettings = async (newSettings: Settings) => {
    setIsSaving(true);
    setSaveStatus('Saving...');

    try {
      const response = await fetch(API_ENDPOINTS.SETTINGS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      });

      const result = await response.json();

      if (result.success) {
        setSettings(newSettings);
        setSaveStatus('✓ Saved');
        setTimeout(() => setSaveStatus(''), TIMING.SAVE_STATUS_DISPLAY_DURATION_MS);
      } else {
        setSaveStatus(`✗ Error: ${result.error}`);
      }
    } catch (error) {
      setSaveStatus(`✗ Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsSaving(false);
    }
  };

  return { settings, saveSettings, isSaving, saveStatus };
}
