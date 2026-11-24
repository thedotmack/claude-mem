import { OPENAI_COMPAT_REASONING_EFFORTS, QUOTA_FALLBACK_OPTIONS, type QuotaFallbackOption } from '../../provider-options.js';
import React, { useState, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useI18n, interpolate, getLocale } from '../../i18n';
import { translateSettingsStatus } from '../../i18n/errors';
import { useDialogFocus } from '../hooks/useDialogFocus';
import { useRowOverflow } from '../hooks/useRowOverflow';
import type { SaveOutcome, SaveStatus } from '../hooks/useSettings';
import type { Settings } from '../types';
import { TerminalPreview } from './TerminalPreview';
import { InlineConfirm } from './InlineConfirm';
import { CheckCircleIcon, EyeIcon, EyeOffIcon, LockIcon, WarningIcon, XIcon } from './icons';
import { useContextPreview } from '../hooks/useContextPreview';
import { useBackupStatus } from '../hooks/useBackupStatus';
import { DEFAULT_SETTINGS } from '../constants/settings';
import { isClaudeMemObserverBaseUrl } from '../utils/observer-endpoint';
import { claudeProviderOptionLabel } from '../utils/claude-auth-method';
import { OPENAI_COMPAT_PRESET_OPTIONS, openAICompatPresetOption } from '../constants/openai-compat-presets';
import { formatCount, formatShortTime } from '../utils/formatters';
import {
  SETTINGS_SECTIONS, SETTING_RANGES, changedSettingKeys, outOfRange, settingsFooterState,
  type RangedSetting, type SettingsFooterState, type SettingsSection,
} from '../utils/settings-form';
import { previewFacts } from '../utils/settings-preview';

interface ContextSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: Settings;
  /** False until GET /api/settings succeeds; `settings` holds defaults until then. */
  isLoaded: boolean;
  /** Why the initial GET failed, as the network or the worker said it ("HTTP 500"), or null. */
  loadError: string | null;
  onRetryLoad: () => void;
  onSave: (settings: Settings) => void;
  isSaving: boolean;
  /** How the last save ended (useSettings is its one writer). */
  saveStatus: SaveStatus;
  /** Opens the timeline on a project: where a shortened preview's left-out observations can all be read. */
  onShowInTimeline?: (project: string) => void;
}

type Translate = (english: string) => string;

/** Each section's name in the list and its heading and line in the panel. Literal t() keys, so tests/ui-i18n.test.ts sees them. */
const SECTION_WORDS: Record<SettingsSection, { title: (t: Translate) => string; description: (t: Translate) => string }> = {
  loading: { title: t => t('Loading'), description: t => t('How many observations to inject') },
  display: { title: t => t('Display'), description: t => t('What to show in context tables') },
  context: { title: t => t('Context'), description: t => t('What else a session gets from memory') },
  images: { title: t => t('Images'), description: t => t("Screenshots and images from your agent's tools") },
  backups: { title: t => t('Backups'), description: t => t('Automatic snapshots of your memory database') },
  provider: { title: t => t('AI provider'), description: t => t('AI provider and model selection') },
  fallbacks: { title: t => t('Fallbacks'), description: t => t('What takes over while the provider or its credential cannot serve') },
  advanced: { title: t => t('Advanced'), description: t => t('My Work summaries, the Claude Code path and the worker port') },
};

interface FooterDetail { changed: number; savedAt: number | null }

/**
 * What the footer says in each state (settingsFooterState in utils/settings-form.ts is the one writer). A failed load
 * says so in plain words; its raw cause is folded under Details (G17).
 */
const FOOTER_WORDS: Record<SettingsFooterState, (t: Translate, detail: FooterDetail) => string> = {
  loading: t => t('Loading settings…'),
  'load-failed': t => t('Could not load settings.'),
  clean: t => t('No changes to save.'),
  dirty: (t, detail) => interpolate(detail.changed === 1 ? t('{count} unsaved change') : t('{count} unsaved changes'), { count: formatCount(detail.changed) }),
  saving: t => t('Saving...'),
  saved: (t, detail) => interpolate(t('Saved at {time}'), { time: detail.savedAt === null ? '' : formatShortTime(detail.savedAt) }),
};

/**
 * The line a save's outcome adds to the footer. A save that went through says so in the footer's own "saved" state
 * ("Saved at …"); a refused one says it here, its reason folded under Details.
 */
const SAVE_OUTCOME_WORDS: Record<SaveOutcome, ((t: Translate) => string) | null> = {
  none: null,
  saved: null,
  failed: t => t('Could not save settings.'),
};

/**
 * The template's one breakpoint for the section list (viewer-template.html, "Under 1100px: the sections become a row
 * of tabs"): at 1100px and below the tabs are drawn as one row, above it as a column. The tablist announces which
 * (aria-orientation); the arrow keys take all four directions either way (onTabKeyDown).
 */
const SETTINGS_TABS_ROW_QUERY = '(max-width: 1100px)';

function subscribeToSettingsTabsRow(onChange: () => void): () => void {
  const query = window.matchMedia(SETTINGS_TABS_ROW_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

const settingsTabsAreRow = () => window.matchMedia(SETTINGS_TABS_ROW_QUERY).matches;

/** The props a field's control takes from its FormField: the id its label names, and what describes it. */
interface FieldControl {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
}

/** A labelled field: the label above, the control, then why its value is refused (if it is) and its help, both in view. */
function FormField({ label, help, error, children }: {
  label: string;
  help?: React.ReactNode;
  error?: string | null;
  children: (control: FieldControl) => React.ReactNode;
}) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`form-field${error ? ' form-field--error' : ''}`}>
      <label className="form-field-label" htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': describedBy, ...(error ? { 'aria-invalid': true as const } : {}) })}
      {error && <p className="field-error" id={errorId}><WarningIcon size={14} /><span>{error}</span></p>}
      {help && <div className="field-help" id={helpId}>{help}</div>}
    </div>
  );
}

/**
 * A number field that says under itself when the worker would refuse its value (SETTING_RANGES). Its help is a
 * template: {min} and {max} are filled in from SETTING_RANGES, so the help never types the bounds again.
 */
