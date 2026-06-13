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

function CollapsibleSection({
  title,
  description,
  children,
  defaultOpen = true
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`settings-section-collapsible ${isOpen ? 'open' : ''}`}>
      <button
        className="section-header-btn"
        onClick={() => setIsOpen(!isOpen)}
        type="button"
      >
        <div className="section-header-content">
          <span className="section-title">{title}</span>
          {description && <span className="section-description">{description}</span>}
        </div>
        <svg
          className={`chevron-icon ${isOpen ? 'rotated' : ''}`}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {isOpen && <div className="section-content">{children}</div>}
    </div>
  );
}

function FormField({
  label,
  tooltip,
  children
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-field">
      <label className="form-field-label">
        {label}
        {tooltip && (
          <span className="tooltip-trigger" title={tooltip}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

function ToggleSwitch({
  id,
  label,
  description,
  checked,
  onChange,
  disabled
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="toggle-row">
      <div className="toggle-info">
        <label htmlFor={id} className="toggle-label">{label}</label>
        {description && <span className="toggle-description">{description}</span>}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        className={`toggle-switch ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && onChange(!checked)}
        disabled={disabled}
      >
        <span className="toggle-knob" />
      </button>
    </div>
  );
}

const SETTINGS_STYLES = `
.modal-backdrop {
  position: fixed; inset: 0; z-index: 200;
  display: flex; align-items: center; justify-content: center;
  padding: var(--space-5);
  background: rgba(42,28,21,0.32);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  animation: cmFade var(--dur, 240ms) var(--ease-out, ease);
}
@keyframes cmFade { from { opacity: 0; } to { opacity: 1; } }
.context-settings-modal {
  display: flex; flex-direction: column;
  width: min(960px, 100%); max-height: calc(100vh - 48px);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-xl);
  box-shadow: var(--shadow-lg);
  font-family: var(--font-sans); color: var(--fg);
  overflow: hidden;
  animation: cmPop var(--dur, 240ms) var(--ease-bounce, ease);
}
@keyframes cmPop { from { opacity: 0; transform: translateY(10px) scale(0.985); } to { opacity: 1; transform: none; } }

.modal-header {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border-soft);
}
.modal-header h2 { font-family: var(--font-display); font-weight: 600; font-size: 1.375rem; color: var(--fg); }
.header-controls { display: flex; align-items: center; gap: var(--space-3); }
.preview-selector {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 0.8125rem; font-weight: 600; color: var(--fg-3);
}
.preview-selector select {
  appearance: none; -webkit-appearance: none;
  background: var(--surface); color: var(--fg);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 5px 10px; font-family: var(--font-sans); font-weight: 500; font-size: 0.8125rem;
  cursor: pointer;
}
.preview-selector select:disabled { opacity: 0.5; cursor: default; }
.modal-close-btn {
  display: grid; place-items: center; width: 34px; height: 34px;
  border-radius: var(--r-pill); border: 1px solid var(--border-soft);
  background: var(--surface-sunken); color: var(--fg-3);
  transition: color var(--dur-fast, 140ms) var(--ease-out, ease), background var(--dur-fast, 140ms) var(--ease-out, ease);
}
.modal-close-btn:hover { color: var(--fg); background: var(--surface-tint); }

.modal-body {
  flex: 1; min-height: 0;
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  overflow: hidden;
}
.preview-column {
  display: flex; flex-direction: column; min-width: 0;
  background: var(--surface-sunken);
  border-right: 1px solid var(--border-soft);
  overflow: auto;
}
.preview-content { flex: 1; padding: var(--space-4); min-height: 0; }
.settings-column {
  display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-5);
  overflow: auto;
  scrollbar-width: thin; scrollbar-color: var(--border) transparent;
}

.settings-section-collapsible {
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  background: var(--surface);
  overflow: hidden;
}
.settings-section-collapsible.open { border-color: var(--border); }
.section-header-btn {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
  width: 100%; padding: var(--space-3) var(--space-4); text-align: left;
}
.section-header-content { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.section-title { font-family: var(--font-display); font-weight: 600; font-size: 1rem; color: var(--fg); }
.section-description { font-size: 0.8125rem; font-weight: 500; color: var(--fg-3); }
.chevron-icon { color: var(--fg-3); flex: 0 0 auto; transition: transform var(--dur-fast, 140ms) var(--ease-out, ease); }
.chevron-icon.rotated { transform: rotate(180deg); }
.section-content {
  display: flex; flex-direction: column; gap: var(--space-4);
  padding: var(--space-2) var(--space-4) var(--space-4);
  border-top: 1px solid var(--border-soft);
}

.form-field { display: flex; flex-direction: column; gap: 6px; }
.form-field-label {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 0.8125rem; font-weight: 700; color: var(--fg-2);
}
.tooltip-trigger { display: inline-grid; place-items: center; color: var(--fg-3); cursor: help; }
.form-field input,
.form-field select {
  appearance: none; -webkit-appearance: none;
  width: 100%;
  background: var(--surface); color: var(--fg);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  padding: 9px 12px;
  font-family: var(--font-sans); font-weight: 500; font-size: 0.9375rem;
  transition: border-color var(--dur-fast, 140ms) var(--ease-out, ease), box-shadow var(--dur-fast, 140ms) var(--ease-out, ease);
}
.form-field input:focus,
.form-field select:focus {
  outline: none;
  border-color: var(--coral-400);
  box-shadow: 0 0 0 3px var(--ring);
}
.form-field input::placeholder { color: var(--fg-3); }

.display-subsection { display: flex; flex-direction: column; gap: var(--space-3); }
.subsection-label {
  font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--fg-3);
}
.toggle-group { display: flex; flex-direction: column; gap: var(--space-2); }
.toggle-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.toggle-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.toggle-label { font-size: 0.875rem; font-weight: 600; color: var(--fg); }
.toggle-description { font-size: 0.78rem; font-weight: 500; color: var(--fg-3); line-height: 1.4; }
.toggle-switch {
  position: relative; flex: 0 0 auto;
  width: 40px; height: 24px; border-radius: var(--r-pill);
  background: var(--surface-sunken); border: 1px solid var(--border);
  transition: background var(--dur-fast, 140ms) var(--ease-out, ease), border-color var(--dur-fast, 140ms) var(--ease-out, ease);
}
.toggle-switch .toggle-knob {
  position: absolute; top: 2px; left: 2px;
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--surface); box-shadow: var(--shadow-xs);
  transition: transform var(--dur-fast, 140ms) var(--ease-bounce, ease);
}
.toggle-switch.on { background: var(--coral-500); border-color: var(--coral-500); }
.toggle-switch.on .toggle-knob { transform: translateX(16px); background: var(--cream-50); }
.toggle-switch.disabled { opacity: 0.5; cursor: default; }

.modal-footer {
  display: flex; align-items: center; justify-content: flex-end; gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  border-top: 1px solid var(--border-soft);
  background: var(--surface);
}
.save-status { margin-right: auto; font-size: 0.8125rem; font-weight: 600; color: var(--fg-3); }
.save-status .success { color: var(--success); }
.save-status .error { color: var(--danger); }
.save-btn {
  display: inline-flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 var(--space-6);
  border-radius: var(--r-pill); background: var(--coral-500); color: var(--fg-on-coral);
  font-family: var(--font-sans); font-weight: 700; font-size: 0.9375rem;
  box-shadow: var(--shadow-coral);
  transition: background var(--dur-fast, 140ms) var(--ease-out, ease);
}
.save-btn:hover { background: var(--coral-600); }
.save-btn:disabled { opacity: 0.6; cursor: default; box-shadow: none; }

@media (max-width: 720px) {
  .modal-body { grid-template-columns: 1fr; }
  .preview-column { border-right: none; border-bottom: 1px solid var(--border-soft); max-height: 240px; }
}
`;

export function ContextSettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
  isSaving,
  saveStatus
}: ContextSettingsModalProps) {
  const [formState, setFormState] = useState<Settings>(settings);

  useEffect(() => {
    setFormState(settings);
  }, [settings]);

  const {
    preview,
    isLoading,
    error,
    projects,
    sources,
    selectedSource,
    setSelectedSource,
    selectedProject,
    setSelectedProject
  } = useContextPreview(formState);

  const updateSetting = useCallback((key: keyof Settings, value: string) => {
    const newState = { ...formState, [key]: value };
    setFormState(newState);
  }, [formState]);

  const handleSave = useCallback(() => {
    onSave(formState);
  }, [formState, onSave]);

  const toggleBoolean = useCallback((key: keyof Settings) => {
    const currentValue = formState[key];
    const newValue = currentValue === 'true' ? 'false' : 'true';
    updateSetting(key, newValue);
  }, [formState, updateSetting]);

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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <style>{SETTINGS_STYLES}</style>
      <div className="context-settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>Settings</h2>
          <div className="header-controls">
            <label className="preview-selector">
              Source:
              <select
                value={selectedSource || ''}
                onChange={(e) => setSelectedSource(e.target.value)}
                disabled={sources.length === 0}
              >
                {sources.map(source => (
                  <option key={source} value={source}>{source}</option>
                ))}
              </select>
            </label>
            <label className="preview-selector">
              Project:
              <select
                value={selectedProject || ''}
                onChange={(e) => setSelectedProject(e.target.value)}
                disabled={projects.length === 0}
              >
                {projects.map(project => (
                  <option key={project} value={project}>{project}</option>
                ))}
              </select>
            </label>
            <button
              onClick={onClose}
              className="modal-close-btn"
              title="Close (Esc)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body - 2 columns */}
        <div className="modal-body">
          {/* Left column - Terminal Preview */}
          <div className="preview-column">
            <div className="preview-content">
              {error ? (
                <div style={{ color: 'var(--danger)' }}>
                  Error loading preview: {error}
                </div>
              ) : (
                <TerminalPreview content={preview} isLoading={isLoading} />
              )}
            </div>
          </div>

          {/* Right column - Settings Panel */}
          <div className="settings-column">
            {/* Section 1: Loading */}
            <CollapsibleSection
              title="Loading"
              description="How many observations to inject"
            >
              <FormField
                label="Observations"
                tooltip="Number of recent observations to include in context (1-200)"
              >
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={formState.CLAUDE_MEM_CONTEXT_OBSERVATIONS || '50'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_OBSERVATIONS', e.target.value)}
                />
              </FormField>
              <FormField
                label="Sessions"
                tooltip="Number of recent sessions to pull observations from (1-50)"
              >
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={formState.CLAUDE_MEM_CONTEXT_SESSION_COUNT || '10'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_SESSION_COUNT', e.target.value)}
                />
              </FormField>
            </CollapsibleSection>

            {/* Section 2: Display */}
            <CollapsibleSection
              title="Display"
              description="What to show in context tables"
            >
              <div className="display-subsection">
                <span className="subsection-label">Full Observations</span>
                <FormField
                  label="Count"
                  tooltip="How many observations show expanded details (0-20)"
                >
                  <input
                    type="number"
                    min="0"
                    max="20"
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_COUNT || '5'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_COUNT', e.target.value)}
                  />
                </FormField>
                <FormField
                  label="Field"
                  tooltip="Which field to expand for full observations"
                >
                  <select
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_FIELD || 'narrative'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_FIELD', e.target.value)}
                  >
                    <option value="narrative">Narrative</option>
                    <option value="facts">Facts</option>
                  </select>
                </FormField>
              </div>

              <div className="display-subsection">
                <span className="subsection-label">Token Economics</span>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="show-read-tokens"
                    label="Read cost"
                    description="Tokens to read this observation"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-work-tokens"
                    label="Work investment"
                    description="Tokens spent creating this observation"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-savings-amount"
                    label="Savings"
                    description="Total tokens saved by reusing context"
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT')}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Section 4: Advanced */}
            <CollapsibleSection
              title="Advanced"
              description="AI provider and model selection"
              defaultOpen={false}
            >
              <FormField
                label="AI Provider"
                tooltip="Choose between Claude (via Agent SDK) or Gemini (via REST API)"
              >
                <select
                  value={formState.CLAUDE_MEM_PROVIDER || 'claude'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_PROVIDER', e.target.value)}
                >
                  <option value="claude">Claude (uses your Claude account)</option>
                  <option value="gemini">Gemini (uses API key)</option>
                  <option value="openrouter">OpenRouter (multi-model)</option>
                </select>
              </FormField>

              {formState.CLAUDE_MEM_PROVIDER === 'claude' && (
                <FormField
                  label="Claude Model"
                  tooltip="Claude model used for generating observations"
                >
                  <select
                    value={formState.CLAUDE_MEM_MODEL || 'haiku'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_MODEL', e.target.value)}
                  >
                    <option value="haiku">haiku (fastest)</option>
                    <option value="sonnet">sonnet (balanced)</option>
                    <option value="opus">opus (highest quality)</option>
                  </select>
                </FormField>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'gemini' && (
                <>
                  <FormField
                    label="Gemini API Key"
                    tooltip="Your Google AI Studio API key (or set GEMINI_API_KEY env var)"
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_GEMINI_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_API_KEY', e.target.value)}
                      placeholder="Enter Gemini API key..."
                    />
                  </FormField>
                  <FormField
                    label="Gemini Model"
                    tooltip="Gemini model used for generating observations"
                  >
                    <select
                      value={formState.CLAUDE_MEM_GEMINI_MODEL || 'gemini-2.5-flash-lite'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_MODEL', e.target.value)}
                    >
                      <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (10 RPM free)</option>
                      <option value="gemini-2.5-flash">gemini-2.5-flash (5 RPM free)</option>
                      <option value="gemini-3-flash-preview">gemini-3-flash-preview (5 RPM free)</option>
                    </select>
                  </FormField>
                  <div className="toggle-group" style={{ marginTop: '8px' }}>
                    <ToggleSwitch
                      id="gemini-rate-limiting"
                      label="Rate Limiting"
                      description="Enable for free tier (10-30 RPM). Disable if you have billing set up (1000+ RPM)."
                      checked={formState.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED === 'true'}
                      onChange={(checked) => updateSetting('CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED', checked ? 'true' : 'false')}
                    />
                  </div>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'openrouter' && (
                <>
                  <FormField
                    label="OpenRouter API Key"
                    tooltip="Your OpenRouter API key from openrouter.ai (or set OPENROUTER_API_KEY env var)"
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_OPENROUTER_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_API_KEY', e.target.value)}
                      placeholder="Enter OpenRouter API key..."
                    />
                  </FormField>
                  <FormField
                    label="OpenRouter Model"
                    tooltip="Model identifier from OpenRouter (e.g., anthropic/claude-3.5-sonnet, google/gemini-2.0-flash-thinking-exp)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_MODEL', e.target.value)}
                      placeholder="e.g., xiaomi/mimo-v2-flash:free"
                    />
                  </FormField>
                  <FormField
                    label="Site URL (Optional)"
                    tooltip="Your site URL for OpenRouter analytics (optional)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_SITE_URL || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_SITE_URL', e.target.value)}
                      placeholder="https://yoursite.com"
                    />
                  </FormField>
                  <FormField
                    label="App Name (Optional)"
                    tooltip="Your app name for OpenRouter analytics (optional)"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_APP_NAME', e.target.value)}
                      placeholder="claude-mem"
                    />
                  </FormField>
                </>
              )}

              <FormField
                label="Worker Port"
                tooltip="Port for the background worker service"
              >
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={formState.CLAUDE_MEM_WORKER_PORT || '37777'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_WORKER_PORT', e.target.value)}
                />
              </FormField>

              <div className="toggle-group" style={{ marginTop: '12px' }}>
                <ToggleSwitch
                  id="show-last-summary"
                  label="Include last summary"
                  description="Add previous session's summary to context"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY')}
                />
                <ToggleSwitch
                  id="show-last-message"
                  label="Include last message"
                  description="Add previous session's final message"
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE')}
                />
              </div>
            </CollapsibleSection>
          </div>
        </div>

        {/* Footer with Save button */}
        <div className="modal-footer">
          <div className="save-status">
            {saveStatus && <span className={saveStatus.includes('✓') ? 'success' : saveStatus.includes('✗') ? 'error' : ''}>{saveStatus}</span>}
          </div>
          <button
            className="save-btn"
            onClick={handleSave}
            disabled={isSaving}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
