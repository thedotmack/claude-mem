import { useState, useEffect } from 'react';
import { Settings } from '../types';

export function useSettings() {
  const [settings, setSettings] = useState<Settings>({
    CLAUDE_MEM_MODEL: 'claude-haiku-4-5',
    CLAUDE_MEM_CONTEXT_OBSERVATIONS: '50',
    CLAUDE_MEM_WORKER_PORT: '37777'
  });
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  useEffect(() => {
    // Load initial settings
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        setSettings({
          CLAUDE_MEM_MODEL: data.CLAUDE_MEM_MODEL || 'claude-haiku-4-5',
          CLAUDE_MEM_CONTEXT_OBSERVATIONS: data.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50',
          CLAUDE_MEM_WORKER_PORT: data.CLAUDE_MEM_WORKER_PORT || '37777'
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
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      });

      const result = await response.json();

      if (result.success) {
        setSettings(newSettings);
        setSaveStatus('✓ Saved');
        setTimeout(() => setSaveStatus(''), 3000);
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