function NumberField({ label, help, setting, value, onChange }: {
  label: string;
  help?: string;
  setting: RangedSetting;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const { min, max, decimals } = SETTING_RANGES[setting];
  const bounds = { min: formatCount(min), max: formatCount(max) };
  const error = outOfRange(value, setting)
    ? interpolate(decimals ? t('Enter a number from {min} to {max}.') : t('Enter a whole number from {min} to {max}.'), bounds)
    : null;
  return (
    <FormField label={label} help={help === undefined ? undefined : interpolate(help, bounds)} error={error}>
      {control => (
        <input {...control} type="number" inputMode={decimals ? 'decimal' : 'numeric'} step={decimals ? 'any' : 1}
          min={min} max={max} value={value} onChange={event => onChange(event.target.value)} />
      )}
    </FormField>
  );
}

/** A secret (an API key) hidden by default, with a button that shows it while pressed. */
function SecretInput({ control, label, value, placeholder, onChange }: {
  control: FieldControl;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const toggleLabel = interpolate(t('Show {field}'), { field: label });
  return (
    <div className="field-secret">
      <input {...control} type={shown ? 'text' : 'password'} value={value} placeholder={placeholder}
        autoComplete="off" spellCheck={false} onChange={event => onChange(event.target.value)} />
      <button type="button" className="field-secret-toggle" aria-pressed={shown} aria-label={toggleLabel} title={toggleLabel}
        onClick={() => setShown(value => !value)}>
        {shown ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
      </button>
    </div>
  );
}

/** A value set outside the viewer: a lock, a dashed edge, and read-only (it can still be focused, read and copied). */
function ReadOnlyInput({ control, value, placeholder }: { control: FieldControl; value: string; placeholder?: string }) {
  return (
    <div className="field-readonly">
      <LockIcon size={16} />
      <input {...control} type="text" value={value} placeholder={placeholder} readOnly />
    </div>
  );
}

/** An on/off setting: the switch says On or Off in words beside its track, not by colour and position only. */
function ToggleSwitch({ id, label, description, checked, onChange }: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="toggle-row">
      <div className="toggle-info">
        <label htmlFor={id} id={`${id}-label`} className="toggle-label">{label}</label>
        {description && <span className="toggle-description" id={`${id}-description`}>{description}</span>}
      </div>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-description` : undefined}
        className={`toggle-switch${checked ? ' on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-track" aria-hidden="true"><span className="toggle-knob" /></span>
        <span className="toggle-word" aria-hidden="true">{checked ? t('On') : t('Off')}</span>
      </button>
    </div>
  );
}

function Subsection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="display-subsection">
      <span className="subsection-label">{label}</span>
      {children}
    </div>
  );
}

function formatEpochMs(epochMs: number | null | undefined, t: Translate): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return t('never');
  return new Date(epochMs).toLocaleString(getLocale());
}

/** One label/value line in the backup status readout (toggle-row styling). */
function BackupStatusRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="toggle-row">
      <div className="toggle-info">
        <span className="toggle-label">{label}</span>
      </div>
      <span className="toggle-description">{value}</span>
    </div>
  );
}

/**
 * Live backup status readout (GET /api/backup/status). Mounted only while the Backups section is the one on
 * screen, so it fetches only when someone looks at it.
 */
function BackupStatusPanel() {
  const { t } = useI18n();
  const { status, isLoading, error } = useBackupStatus();

  if (isLoading) {
    return <span className="toggle-description">{t('Loading backup status...')}</span>;
  }
  if (error) {
    return <span className="toggle-description">{t(error)}</span>;
  }
  if (!status) return null;

  if (!status.configured) {
    return (
      <span className="toggle-description">
        {t('Backups are not running. Turn on automatic snapshots, save, and restart the worker.')}
      </span>
    );
  }

  return (
    <div className="toggle-group">
      <BackupStatusRow label={t('Last snapshot')} value={formatEpochMs(status.lastSnapshotAt, t)} />
      <BackupStatusRow label={t('Snapshots on disk')} value={formatCount(status.snapshotCount ?? 0)} />
      {status.lastError && <BackupStatusRow label={t('Last error')} value={t(status.lastError)} />}
    </div>
  );
}

