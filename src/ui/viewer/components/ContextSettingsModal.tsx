import React, { useState, useCallback, useEffect } from 'react';
import type { Settings } from '../types';
import { TerminalPreview } from './TerminalPreview';
import { useContextPreview } from '../hooks/useContextPreview';
import { useI18n } from '../i18n/I18nContext';

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

export function ContextSettingsModal({
  isOpen,
  onClose,
  settings,
  onSave,
  isSaving,
  saveStatus
}: ContextSettingsModalProps) {
  const [formState, setFormState] = useState<Settings>(settings);
  const { t } = useI18n();

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
      <div className="context-settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h2>{t('settings.title')}</h2>
          <div className="header-controls">
            <label className="preview-selector">
              {t('settings.source')}
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
              {t('settings.project')}
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
              title={t('settings.closeEsc')}
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
                <div style={{ color: '#ff6b6b' }}>
                  {t('settings.errorLoadingPreview')}{error}
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
              title={t('settings.loading')}
              description={t('settings.loadingDesc')}
            >
              <FormField
                label={t('settings.observations')}
                tooltip={t('settings.observationsTip')}
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
                label={t('settings.sessions')}
                tooltip={t('settings.sessionsTip')}
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
              title={t('settings.display')}
              description={t('settings.displayDesc')}
            >
              <div className="display-subsection">
                <span className="subsection-label">{t('settings.fullObservations')}</span>
                <FormField
                  label={t('settings.count')}
                  tooltip={t('settings.countTip')}
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
                  label={t('settings.field')}
                  tooltip={t('settings.fieldTip')}
                >
                  <select
                    value={formState.CLAUDE_MEM_CONTEXT_FULL_FIELD || 'narrative'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_FIELD', e.target.value)}
                  >
                    <option value="narrative">{t('settings.narrative')}</option>
                    <option value="facts">{t('settings.facts')}</option>
                  </select>
                </FormField>
              </div>

              <div className="display-subsection">
                <span className="subsection-label">{t('settings.tokenEconomics')}</span>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="show-read-tokens"
                    label={t('settings.readCost')}
                    description={t('settings.readCostDesc')}
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-work-tokens"
                    label={t('settings.workInvestment')}
                    description={t('settings.workInvestmentDesc')}
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-savings-amount"
                    label={t('settings.savings')}
                    description={t('settings.savingsDesc')}
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT')}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Section 4: Advanced */}
            <CollapsibleSection
              title={t('settings.advanced')}
              description={t('settings.advancedDesc')}
              defaultOpen={false}
            >
              <FormField
                label="AI Provider"
                tooltip="Provider for generating observations: Claude (Agent SDK), Gemini (API key), Gemini CLI (your gemini login — no API key), or OpenRouter"
              >
                <select
                  value={formState.CLAUDE_MEM_PROVIDER || 'claude'}
                  onChange={(e) => updateSetting('CLAUDE_MEM_PROVIDER', e.target.value)}
                >
                  <option value="claude">Claude (uses your Claude account)</option>
                  <option value="gemini">Gemini (uses API key)</option>
                  <option value="gemini-cli">Gemini CLI (uses your gemini login — no API key)</option>
                  <option value="openrouter">OpenRouter (multi-model)</option>
                </select>
              </FormField>

              {formState.CLAUDE_MEM_PROVIDER === 'claude' && (
                <FormField
                  label={t('settings.claudeModel')}
                  tooltip={t('settings.claudeModelTip')}
                >
                  <select
                    value={formState.CLAUDE_MEM_MODEL || 'haiku'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_MODEL', e.target.value)}
                  >
                    <option value="haiku">{t('settings.modelHaiku')}</option>
                    <option value="sonnet">{t('settings.modelSonnet')}</option>
                    <option value="opus">{t('settings.modelOpus')}</option>
                  </select>
                </FormField>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'codex' && (
                <>
                  <FormField
                    label="Codex Model"
                    tooltip="Codex model passed to `codex exec --model`"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_CODEX_MODEL || 'gpt-5.3-codex-spark'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CODEX_MODEL', e.target.value)}
                      placeholder="gpt-5.3-codex-spark"
                    />
                  </FormField>
                  <FormField
                    label="Codex CLI Path"
                    tooltip="Codex executable path; leave as codex when it is on PATH"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_CODEX_PATH || 'codex'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CODEX_PATH', e.target.value)}
                      placeholder="codex"
                    />
                  </FormField>
                  <FormField
                    label="Codex Reasoning Effort"
                    tooltip="Optional Codex reasoning effort passed to codex exec"
                  >
                    <select
                      value={formState.CLAUDE_MEM_CODEX_REASONING_EFFORT || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CODEX_REASONING_EFFORT', e.target.value)}
                    >
                      <option value="">model default</option>
                      <option value="minimal">minimal</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                      <option value="xhigh">xhigh</option>
                    </select>
                  </FormField>
                  <FormField
                    label="Codex Context Messages"
                    tooltip="Maximum recent messages sent to codex exec"
                  >
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={formState.CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES || '20'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CODEX_MAX_CONTEXT_MESSAGES', e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label="Codex Max Tokens"
                    tooltip="Estimated prompt token cap before truncating Codex context"
                  >
                    <input
                      type="number"
                      min="1000"
                      max="1000000"
                      step="1000"
                      value={formState.CLAUDE_MEM_CODEX_MAX_TOKENS || '100000'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CODEX_MAX_TOKENS', e.target.value)}
                    />
                  </FormField>
                  <FormField
                    label="Codex Timeout"
                    tooltip="Per-attempt codex exec timeout in milliseconds"
                  >
                    <input
                      type="number"
                      min="10000"
                      max="600000"
                      step="10000"
                      value={formState.CLAUDE_MEM_CODEX_TIMEOUT_MS || '120000'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CODEX_TIMEOUT_MS', e.target.value)}
                    />
                  </FormField>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'gemini' && (
                <>
                  <FormField
                    label={t('settings.geminiApiKey')}
                    tooltip={t('settings.geminiApiKeyTip')}
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_GEMINI_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_API_KEY', e.target.value)}
                      placeholder={t('settings.geminiApiKeyPlaceholder')}
                    />
                  </FormField>
                  <FormField
                    label={t('settings.geminiModel')}
                    tooltip={t('settings.geminiModelTip')}
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
                      label={t('settings.rateLimiting')}
                      description={t('settings.rateLimitingDesc')}
                      checked={formState.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED === 'true'}
                      onChange={(checked) => updateSetting('CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED', checked ? 'true' : 'false')}
                    />
                  </div>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'openrouter' && (
                <>
                  <FormField
                    label={t('settings.openRouterApiKey')}
                    tooltip={t('settings.openRouterApiKeyTip')}
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_OPENROUTER_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_API_KEY', e.target.value)}
                      placeholder={t('settings.openRouterApiKeyPlaceholder')}
                    />
                  </FormField>
                  <FormField
                    label={t('settings.openRouterModel')}
                    tooltip={t('settings.openRouterModelTip')}
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_MODEL || 'xiaomi/mimo-v2-flash:free'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_MODEL', e.target.value)}
                      placeholder="e.g., xiaomi/mimo-v2-flash:free"
                    />
                  </FormField>
                  <FormField
                    label={t('settings.siteUrlOptional')}
                    tooltip={t('settings.siteUrlOptionalTip')}
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_SITE_URL || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_SITE_URL', e.target.value)}
                      placeholder="https://yoursite.com"
                    />
                  </FormField>
                  <FormField
                    label={t('settings.appNameOptional')}
                    tooltip={t('settings.appNameOptionalTip')}
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_OPENROUTER_APP_NAME || 'claude-mem'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_APP_NAME', e.target.value)}
                      placeholder="claude-mem"
                    />
                  </FormField>
                  <FormField
                    label="Reasoning Effort (Optional)"
                    tooltip="OpenRouter reasoning effort. Empty uses the provider or model default."
                  >
                    <select
                      value={formState.CLAUDE_MEM_OPENROUTER_REASONING_EFFORT || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_REASONING_EFFORT', e.target.value)}
                    >
                      <option value="">Default</option>
                      <option value="none">none</option>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                  </FormField>
                  <FormField
                    label="Extra Body JSON (Optional)"
                    tooltip="Additional OpenAI-compatible request body fields. Core fields like model, messages, max_tokens, usage, and reasoning are blocked."
                  >
                    <textarea
                      value={formState.CLAUDE_MEM_OPENROUTER_EXTRA_BODY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_EXTRA_BODY', e.target.value)}
                      placeholder='{"thinking":{"type":"disabled"}}'
                      rows={3}
                    />
                  </FormField>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'kiro' && (
                <>
                  <FormField
                    label="Kiro Model"
                    tooltip="No API key needed — auth is your kiro-cli login session. Model ids use dot notation (claude-haiku-4.5, claude-sonnet-4, auto). The model is pinned into the claude-mem-observer agent, so changes take effect after re-running: npx claude-mem install --ide kiro-cli"
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_KIRO_MODEL || 'claude-haiku-4.5'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_KIRO_MODEL', e.target.value)}
                      placeholder="claude-haiku-4.5"
                    />
                  </FormField>
                  <FormField
                    label="Kiro CLI Path (Optional)"
                    tooltip="Absolute path to kiro-cli. Only needed when it is not on PATH or in a standard install location."
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_KIRO_CLI_PATH || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_KIRO_CLI_PATH', e.target.value)}
                      placeholder="/opt/homebrew/bin/kiro-cli"
                    />
                  </FormField>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'deepseek' && (
                <>
                  <FormField
                    label={t('settings.deepseekApiKey')}
                    tooltip={t('settings.deepseekApiKeyTip')}
                  >
                    <input
                      type="password"
                      value={formState.CLAUDE_MEM_DEEPSEEK_API_KEY || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_DEEPSEEK_API_KEY', e.target.value)}
                      placeholder={t('settings.deepseekApiKeyPlaceholder')}
                    />
                  </FormField>
                  <FormField
                    label={t('settings.deepseekModel')}
                    tooltip={t('settings.deepseekModelTip')}
                  >
                    <select
                      value={formState.CLAUDE_MEM_DEEPSEEK_MODEL || 'deepseek-v4-flash'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_DEEPSEEK_MODEL', e.target.value)}
                    >
                      <option value="deepseek-v4-flash">{t('settings.deepseekFlash')}</option>
                      <option value="deepseek-v4-pro">{t('settings.deepseekPro')}</option>
                    </select>
                  </FormField>
                  <div style={{ padding: '8px 12px', marginTop: '8px', background: 'var(--color-bg-secondary)', borderRadius: '6px', fontSize: '12px', color: 'var(--color-text-secondary)' }}>
                    {t('settings.deepseekNote')}
                  </div>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'gemini-cli' && (
                <>
                  <FormField
                    label="Gemini CLI Model"
                    tooltip="Model passed to the `gemini` CLI. Uses your gemini login (OAuth) — no API key required."
                  >
                    <select
                      value={formState.CLAUDE_MEM_GEMINI_CLI_MODEL || 'auto'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_CLI_MODEL', e.target.value)}
                    >
                      <option value="auto">auto (auto-select model)</option>
                      <option value="gemini-2.5-flash-lite">gemini-2.5-flash-lite (fastest)</option>
                      <option value="gemini-2.5-flash">gemini-2.5-flash (balanced)</option>
                      <option value="gemini-3-flash-preview">gemini-3-flash-preview (preview)</option>
                    </select>
                  </FormField>
                  <FormField
                    label="Gemini CLI Path (Optional)"
                    tooltip="Explicit path to the gemini binary. Leave empty to auto-detect on PATH (which gemini)."
                  >
                    <input
                      type="text"
                      value={formState.CLAUDE_MEM_GEMINI_CLI_PATH || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_CLI_PATH', e.target.value)}
                      placeholder="auto-detect (which gemini)"
                    />
                  </FormField>
                  <FormField
                    label="Request Timeout (ms)"
                    tooltip="Per-turn timeout for gemini CLI subprocesses, in milliseconds."
                  >
                    <input
                      type="number"
                      min="1000"
                      value={formState.CLAUDE_MEM_GEMINI_CLI_TIMEOUT_MS || '120000'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_CLI_TIMEOUT_MS', e.target.value)}
                    />
                  </FormField>
                </>
              )}

              <FormField
                label={t('settings.workerPort')}
                tooltip={t('settings.workerPortTip')}
              >
                <input
                  type="number"
                  min="1024"
                  max="65535"
                  value={formState.CLAUDE_MEM_WORKER_PORT || DEFAULT_SETTINGS.CLAUDE_MEM_WORKER_PORT}
                  onChange={(e) => updateSetting('CLAUDE_MEM_WORKER_PORT', e.target.value)}
                />
              </FormField>

              <div className="toggle-group" style={{ marginTop: '12px' }}>
                <ToggleSwitch
                  id="skip-subagent-observations"
                  label="Skip subagent observations"
                  description="Ignore observations produced by subagents"
                  checked={formState.CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_SKIP_SUBAGENT_OBSERVATIONS')}
                />
              </div>

              <FormField
                label="Skipped agent types"
                tooltip="Comma-separated agent_type values to skip, for example workflow-subagent"
              >
                <input
                  type="text"
                  value={formState.CLAUDE_MEM_SKIP_AGENT_TYPES || ''}
                  onChange={(e) => updateSetting('CLAUDE_MEM_SKIP_AGENT_TYPES', e.target.value)}
                  placeholder="workflow-subagent"
                />
              </FormField>

              <div className="toggle-group" style={{ marginTop: '12px' }}>
                <ToggleSwitch
                  id="show-last-summary"
                  label={t('settings.includeLastSummary')}
                  description={t('settings.includeLastSummaryDesc')}
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY')}
                />
                <ToggleSwitch
                  id="show-last-message"
                  label={t('settings.includeLastMessage')}
                  description={t('settings.includeLastMessageDesc')}
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
            {isSaving ? t('settings.saving') : t('settings.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
