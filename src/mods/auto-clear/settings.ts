/**
 * Settings for the auto-clear mod, read the way SettingsDefaultsManager reads
 * them (environment variable, then settings.json, then the default) but with
 * no Node imports: a Claude Code hooks module has no `fs`, `os` or `path`.
 */
import { isSettingsRecord, settingsTarget, type SettingsDocument } from '../../shared/settings-document-shape.js';
import { isWorkStateEnabled } from '../../shared/work-state-setting.js';

export const AUTO_CLEAR_DEFAULT_PERCENT = 33;
export const AUTO_CLEAR_MIN_PERCENT = 1;
export const AUTO_CLEAR_MAX_PERCENT = 95;

export interface AutoClearSettings {
  /** CLAUDE_MEM_AUTO_CLEAR_ENABLED is 'true' (it ships off) and CLAUDE_MEM_WORK_STATE_ENABLED is on. */
  enabled: boolean;
  /** Context window use, in whole percent, that starts the auto-clear. */
  percent: number;
}

/** The raw values: each environment variable as the process has it, and settings.json once parsed. */
export interface AutoClearSettingsSources {
  env: {
    CLAUDE_MEM_AUTO_CLEAR_ENABLED?: string;
    CLAUDE_MEM_AUTO_CLEAR_PERCENT?: string;
    CLAUDE_MEM_WORK_STATE_ENABLED?: string;
  };
  document: SettingsDocument | null;
}

/** settings.json text to a document, or null when it is not a JSON object. A leading BOM is dropped, as readJsonFileWithBom does. */
export function parseSettingsJson(text: string): SettingsDocument | null {
  try {
    const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''));
    return isSettingsRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** One key: the environment wins, then the document (flat or nested), then undefined. */
function settingValue(sources: AutoClearSettingsSources, key: keyof AutoClearSettingsSources['env']): string | undefined {
  const fromEnv = sources.env[key];
  if (fromEnv !== undefined) return fromEnv;
  if (!sources.document) return undefined;
  const value = settingsTarget(sources.document)[key];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

/** A percent from 1 to 95; anything else falls back to the default. */
export function parseAutoClearPercent(value: string | undefined): number {
  const percent = Number(String(value ?? '').trim());
  if (!Number.isFinite(percent) || percent < AUTO_CLEAR_MIN_PERCENT || percent > AUTO_CLEAR_MAX_PERCENT) {
    return AUTO_CLEAR_DEFAULT_PERCENT;
  }
  return percent;
}

export function resolveAutoClearSettings(sources: AutoClearSettingsSources): AutoClearSettings {
  // Opt-in: only an explicit 'true' turns it on.
  const autoClearOn = String(settingValue(sources, 'CLAUDE_MEM_AUTO_CLEAR_ENABLED') ?? 'false').trim().toLowerCase() === 'true';
  const workStateOn = isWorkStateEnabled(settingValue(sources, 'CLAUDE_MEM_WORK_STATE_ENABLED'));
  return {
    enabled: autoClearOn && workStateOn,
    percent: parseAutoClearPercent(settingValue(sources, 'CLAUDE_MEM_AUTO_CLEAR_PERCENT')),
  };
}

/** `~` and `~/…` against the home directory; on Windows `~\…` too. Other paths are returned as they are. */
export function expandHomePath(path: string, home: string | undefined): string {
  if (!home) return path;
  if (path === '~') return home;
  if (path.startsWith('~/') || path.startsWith('~\\')) return joinPath(home, path.slice(2));
  return path;
}

export function joinPath(directory: string, name: string): string {
  return `${directory.replace(/[\\/]+$/, '')}/${name}`;
}

/** The data directory before settings.json is read: CLAUDE_MEM_DATA_DIR when set, else ~/.claude-mem. Null with neither. */
export function defaultDataDir(envDataDir: string | undefined, home: string | undefined): string | null {
  if (envDataDir) return expandHomePath(envDataDir, home);
  return home ? joinPath(home, '.claude-mem') : null;
}

/**
 * Where the settings live after the home settings.json is read: a data
 * directory that file names (CLAUDE_MEM_DATA_DIR inside it) moves them, as
 * resolveDataDir in shared/paths.ts does. An environment variable already won
 * in defaultDataDir, so the file is not consulted then.
 */
export function redirectedDataDir(
  homeDocument: SettingsDocument | null,
  envDataDir: string | undefined,
  home: string | undefined,
): string | null {
  if (envDataDir || !homeDocument) return null;
  const configured = settingsTarget(homeDocument).CLAUDE_MEM_DATA_DIR;
  if (typeof configured !== 'string' || configured.trim() === '') return null;
  const expanded = expandHomePath(configured.trim(), home);
  const fallback = defaultDataDir(undefined, home);
  return fallback !== null && expanded.replace(/[\\/]+$/, '') === fallback ? null : expanded;
}
