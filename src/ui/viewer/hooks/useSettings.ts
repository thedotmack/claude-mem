import { useState, useEffect } from 'react';
import type { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { API_ENDPOINTS } from '../constants/api';
import { TIMING } from '../constants/timing';
import { logger } from '../utils/logger';

interface SaveSettingsResponse {
  success: boolean;
  error?: string;
}

/**
 * Settings hook for the viewer UI.
 *
 * SECURITY NOTE: API keys (Gemini, OpenAI-compat) are held in React state
 * unredacted because the settings form requires full values for editing.
 * The security boundary is the localhost-only CORS restriction on the worker
 * API — these values never leave the local machine.
 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch(API_ENDPOINTS.SETTINGS, { signal: controller.signal })
      .then(res => res.json() as Promise<Partial<Settings>>)
      .then(data => {
        if (controller.signal.aborted) return;
        setSettings({
          MAGIC_CLAUDE_MEM_MODEL: data.MAGIC_CLAUDE_MEM_MODEL || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_MODEL,
          MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATIONS: data.MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATIONS || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATIONS,
          MAGIC_CLAUDE_MEM_WORKER_PORT: data.MAGIC_CLAUDE_MEM_WORKER_PORT || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_WORKER_PORT,
          MAGIC_CLAUDE_MEM_WORKER_HOST: data.MAGIC_CLAUDE_MEM_WORKER_HOST || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_WORKER_HOST,
          MAGIC_CLAUDE_MEM_PROVIDER: data.MAGIC_CLAUDE_MEM_PROVIDER || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_PROVIDER,
          MAGIC_CLAUDE_MEM_GEMINI_API_KEY: data.MAGIC_CLAUDE_MEM_GEMINI_API_KEY || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_GEMINI_API_KEY,
          MAGIC_CLAUDE_MEM_GEMINI_MODEL: data.MAGIC_CLAUDE_MEM_GEMINI_MODEL || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_GEMINI_MODEL,
          MAGIC_CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED: data.MAGIC_CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED,
          MAGIC_CLAUDE_MEM_OPENAI_COMPAT_API_KEY: data.MAGIC_CLAUDE_MEM_OPENAI_COMPAT_API_KEY || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_OPENAI_COMPAT_API_KEY,
          MAGIC_CLAUDE_MEM_OPENAI_COMPAT_MODEL: data.MAGIC_CLAUDE_MEM_OPENAI_COMPAT_MODEL || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_OPENAI_COMPAT_MODEL,
          MAGIC_CLAUDE_MEM_OPENAI_COMPAT_SITE_URL: data.MAGIC_CLAUDE_MEM_OPENAI_COMPAT_SITE_URL || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_OPENAI_COMPAT_SITE_URL,
          MAGIC_CLAUDE_MEM_OPENAI_COMPAT_APP_NAME: data.MAGIC_CLAUDE_MEM_OPENAI_COMPAT_APP_NAME || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_OPENAI_COMPAT_APP_NAME,
          MAGIC_CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS: data.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS,
          MAGIC_CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS: data.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS,
          MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT: data.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT,
          MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT: data.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT,
          MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES: data.MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES,
          MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS: data.MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS,
          MAGIC_CLAUDE_MEM_CONTEXT_FULL_COUNT: data.MAGIC_CLAUDE_MEM_CONTEXT_FULL_COUNT || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_FULL_COUNT,
          MAGIC_CLAUDE_MEM_CONTEXT_FULL_FIELD: data.MAGIC_CLAUDE_MEM_CONTEXT_FULL_FIELD || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_FULL_FIELD,
          MAGIC_CLAUDE_MEM_CONTEXT_SESSION_COUNT: data.MAGIC_CLAUDE_MEM_CONTEXT_SESSION_COUNT || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_SESSION_COUNT,
          MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY: data.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY,
          MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: data.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE || DEFAULT_SETTINGS.MAGIC_CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && (error as DOMException).name === 'AbortError') return;
        logger.error('settings', 'Failed to load settings');
      });
    return () => { controller.abort(); };
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

      const result = await response.json() as SaveSettingsResponse;

      if (result.success) {
        setSettings(newSettings);
        setSaveStatus('✓ Saved');
        setTimeout(() => { setSaveStatus(''); }, TIMING.SAVE_STATUS_DISPLAY_DURATION_MS);
      } else {
        setSaveStatus('✗ Failed to save settings');
      }
    } catch (error) {
      logger.error('settings', 'Network error saving settings');
      setSaveStatus('✗ Unable to save. Check that the worker is running.');
    } finally {
      setIsSaving(false);
    }
  };

  return { settings, saveSettings, isSaving, saveStatus };
}
