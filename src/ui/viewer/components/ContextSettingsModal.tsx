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
          <div>
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Context Injection Settings</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '8px' }}>
              <label style={{ fontSize: '13px', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                Preview for:
                <select
                  value={selectedProject || ''}
                  onChange={(e) => setSelectedProject(e.target.value)}
                  style={{
                    padding: '4px 8px',
                    fontSize: '13px',
                    border: '1px solid var(--color-border-primary)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--color-bg-input)',
                    color: 'var(--color-text-primary)',
                    cursor: 'pointer'
                  }}
                >
                  {projects.map(project => (
                    <option key={project} value={project}>{project}</option>
                  ))}
                </select>
              </label>
              {isSaving && <span style={{ fontSize: '13px', color: 'var(--color-text-tertiary)' }}>Saving...</span>}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '4px',
              color: 'var(--color-text-secondary)'
            }}
            title="Close"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body - 2 columns */}
        <div className="modal-body">
          {/* Left column - Terminal Preview */}
          <div className="preview-column">
            <h3 style={{ margin: '0 0 16px 0', fontSize: '14px', fontWeight: 600 }}>Live Preview</h3>
            {error ? (
              <div style={{ padding: '20px', color: 'var(--color-text-error)' }}>
                Error loading preview: {error}
              </div>
            ) : (
              <TerminalPreview content={preview} isLoading={isLoading} />
            )}
          </div>

          {/* Right column - Settings Panel */}
          <div className="settings-column">
            {/* Group 1: Token Economics Display */}
            <div className="settings-group">
              <h4>Token Economics Display</h4>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS')}
                />
                <span style={{ fontSize: '13px' }}>Show read tokens</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS')}
                />
                <span style={{ fontSize: '13px' }}>Show work tokens</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT')}
                />
                <span style={{ fontSize: '13px' }}>Show savings amount</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_PERCENT')}
                />
                <span style={{ fontSize: '13px' }}>Show savings percent</span>
              </label>
            </div>

            {/* Group 2: Observation Types */}
            <div className="settings-group">
              <h4>Observation Types</h4>
              <div className="chip-container">
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
              <div className="chip-container">
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
              <label style={{ display: 'block', marginBottom: '12px' }}>
                <span style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Full observations count (0-20)</span>
                <input
                  type="number"
                  min="0"
                  max="20"
                  value={formState.CLAUDE_MEM_CONTEXT_FULL_COUNT || '5'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_COUNT', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: '13px',
                    border: '1px solid var(--color-border-primary)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--color-bg-input)',
                    color: 'var(--color-text-primary)'
                  }}
                />
              </label>
              <label style={{ display: 'block', marginBottom: '12px' }}>
                <span style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Full observation field</span>
                <select
                  value={formState.CLAUDE_MEM_CONTEXT_FULL_FIELD || 'narrative'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_FIELD', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: '13px',
                    border: '1px solid var(--color-border-primary)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--color-bg-input)',
                    color: 'var(--color-text-primary)'
                  }}
                >
                  <option value="narrative">Narrative</option>
                  <option value="facts">Facts</option>
                </select>
              </label>
              <label style={{ display: 'block', marginBottom: '12px' }}>
                <span style={{ display: 'block', fontSize: '13px', marginBottom: '4px' }}>Session count (1-50)</span>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={formState.CLAUDE_MEM_CONTEXT_SESSION_COUNT || '10'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_SESSION_COUNT', e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: '13px',
                    border: '1px solid var(--color-border-primary)',
                    borderRadius: '4px',
                    backgroundColor: 'var(--color-bg-input)',
                    color: 'var(--color-text-primary)'
                  }}
                />
              </label>
            </div>

            {/* Group 5: Feature Toggles */}
            <div className="settings-group">
              <h4>Feature Toggles</h4>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY')}
                />
                <span style={{ fontSize: '13px' }}>Show last summary</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE')}
                />
                <span style={{ fontSize: '13px' }}>Show last message</span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
