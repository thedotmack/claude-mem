import React, { useState, useCallback, useEffect } from 'react';
import type { Settings } from '../types';
import { TerminalPreview } from './TerminalPreview';
import { useContextPreview } from '../hooks/useContextPreview';

interface ContextSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  onSave: (settings: Settings) => void;
  isSaving: boolean;
  saveStatus: string;
}

// Simple debounce helper
function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let timeoutId: NodeJS.Timeout;
  return ((...args: any[]) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), ms);
  }) as T;
}

export function ContextSettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
  isSaving,
  saveStatus
}: ContextSettingsModalProps) {
  const [formState, setFormState] = useState<Settings>(settings);

  // Create debounced save function
  const debouncedSave = useCallback(
    debounce((newSettings: Settings) => {
      onSave(newSettings);
    }, 300),
    [onSave]
  );

  // Update form state when settings prop changes
  useEffect(() => {
    setFormState(settings);
  }, [settings]);

  // Get context preview based on current form state
  const { preview, isLoading, error, projects, selectedProject, setSelectedProject } = useContextPreview(formState);

  const updateSetting = useCallback((key: keyof Settings, value: string) => {
    const newState = { ...formState, [key]: value };
    setFormState(newState);
    debouncedSave(newState);
  }, [formState, debouncedSave]);

  const toggleBoolean = useCallback((key: keyof Settings) => {
    const currentValue = formState[key];
    const newValue = currentValue === 'true' ? 'false' : 'true';
    updateSetting(key, newValue);
  }, [formState, updateSetting]);

  const toggleArrayValue = useCallback((key: keyof Settings, value: string) => {
    const currentValue = formState[key] || '';
    const currentArray = currentValue ? currentValue.split(',') : [];
    const newArray = currentArray.includes(value)
      ? currentArray.filter(v => v !== value)
      : [...currentArray, value];
    updateSetting(key, newArray.join(','));
  }, [formState, updateSetting]);

  const isInArray = useCallback((key: keyof Settings, value: string): boolean => {
    const currentValue = formState[key] || '';
    const currentArray = currentValue ? currentValue.split(',') : [];
    return currentArray.includes(value);
  }, [formState]);

  // Handle ESC key
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      window.addEventListener('keydown', handleEsc);
      return () => window.removeEventListener('keydown', handleEsc);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const observationTypes = ['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change'];
  const observationConcepts = ['how-it-works', 'why-it-exists', 'what-changed', 'problem-solution', 'gotcha', 'pattern', 'trade-off'];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="context-settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>Context Injection Settings</h2>
          <button
            onClick={onClose}
            className="modal-close-btn"
            title="Close"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body - 2 columns */}
        <div className="modal-body">
          {/* Left column - Terminal Preview */}
          <div className="preview-column">
            <div className="preview-column-header">
              <label>
                Preview for:
                <select
                  value={selectedProject || ''}
                  onChange={(e) => setSelectedProject(e.target.value)}
                >
                  {projects.map(project => (
                    <option key={project} value={project}>{project}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="preview-content">
              {error ? (
                <div style={{ color: '#ff6b6b' }}>
                  Error loading preview: {error}
                </div>
              ) : (
                <TerminalPreview content={preview} isLoading={isLoading} />
              )}
            </div>
          </div>

          {/* Right column - Settings Panel */}
          <div className="settings-column">
            {/* Group 1: Token Economics Display */}
            <div className="settings-group">
              <h4>Token Economics Display</h4>
              <div className="checkbox-group">
                <div className="checkbox-item">
                  <input
                    type="checkbox"
                    id="show-read-tokens"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS')}
                  />
                  <label htmlFor="show-read-tokens">Show read tokens</label>
                </div>
                <div className="checkbox-item">
                  <input
                    type="checkbox"
                    id="show-work-tokens"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS')}
                  />
                  <label htmlFor="show-work-tokens">Show work tokens</label>
                </div>
                <div className="checkbox-item">
                  <input
                    type="checkbox"
                    id="show-savings-amount"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT')}
                  />
                  <label htmlFor="show-savings-amount">Show savings amount</label>
                </div>
                <div className="checkbox-item">
                  <input
                    type="checkbox"
                    id="show-savings-percent"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT')}
                  />
                  <label htmlFor="show-savings-percent">Show savings percent</label>
                </div>
              </div>
            </div>

            {/* Group 2: Observation Types */}
            <div className="settings-group">
              <h4>Observation Types</h4>
              <div className="chips-container">
                {observationTypes.map(type => (
                  <button
                    key={type}
                    className={`chip ${isInArray('CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES', type) ? 'selected' : ''}`}
                    onClick={() => toggleArrayValue('CLAUDE_MEM_CONTEXT_OBSERVATION_TYPES', type)}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>

            {/* Group 3: Observation Concepts */}
            <div className="settings-group">
              <h4>Observation Concepts</h4>
              <div className="chips-container">
                {observationConcepts.map(concept => (
                  <button
                    key={concept}
                    className={`chip ${isInArray('CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS', concept) ? 'selected' : ''}`}
                    onClick={() => toggleArrayValue('CLAUDE_MEM_CONTEXT_OBSERVATION_CONCEPTS', concept)}
                  >
                    {concept}
                  </button>
                ))}
              </div>
            </div>

            {/* Group 4: Display Configuration */}
            <div className="settings-group">
              <h4>Display Configuration</h4>
              <div className="number-input-group">
                <label htmlFor="full-count">Full observations count (0-20)</label>
                <input
                  type="number"
                  id="full-count"
                  min="0"
                  max="20"
                  value={formState.CLAUDE_MEM_CONTEXT_FULL_COUNT || '5'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_COUNT', e.target.value)}
                />
              </div>
              <div className="select-group">
                <label htmlFor="full-field">Full observation field</label>
                <select
                  id="full-field"
                  value={formState.CLAUDE_MEM_CONTEXT_FULL_FIELD || 'narrative'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_FIELD', e.target.value)}
                >
                  <option value="narrative">Narrative</option>
                  <option value="facts">Facts</option>
                </select>
              </div>
              <div className="number-input-group">
                <label htmlFor="session-count">Session count (1-50)</label>
                <input
                  type="number"
                  id="session-count"
                  min="1"
                  max="50"
                  value={formState.CLAUDE_MEM_CONTEXT_SESSION_COUNT || '10'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_SESSION_COUNT', e.target.value)}
                />
              </div>
            </div>

            {/* Group 5: Feature Toggles */}
            <div className="settings-group">
              <h4>Feature Toggles</h4>
              <div className="checkbox-group">
                <div className="checkbox-item">
                  <input
                    type="checkbox"
                    id="show-last-summary"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY')}
                  />
                  <label htmlFor="show-last-summary">Show last summary</label>
                </div>
                <div className="checkbox-item">
                  <input
                    type="checkbox"
                    id="show-last-message"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE')}
                  />
                  <label htmlFor="show-last-message">Show last message</label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