export function ContextSettingsModal({
  isOpen,
  onClose,
  settings,
  isLoaded,
  loadError,
  onRetryLoad,
  onSave,
  isSaving,
  saveStatus,
  onShowInTimeline,
}: ContextSettingsModalProps) {
  const dialogRef = useDialogFocus(isOpen);
  const { t } = useI18n();
  const idPrefix = useId();
  const [formState, setFormState] = useState<Settings>(settings);
  const [activeSection, setActiveSection] = useState<SettingsSection>('loading');
  // When this dialog saw the last save succeed; cleared by the next change and when the dialog closes.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // The in-page question asked when the dialog is closed with unsaved changes, and what to do after it closes.
  const [closeQuestion, setCloseQuestion] = useState<{ then?: () => void; returnFocus: HTMLElement | null } | null>(null);
  const tabRefs = useRef(new Map<SettingsSection, HTMLButtonElement>());
  // At 1100px and below the section list is one sideways row with its scrollbar hidden: its cut edge fades out.
  const { rowRef: navRowRef, className: navOverflowClass } = useRowOverflow();
  // The direction the tabs are drawn in, kept current as the window changes width. A render without a window (the
  // unit tests' static render) takes the desktop column.
  const tabsOrientation = useSyncExternalStore(subscribeToSettingsTabsRow, settingsTabsAreRow, () => false) ? 'horizontal' : 'vertical';
  // The failed save the person has moved past: they edited back to no changes, or closed and opened the dialog
  // again. Its words go; a later failed save is a new one and shows. useSettings stays the outcome's one writer.
  const [setAsideFailure, setSetAsideFailure] = useState<SaveStatus | null>(null);
  const columnRef = useRef<HTMLFieldSetElement>(null);
  const focusAfterQuestionRef = useRef<HTMLElement | null>(null);
  // From the saved settings, not the form: the field stays editable while a
  // user types any other URL, and read-only for the observer's own endpoint.
  const observerManagesBaseUrl = isClaudeMemObserverBaseUrl(settings.CLAUDE_MEM_OPENROUTER_BASE_URL);

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

  const changedKeys = useMemo(() => changedSettingKeys(formState, settings), [formState, settings]);
  const isDirty = changedKeys.length > 0;
  const saveSucceeded = saveStatus.outcome === 'saved';
  const failureWords = !isSaving && saveStatus !== setAsideFailure ? SAVE_OUTCOME_WORDS[saveStatus.outcome]?.(t) ?? null : null;

  useEffect(() => { if (saveSucceeded) setSavedAt(Date.now()); }, [saveSucceeded]);
  useEffect(() => { if (isDirty) setSavedAt(null); }, [isDirty]);
  // Edited back to no changes after a refused save: "Could not save settings." no longer describes the form.
  useEffect(() => { if (!isDirty && saveStatus.outcome === 'failed') setSetAsideFailure(saveStatus); }, [isDirty, saveStatus]);
  useEffect(() => {
    if (isOpen) return;
    setSavedAt(null);
    setCloseQuestion(null);
  }, [isOpen]);
  // Opened again: an old failed save stays behind (before paint, so it never flashes).
  useLayoutEffect(() => {
    if (isOpen) setSetAsideFailure(saveStatus);
    // Only on opening; saveStatus is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  // "Keep editing" puts focus back where it was before the question took the footer.
  useEffect(() => {
    if (closeQuestion || !focusAfterQuestionRef.current) return;
    const target = focusAfterQuestionRef.current;
    focusAfterQuestionRef.current = null;
    if (target.isConnected) target.focus();
  }, [closeQuestion]);

  const updateSetting = useCallback((key: keyof Settings, value: string) => {
    setFormState(previous => ({ ...previous, [key]: value }));
  }, []);

  const toggleBoolean = useCallback((key: keyof Settings) => {
    setFormState(previous => ({ ...previous, [key]: previous[key] === 'true' ? 'false' : 'true' }));
  }, []);

  /** Saves the changed settings; a dimmed Save (nothing changed) does nothing. */
  const handleSave = useCallback(() => {
    if (!isDirty) return;
    onSave(formState);
  }, [formState, isDirty, onSave]);

  /** Closes, or asks first when changes would be lost (in the page, never the browser's confirm box). */
  const requestClose = useCallback((then?: () => void) => {
    if (isDirty && !isSaving) {
      setCloseQuestion(previous => previous ?? {
        then,
        returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      });
      return;
    }
    onClose();
    then?.();
  }, [isDirty, isSaving, onClose]);

  const discardAndClose = useCallback(() => {
    const then = closeQuestion?.then;
    setCloseQuestion(null);
    setFormState(settings);
    onClose();
    then?.();
  }, [closeQuestion, settings, onClose]);

  const keepEditing = useCallback(() => {
    focusAfterQuestionRef.current = closeQuestion?.returnFocus ?? null;
    setCloseQuestion(null);
  }, [closeQuestion]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, requestClose]);

  // The tab a key chose, brought into view once it is drawn as chosen: its bold label is wider, so placing it before
  // that render leaves its end under the row's edge fade (2px on Linux CI). A new object each time, so pressing the
  // key for the tab already chosen still brings it back.
  const [tabToReveal, setTabToReveal] = useState<{ section: SettingsSection } | null>(null);
  const selectSection = useCallback((section: SettingsSection, focus = false) => {
    setActiveSection(section);
    if (columnRef.current) columnRef.current.scrollTop = 0;
    if (!focus) return;
    tabRefs.current.get(section)?.focus({ preventScroll: true });
    setTabToReveal({ section });
  }, []);
  useLayoutEffect(() => {
    // In the sideways row (1100px and below) the tab comes clear of the row's edge fade: scrollIntoView keeps the
    // row's scroll-padding (.scroll-more-before/after, 56px), which focus's own scrolling does not.
    if (tabToReveal) tabRefs.current.get(tabToReveal.section)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tabToReveal]);

  /** The section list is a tab list, a column or a row (tabsOrientation): any arrow, Home and End move and choose. */
  const onTabKeyDown = (event: React.KeyboardEvent, section: SettingsSection) => {
    const index = SETTINGS_SECTIONS.indexOf(section);
    let next: number;
    switch (event.key) {
      case 'ArrowDown': case 'ArrowRight': next = index + 1; break;
      case 'ArrowUp': case 'ArrowLeft': next = index - 1; break;
      case 'Home': next = 0; break;
      case 'End': next = SETTINGS_SECTIONS.length - 1; break;
      default: return;
    }
    event.preventDefault();
    selectSection(SETTINGS_SECTIONS[(next + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length], true);
  };

  const facts = useMemo(() => previewFacts(preview), [preview]);

  if (!isOpen) return null;

  const footerState = settingsFooterState({ isLoaded, loadError, isSaving, changedCount: changedKeys.length, savedAt });
  const footerWords = FOOTER_WORDS[footerState](t, { changed: changedKeys.length, savedAt });
  const footerLineId = `${idPrefix}-footer-line`;
  const sourceId = `${idPrefix}-source`;
  const projectId = `${idPrefix}-project`;
  // '' is the "All sources" choice, as null is before the first choice: both read "All sources" on the strip.
  const previewLabel = [selectedSource || t('All sources'), selectedProject].filter(Boolean).join(' · ');
  // Only for a preview that arrived: before the first read (300 ms after a choice) it would read "0 characters".
  const showPreviewSize = !isLoading && !error && !!selectedProject && preview !== '';
  const previewSize = showPreviewSize ? [
    interpolate(t('{count} characters'), { count: formatCount(facts.characters) }),
    interpolate(facts.shortened
      ? (facts.observations === 1 ? t('{count} observation shown') : t('{count} observations shown'))
      : (facts.observations === 1 ? t('{count} observation') : t('{count} observations')),
    { count: formatCount(facts.observations) }),
  ].join(' · ') : null;
  const showAllInTimeline = onShowInTimeline && selectedProject
    ? () => requestClose(() => onShowInTimeline(selectedProject))
    : undefined;
  const keepImages = formState.CLAUDE_MEM_MEDIA_CAPTURE_ENABLED === 'true';
  const presetOption = openAICompatPresetOption(formState.CLAUDE_MEM_OPENAI_COMPAT_PRESET);

  const panel = (section: SettingsSection, children: React.ReactNode) => (
    <section
      key={section}
      role="tabpanel"
      id={`${idPrefix}-panel-${section}`}
      aria-labelledby={`${idPrefix}-tab-${section}`}
      hidden={activeSection !== section}
      className="settings-panel"
    >
      <div className="settings-panel-heading">
        <h3>{SECTION_WORDS[section].title(t)}</h3>
        <p>{SECTION_WORDS[section].description(t)}</p>
      </div>
      {children}
    </section>
  );

  return (
    <div className="modal-backdrop settings-backdrop" onClick={() => requestClose()}>
      <div ref={dialogRef} tabIndex={-1} className="context-settings-modal" role="dialog" aria-modal="true" aria-labelledby="memory-settings-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="settings-heading"><h2 id="memory-settings-title">{t('Settings')}</h2><p>{t('Choose the context your next session receives.')}</p></div>
          <button
            type="button"
            onClick={() => requestClose()}
            className="modal-close-btn settings-close-btn"
            title={t('Close (Esc)')}
            aria-label={t('Close settings')}
          >
            <XIcon size={18} />
          </button>
        </div>

        <div className="modal-body">
          <div ref={navRowRef} className={`settings-nav${navOverflowClass}`} role="tablist" aria-orientation={tabsOrientation} aria-label={t('Settings sections')}>
            {SETTINGS_SECTIONS.map(section => (
              <button
                key={section}
                ref={element => { if (element) tabRefs.current.set(section, element); else tabRefs.current.delete(section); }}
                type="button"
                role="tab"
                id={`${idPrefix}-tab-${section}`}
                aria-selected={activeSection === section}
                aria-controls={`${idPrefix}-panel-${section}`}
                tabIndex={activeSection === section ? 0 : -1}
                className={`settings-nav-tab${activeSection === section ? ' settings-nav-tab--active' : ''}`}
                onClick={() => selectSection(section)}
                onKeyDown={event => onTabKeyDown(event, section)}
              >
                <span className="settings-nav-label">{SECTION_WORDS[section].title(t)}</span>
                {/* Images are kept by default (#5426), so whether they are is in view from the list itself. */}
                {section === 'images' && <span className="settings-nav-hint">{keepImages ? t('On') : t('Off')}</span>}
              </button>
            ))}
          </div>

          {/* Before the initial load the form holds defaults; saving them would overwrite settings.json. */}
          <fieldset ref={columnRef} className="settings-column" disabled={isSaving || !isLoaded}
            style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            {panel('loading', <>
              <NumberField
                label={t('Observations')}
                help={t('Number of recent observations to include in context ({min}-{max})')}
                setting="CLAUDE_MEM_CONTEXT_OBSERVATIONS"
                value={formState.CLAUDE_MEM_CONTEXT_OBSERVATIONS || DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_OBSERVATIONS}
                onChange={value => updateSetting('CLAUDE_MEM_CONTEXT_OBSERVATIONS', value || DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_OBSERVATIONS)}
              />
              <ToggleSwitch
                id="session-start-all-sources"
                label={t('Include all sources at session start')}
                description={t('Show observations from Claude, Codex, and other harnesses in startup context')}
                checked={formState.CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES === 'true'}
                onChange={() => toggleBoolean('CLAUDE_MEM_SESSION_START_INCLUDE_ALL_SOURCES')}
              />
              <NumberField
                label={t('Sessions')}
                help={t('Number of recent sessions to pull observations from ({min}-{max})')}
                setting="CLAUDE_MEM_CONTEXT_SESSION_COUNT"
                value={formState.CLAUDE_MEM_CONTEXT_SESSION_COUNT || DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_SESSION_COUNT}
                onChange={value => updateSetting('CLAUDE_MEM_CONTEXT_SESSION_COUNT', value || DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_SESSION_COUNT)}
              />
            </>)}

            {panel('display', <>
              <Subsection label={t('Full Observations')}>
                <NumberField
                  label={t('Count')}
                  help={t('How many observations show expanded details ({min}-{max})')}
                  setting="CLAUDE_MEM_CONTEXT_FULL_COUNT"
                  value={formState.CLAUDE_MEM_CONTEXT_FULL_COUNT || DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_FULL_COUNT}
                  onChange={value => updateSetting('CLAUDE_MEM_CONTEXT_FULL_COUNT', value || DEFAULT_SETTINGS.CLAUDE_MEM_CONTEXT_FULL_COUNT)}
                />
                <FormField label={t('Field')} help={t('Which field to expand for full observations')}>
                  {control => (
                    <select {...control} value={formState.CLAUDE_MEM_CONTEXT_FULL_FIELD || 'narrative'}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CONTEXT_FULL_FIELD', e.target.value)}>
                      <option value="narrative">{t('Narrative')}</option>
                      <option value="facts">{t('Facts')}</option>
                    </select>
                  )}
                </FormField>
              </Subsection>
              <Subsection label={t('Token Economics')}>
                <div className="toggle-group">
                  <ToggleSwitch
                    id="show-read-tokens"
                    label={t('Read cost')}
                    description={t('Tokens to read this observation')}
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_READ_TOKENS')}
                  />
                  <ToggleSwitch
                    id="show-work-tokens"
                    label={t('Work investment')}
                    description={t('Tokens spent creating this observation')}
                    checked={formState.CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS === 'true'}
                    onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_WORK_TOKENS')}
                  />
                </div>
              </Subsection>
            </>)}

            {/* The three context switches, moved out of Advanced (they sat under the AI provider and API key). */}
            {panel('context', (
              <div className="toggle-group">
                <ToggleSwitch
                  id="show-last-summary"
                  label={t('Include last summary')}
                  description={t("Add previous session's summary to context")}
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_SUMMARY')}
                />
                <ToggleSwitch
                  id="show-last-message"
                  label={t('Include last message')}
                  description={t("Add previous session's final message")}
                  checked={formState.CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE')}
                />
                <ToggleSwitch
                  id="file-read-gate"
                  label={t('Block full-file reads')}
                  description={t('Send Claude to smart_outline/smart_unfold and past observations instead of reading whole code files of 32 KB and up that have history')}
                  checked={formState.CLAUDE_MEM_FILE_READ_GATE_ENABLED !== 'false'}
                  onChange={(checked) => updateSetting('CLAUDE_MEM_FILE_READ_GATE_ENABLED', checked ? 'true' : 'false')}
                />
              </div>
            ))}

            {panel('images', (
              <div className="toggle-group">
                <ToggleSwitch
                  id="media-capture-enabled"
                  label={t('Keep images')}
                  description={t('Keep the screenshots and images your agent reads or makes, so they show on your requests in My Work. Images stay on this computer until their event is deleted. With Cloud Sync on, they are also uploaded privately to your cmem.ai account. This switch never sends images to an AI model. Turning it off stops keeping new images; images already kept stay.')}
                  checked={keepImages}
                  onChange={(checked) => updateSetting('CLAUDE_MEM_MEDIA_CAPTURE_ENABLED', checked ? 'true' : 'false')}
                />
              </div>
            ))}

            {panel('backups', <>
              <div className="toggle-group">
                <ToggleSwitch
                  id="backup-enabled"
                  label={t('Automatic snapshots')}
                  description={t('Snapshot the database on a schedule (restart the worker to apply)')}
                  checked={formState.CLAUDE_MEM_BACKUP_ENABLED === 'true'}
                  onChange={() => toggleBoolean('CLAUDE_MEM_BACKUP_ENABLED')}
                />
              </div>
              <NumberField
                label={t('Interval (hours)')}
                help={t('Hours between automatic snapshots ({min}-{max})')}
                setting="CLAUDE_MEM_BACKUP_INTERVAL_HOURS"
                value={formState.CLAUDE_MEM_BACKUP_INTERVAL_HOURS || DEFAULT_SETTINGS.CLAUDE_MEM_BACKUP_INTERVAL_HOURS}
                onChange={value => updateSetting('CLAUDE_MEM_BACKUP_INTERVAL_HOURS', value || DEFAULT_SETTINGS.CLAUDE_MEM_BACKUP_INTERVAL_HOURS)}
              />
              <NumberField
                label={t('Snapshots to keep')}
                help={t('How many local snapshots to retain before old ones are deleted ({min}-{max})')}
                setting="CLAUDE_MEM_BACKUP_RETAIN_COUNT"
                value={formState.CLAUDE_MEM_BACKUP_RETAIN_COUNT || DEFAULT_SETTINGS.CLAUDE_MEM_BACKUP_RETAIN_COUNT}
                onChange={value => updateSetting('CLAUDE_MEM_BACKUP_RETAIN_COUNT', value || DEFAULT_SETTINGS.CLAUDE_MEM_BACKUP_RETAIN_COUNT)}
              />
              <Subsection label={t('Status')}>
                {activeSection === 'backups' && <BackupStatusPanel />}
              </Subsection>
              <p className="toggle-description">
                {t('Restore from a snapshot:')} <code>npx claude-mem restore &lt;file&gt;</code>
              </p>
            </>)}

            {panel('provider', <>
              <div className="toggle-group">
                <ToggleSwitch
                  id="observer-enabled"
                  label={t('Memory capture')}
                  description={t('Generate new observations and session summaries with the selected AI provider. Turn this off to stop those capture calls; existing memories, search, and SessionStart context remain available.')}
                  checked={formState.CLAUDE_MEM_OBSERVER_ENABLED !== 'false'}
                  onChange={(checked) => updateSetting('CLAUDE_MEM_OBSERVER_ENABLED', checked ? 'true' : 'false')}
                />
              </div>

              <FormField
                label={t('AI Provider')}
                help={t('Choose the provider that generates observations: Claude (via Agent SDK), Gemini (via REST API), OpenRouter (also used by the claude-mem observer), Codex (your ChatGPT subscription), or any OpenAI-compatible endpoint')}
              >
                {control => (
                  <select {...control} value={formState.CLAUDE_MEM_PROVIDER || 'claude'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_PROVIDER', e.target.value)}>
                    <option value="claude">{t(claudeProviderOptionLabel(formState.CLAUDE_MEM_CLAUDE_AUTH_METHOD))}</option>
                    <option value="gemini">{t('Gemini (uses API key)')}</option>
                    <option value="openrouter">{t('OpenRouter / claude-mem observer')}</option>
                    <option value="codex">{t('Codex (uses your ChatGPT subscription)')}</option>
                    <option value="openai-compatible">{t('OpenAI-compatible endpoint (BYOK)')}</option>
                  </select>
                )}
              </FormField>

              {formState.CLAUDE_MEM_PROVIDER === 'claude' && (
                <>
                  <FormField label={t('Claude Model')} help={t('Claude model used for generating observations')}>
                    {control => (
                      <select {...control} value={formState.CLAUDE_MEM_MODEL || 'haiku'}
                        onChange={(e) => updateSetting('CLAUDE_MEM_MODEL', e.target.value)}>
                        <option value="haiku">{t('haiku (fastest)')}</option>
                        <option value="sonnet">{t('sonnet (balanced)')}</option>
                        <option value="opus">{t('opus (highest quality)')}</option>
                      </select>
                    )}
                  </FormField>
                  <FormField
                    label={t('Claude Auth Method')}
                    help={t("Records which Claude credential this install uses: your Claude account login (subscription), an ANTHROPIC_API_KEY (api-key), a custom ANTHROPIC_BASE_URL endpoint (gateway), or Claude Code's own credentials (cli). The credential itself comes from ~/.claude-mem/.env: an ANTHROPIC_BASE_URL or ANTHROPIC_API_KEY there is used even when this says subscription. Shared with the Quota Fallback Claude option.")}
                  >
                    {control => (
                      <select {...control} value={formState.CLAUDE_MEM_CLAUDE_AUTH_METHOD || 'subscription'}
                        onChange={(e) => updateSetting('CLAUDE_MEM_CLAUDE_AUTH_METHOD', e.target.value)}>
                        <option value="subscription">{t('subscription (Claude account login)')}</option>
                        <option value="api-key">{t('api-key (ANTHROPIC_API_KEY)')}</option>
                        <option value="gateway">{t('gateway (custom endpoint + token)')}</option>
                        <option value="cli">{t('cli (Claude Code credentials)')}</option>
                      </select>
                    )}
                  </FormField>
                </>
              )}

              {(formState.CLAUDE_MEM_PROVIDER === 'codex' || formState.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER === 'codex') && (
                <FormField
                  label={t('Codex Model')}
                  help={t('Optional model available through your Codex subscription; leave empty for the Codex default. Run codex login before starting the worker.')}
                >
                  {control => (
                    <input {...control} type="text" value={formState.CLAUDE_MEM_CODEX_MODEL || ''}
                      onChange={(e) => updateSetting('CLAUDE_MEM_CODEX_MODEL', e.target.value)}
                      placeholder={t('Codex default (e.g. gpt-6-luna)')} />
                  )}
                </FormField>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'gemini' && (
                <>
                  <FormField label={t('Gemini API Key')} help={t('Your Google AI Studio API key (or set GEMINI_API_KEY env var)')}>
                    {control => (
                      <SecretInput control={control} label={t('Gemini API Key')} value={formState.CLAUDE_MEM_GEMINI_API_KEY || ''}
                        placeholder={t('Enter Gemini API key...')} onChange={value => updateSetting('CLAUDE_MEM_GEMINI_API_KEY', value)} />
                    )}
                  </FormField>
                  <FormField label={t('Gemini Model')} help={t('Gemini model used for generating observations')}>
                    {control => (
                      <select {...control} value={formState.CLAUDE_MEM_GEMINI_MODEL || 'gemini-flash-latest'}
                        onChange={(e) => updateSetting('CLAUDE_MEM_GEMINI_MODEL', e.target.value)}>
                        <option value="gemini-flash-latest">{t('gemini-flash-latest (default, latest GA Flash)')}</option>
                        <option value="gemini-flash-lite-latest">{t('gemini-flash-lite-latest (latest GA Flash-Lite)')}</option>
                        <option value="gemini-3.5-flash">{t('gemini-3.5-flash')}</option>
                        <option value="gemini-3.1-flash-lite">{t('gemini-3.1-flash-lite')}</option>
                        <option value="gemini-3-flash-preview">{t('gemini-3-flash-preview (preview)')}</option>
                      </select>
                    )}
                  </FormField>
                  <div className="toggle-group">
                    <ToggleSwitch
                      id="gemini-rate-limiting"
                      label={t('Rate Limiting')}
                      description={t('Enable for free tier (10-30 RPM). Disable if you have billing set up (1000+ RPM).')}
                      checked={formState.CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED === 'true'}
                      onChange={(checked) => updateSetting('CLAUDE_MEM_GEMINI_RATE_LIMITING_ENABLED', checked ? 'true' : 'false')}
                    />
                  </div>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'openrouter' && (
                <>
                  <FormField label={t('OpenRouter API Key')} help={t('Your OpenRouter API key from openrouter.ai (or set OPENROUTER_API_KEY env var)')}>
                    {control => (
                      <SecretInput control={control} label={t('OpenRouter API Key')} value={formState.CLAUDE_MEM_OPENROUTER_API_KEY || ''}
                        placeholder={t('Enter OpenRouter API key...')} onChange={value => updateSetting('CLAUDE_MEM_OPENROUTER_API_KEY', value)} />
                    )}
                  </FormField>
                  <FormField
                    label={t('OpenRouter Model')}
                    help={t('Model identifier from openrouter.ai/models (e.g., anthropic/claude-haiku-4.5, google/gemini-2.5-flash)')}
                  >
                    {control => (
                      // The stored value, the default as the placeholder: empty posts '' and the worker uses its default model.
                      <input {...control} type="text"
                        value={formState.CLAUDE_MEM_OPENROUTER_MODEL ?? ''}
                        onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_MODEL', e.target.value)}
                        placeholder={interpolate(t('e.g., {model}'), { model: DEFAULT_SETTINGS.CLAUDE_MEM_OPENROUTER_MODEL })} />
                    )}
                  </FormField>
                  <FormField
                    label={t('OpenRouter Base URL')}
                    help={<>
                      <p>{observerManagesBaseUrl
                        ? t('Managed by the claude-mem observer. Run npx claude-mem install to use your own endpoint.')
                        : t('Configured in settings.json or the worker environment. Empty uses openrouter.ai.')}</p>
                      <p>
                        {t('Set')} <code>CLAUDE_MEM_OPENROUTER_BASE_URL</code>{' '}{t('in')}{' '}
                        <code>~/.claude-mem/settings.json</code>{' '}{t('or the worker environment. The viewer cannot change where your API key is sent.')}
                      </p>
                    </>}
                  >
                    {control => <ReadOnlyInput control={control} value={formState.CLAUDE_MEM_OPENROUTER_BASE_URL || ''} placeholder="https://openrouter.ai/api/v1" />}
                  </FormField>
                  {!observerManagesBaseUrl && (
                    <FormField
                      label={t('Reasoning effort')}
                      help={t('openrouter.ai only. Empty (the default) sends reasoning off. Set an effort to opt back in. A custom gateway does not get this field until an empty length-truncated reply retries once.')}
                    >
                      {control => (
                        <select {...control} value={formState.CLAUDE_MEM_OPENROUTER_REASONING_EFFORT || ''}
                          onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_REASONING_EFFORT', e.target.value)}>
                          <option value="">{t('Off (default)')}</option>
                          <option value="none">{t('None (reasoning off)')}</option>
                          <option value="minimal">{t('Minimal')}</option>
                          <option value="low">{t('Low')}</option>
                          <option value="medium">{t('Medium')}</option>
                          <option value="high">{t('High')}</option>
                        </select>
                      )}
                    </FormField>
                  )}
                  <FormField label={t('Site URL (Optional)')} help={t('Your site URL for OpenRouter analytics (optional)')}>
                    {control => (
                      <input {...control} type="text" value={formState.CLAUDE_MEM_OPENROUTER_SITE_URL || ''}
                        onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_SITE_URL', e.target.value)}
                        placeholder="https://yoursite.com" />
                    )}
                  </FormField>
                  <FormField label={t('App Name (Optional)')} help={t('Your app name for OpenRouter analytics (optional)')}>
                    {control => (
                      // The stored value, the default as the placeholder: empty posts '' and the worker uses its default name.
                      <input {...control} type="text" value={formState.CLAUDE_MEM_OPENROUTER_APP_NAME ?? ''}
                        onChange={(e) => updateSetting('CLAUDE_MEM_OPENROUTER_APP_NAME', e.target.value)}
                        placeholder={DEFAULT_SETTINGS.CLAUDE_MEM_OPENROUTER_APP_NAME} />
                    )}
                  </FormField>
                </>
              )}

              {formState.CLAUDE_MEM_PROVIDER === 'openai-compatible' && (
                <>
                  <FormField
                    label={t('Endpoint preset')}
                    help={<>
                      <p>{t('Configured outside the viewer. Supplies the base URL and default model unless explicitly overridden.')}</p>
                      {presetOption.note && <p>{t(presetOption.note)}</p>}
                    </>}
                  >
                    {control => <ReadOnlyInput control={control} value={t(presetOption.label)} />}
                  </FormField>
                  <FormField
                    label={t('Base URL')}
                    help={<>
                      <p>{t("Configured in settings.json or the worker environment. Empty uses the preset's endpoint.")}</p>
                      <p>
                        {t('Set the endpoint and preset in')} <code>~/.claude-mem/settings.json</code>{' '}
                        {t('or the worker environment. They determine where your API key is sent.')}
                      </p>
                    </>}
                  >
                    {control => (
                      <ReadOnlyInput control={control} value={formState.CLAUDE_MEM_OPENAI_COMPAT_BASE_URL || ''}
                        placeholder={presetOption.baseUrl || 'https://my-gateway.example.com/v1'} />
                    )}
                  </FormField>
                  <FormField label={t('Model')} help={t("Model id, passed verbatim. Leave blank to use the preset's default")}>
                    {control => (
                      <input {...control} type="text" value={formState.CLAUDE_MEM_OPENAI_COMPAT_MODEL || ''}
                        onChange={(e) => updateSetting('CLAUDE_MEM_OPENAI_COMPAT_MODEL', e.target.value)}
                        placeholder={presetOption.defaultModel || t('model id')} />
                    )}
                  </FormField>
                  <FormField
                    label={t('Reasoning')}
                    help={t('Off (default) sends reasoning disabled so a reasoning model cannot spend the output cap thinking. On leaves it to the endpoint. A server that rejects the field is retried once without it.')}
                  >
                    {control => (
                      <select {...control} value={formState.CLAUDE_MEM_OPENAI_COMPAT_REASONING || ''}
                        onChange={(e) => updateSetting('CLAUDE_MEM_OPENAI_COMPAT_REASONING', e.target.value)}>
                        <option value="">{t('Off (default)')}</option>
                        <option value="on">{t('On (endpoint decides)')}</option>
                      </select>
                    )}
                  </FormField>
                  <FormField label={t('Reasoning effort')}
                    help={t('Select an effort supported by your model to override the reasoning setting for the observer and API agent.')}>
                    {control => (
                      <select {...control} value={formState.CLAUDE_MEM_OPENAI_COMPAT_REASONING_EFFORT || ''}
                        onChange={(e) => updateSetting('CLAUDE_MEM_OPENAI_COMPAT_REASONING_EFFORT', e.target.value)}>
                        <option value="">{t('No override')}</option>
                        {OPENAI_COMPAT_REASONING_EFFORTS.map(effort => <option key={effort} value={effort}>{effort}</option>)}
                      </select>
                    )}
                  </FormField>
                  <p className="toggle-description">
                    {t('The API key is set outside the viewer:')} <code>CLAUDE_MEM_OPENAI_COMPAT_API_KEY</code>{' '}{t('in')}{' '}
                    <code>~/.claude-mem/settings.json</code>{t(', or')} <code>OPENAI_COMPAT_API_KEY</code>{' '}{t('in')}{' '}
                    <code>~/.claude-mem/.env</code>{t('. Local servers need none.')}
                  </p>
                </>
              )}

            </>)}

            {/* Moved out of the old Advanced section, which held the provider, the fallbacks and the context switches. */}
            {panel('fallbacks', <>
              <FormField
                label={t('Quota Fallback')}
                help={t('While the selected provider cannot serve (allowance spent, rate limited or over capacity past its retries, unavailable, or repeatedly returning unusable replies), send observation work here until it recovers. Claude (your Anthropic plan) is the default and is used only when a Claude login or key exists. Off: work waits for the provider.')}
              >
                {control => (
                  <select {...control} value={formState.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER || 'claude'}
                    onChange={(e) => updateSetting('CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER', e.target.value)}>
                    {QUOTA_FALLBACK_OPTIONS.map(provider => (
                    <option key={provider} value={provider}>{({
                      claude: t(claudeProviderOptionLabel(formState.CLAUDE_MEM_CLAUDE_AUTH_METHOD)),
                      off: t('Off (wait for the provider)'),
                      gemini: t('Gemini (uses API key)'),
                      openrouter: t('OpenRouter / claude-mem observer'),
                      'openai-compatible': t('OpenAI-compatible endpoint'),
                      codex: t('Codex (uses your ChatGPT subscription)'),
                    } satisfies Record<QuotaFallbackOption, string>)[provider]}</option>
                  ))}
                </select>
                )}
              </FormField>

              {(formState.CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER || 'claude') === 'claude' && (
                <>
                  <FormField
                    label={t('Claude Auth Method')}
                    help={t("The same CLAUDE_MEM_CLAUDE_AUTH_METHOD setting as the AI Provider's Claude Auth Method. Fallback Claude runs use the same credential, which comes from ~/.claude-mem/.env when an ANTHROPIC_BASE_URL or ANTHROPIC_API_KEY is set there.")}
                  >
                    {control => (
                      <select {...control} value={formState.CLAUDE_MEM_CLAUDE_AUTH_METHOD || 'subscription'}
                        onChange={(e) => updateSetting('CLAUDE_MEM_CLAUDE_AUTH_METHOD', e.target.value)}>
                        <option value="subscription">{t('subscription (Claude account login)')}</option>
                        <option value="api-key">{t('api-key (ANTHROPIC_API_KEY)')}</option>
                        <option value="gateway">{t('gateway (custom endpoint + token)')}</option>
                        <option value="cli">{t('cli (Claude Code credentials)')}</option>
                      </select>
                    )}
                  </FormField>
                  <FormField
                    label={t('Fallback Claude Model')}
                    help={t('Claude model for fallback runs only. Blank uses the Claude Model setting and tier routing.')}
                  >
                    {control => (
                      <input {...control} type="text" value={formState.CLAUDE_MEM_QUOTA_FALLBACK_MODEL || ''}
                        onChange={(e) => updateSetting('CLAUDE_MEM_QUOTA_FALLBACK_MODEL', e.target.value)}
                        placeholder={t('e.g., haiku')} />
                    )}
                  </FormField>
                </>
              )}

              <FormField
                label={t('Claude Credential Fallback')}
                help={t('For a Claude observer: the other credential to run on while the primary one is held for quota, tried before the Quota Fallback provider. Subscription: a spent ANTHROPIC_API_KEY (e.g. credit balance too low) hands over to your Claude Code login, still protected by the quota guard. API key: a login that is spent or paused by the quota guard hands over to ANTHROPIC_FALLBACK_API_KEY in ~/.claude-mem/.env, billed per request. Either returns to the primary once it recovers; neither applies under ANTHROPIC_BASE_URL.')}
              >
                {control => (
                  <select {...control} value={formState.CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD || ''}
                    onChange={(e) => updateSetting('CLAUDE_MEM_QUOTA_FALLBACK_AUTH_METHOD', e.target.value)}>
                    <option value="">{t('Off (wait for the primary credential)')}</option>
                    <option value="subscription">{t('Subscription (Claude Code login)')}</option>
                    <option value="api-key">{t('API key (ANTHROPIC_FALLBACK_API_KEY)')}</option>
                  </select>
                )}
              </FormField>
            </>)}

            {panel('advanced', <>
              <FormField
                label={t('My Work summary provider')}
                help={t('Generated card wording uses this endpoint. Empty uses OpenRouter only when it is the primary observer provider; any other endpoint, or a fallback key, is not used unless you select its provider here. Explicit provider selection may incur that provider\'s usual charges.')}
              >
                {control => (
                  <select {...control} value={formState.CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER || ''}
                    onChange={(e) => updateSetting('CLAUDE_MEM_WORK_VIEW_COPY_PROVIDER', e.target.value)}>
                    <option value="">{t('OpenRouter when it is the primary provider')}</option>
                    <option value="openrouter">{t('OpenRouter')}</option>
                    <option value="openai-compatible">{t('OpenAI-compatible endpoint')}</option>
                    <option value="off">{t('Off (recorded wording only)')}</option>
                  </select>
                )}
              </FormField>
              <FormField
                label={t('My Work summary model override')}
                help={t("Optional model id for generated card wording. Empty uses the selected provider's configured model.")}
              >
                {control => (
                  <input {...control} type="text" maxLength={200} value={formState.CLAUDE_MEM_WORK_VIEW_COPY_MODEL || ''}
                    onChange={(e) => updateSetting('CLAUDE_MEM_WORK_VIEW_COPY_MODEL', e.target.value)}
                    placeholder={t('Use the provider\'s configured model')} />
                )}
              </FormField>
              <FormField
                label={t('Claude Code CLI path')}
                help={<>
                  <p>{t('Executable path for the Claude Code CLI. File/env only — edit ~/.claude-mem/settings.json or set CLAUDE_CODE_PATH in the environment, then restart the worker.')}</p>
                  <p>{t('Read-only here. Set')} <code>CLAUDE_CODE_PATH</code> {t('in')} <code>~/.claude-mem/settings.json</code> {t('or the environment.')}</p>
                </>}
              >
                {control => (
                  <ReadOnlyInput control={control} value={formState.CLAUDE_CODE_PATH || ''}
                    placeholder={t('Auto-detect (set via settings.json or env)')} />
                )}
              </FormField>
              <NumberField
                label={t('Worker Port')}
                help={t('Port for the background worker service')}
                setting="CLAUDE_MEM_WORKER_PORT"
                // Empty puts the saved port back, never a default: the viewer's 37700 is not this install's port (the worker adds a
                // per-install offset, getDefaultWorkerPort), and an empty port must never reach settings.json.
                value={formState.CLAUDE_MEM_WORKER_PORT || settings.CLAUDE_MEM_WORKER_PORT || DEFAULT_SETTINGS.CLAUDE_MEM_WORKER_PORT}
                onChange={value => updateSetting('CLAUDE_MEM_WORKER_PORT', value || settings.CLAUDE_MEM_WORKER_PORT || DEFAULT_SETTINGS.CLAUDE_MEM_WORKER_PORT)}
              />
            </>)}
          </fieldset>

          <div className="preview-column">
            <div className="settings-preview-heading">
              <h3>{t('Saved context preview')}</h3>
              {previewSize && <p className="preview-size">{previewSize}</p>}
            </div>
            <p className="settings-preview-note">{t('Preview the saved configuration for the selected source and project.')}</p>
            {/* The two choices scope the preview below them, not the settings. */}
            <div className="preview-selectors">
              <div className="preview-field">
                <label htmlFor={sourceId}>{t('Source:')}</label>
                <select id={sourceId} value={selectedSource || ''} onChange={(e) => setSelectedSource(e.target.value)} disabled={sources.length === 0}>
                  <option value="">{t('All sources')}</option>
                  {sources.map(source => (
                    <option key={source} value={source}>{source}</option>
                  ))}
                </select>
              </div>
              <div className="preview-field">
                <label htmlFor={projectId}>{t('Project:')}</label>
                <select id={projectId} value={selectedProject || ''} onChange={(e) => setSelectedProject(e.target.value)} disabled={projects.length === 0}>
                  {projects.map(project => (
                    <option key={project} value={project}>{project}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="preview-content">
              {error ? (
                <div className="preview-error" role="alert">
                  {interpolate(t('Error loading preview: {error}'), { error })}
                </div>
              ) : (
                <TerminalPreview content={preview} isLoading={isLoading} label={previewLabel} onShowAll={showAllInTimeline} />
              )}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          {closeQuestion && (
            <InlineConfirm
              question={changedKeys.length === 1
                ? t('Close without saving? Your 1 unsaved change will be lost.')
                : interpolate(t('Close without saving? Your {count} unsaved changes will be lost.'), { count: formatCount(changedKeys.length) })}
              confirmLabel={t('Discard changes')}
              busyLabel={t('Discard changes')}
              busy={false}
              onConfirm={discardAndClose}
              onCancel={keepEditing}
            />
          )}
          <div className="settings-footer-main" hidden={!!closeQuestion}>
            <div className="settings-footer-state" id={footerLineId}>
              {(footerState === 'clean' || footerState === 'dirty') && (
                <p className={`settings-changes settings-changes--${footerState}`}>{footerWords}</p>
              )}
              <div className="save-status" role="status" aria-live="polite">
                {footerState === 'loading' && <span>{footerWords}</span>}
                {footerState === 'load-failed' && (
                  // G17: the plain words, the raw cause folded under Details in monospace, then Retry.
                  <span className="error" role="alert">
                    {footerWords}
                    {loadError && (
                      <details className="settings-error-details">
                        <summary>{t('Details')}</summary>
                        <pre>{loadError}</pre>
                      </details>
                    )}
                    <button type="button" onClick={onRetryLoad}>{t('Retry')}</button>
                  </span>
                )}
                {footerState === 'saving' && <span>{footerWords}</span>}
                {footerState === 'saved' && <span className="success"><CheckCircleIcon size={16} />{footerWords}</span>}
                {failureWords && footerState !== 'saving' && (
                  <span className="error">
                    {failureWords}
                    {saveStatus.reason && (
                      <details className="settings-error-details">
                        <summary>{t('Details')}</summary>
                        <pre>{translateSettingsStatus(saveStatus.reason, t)}</pre>
                      </details>
                    )}
                  </span>
                )}
              </div>
            </div>
            <button type="button" className="settings-cancel-btn" onClick={() => requestClose()}>{t('Cancel')}</button>
            <button
              type="button"
              className="save-btn btn-primary"
              onClick={handleSave}
              disabled={isSaving || !isLoaded}
              aria-disabled={!isDirty || undefined}
              aria-describedby={footerLineId}
            >
              {isSaving ? t('Saving...') : t('Save settings')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
