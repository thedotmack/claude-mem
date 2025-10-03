import { readSettings } from './settings.js';

export interface RollingSettings {
  captureEnabled: boolean;
  summaryEnabled: boolean;
  sessionStartEnabled: boolean;
  chunkTokenLimit: number;
  chunkOverlapTokens: number;
  summaryTurnLimit: number;
}

const DEFAULTS: RollingSettings = {
  captureEnabled: true,
  summaryEnabled: true,
  sessionStartEnabled: true,
  chunkTokenLimit: 600,
  chunkOverlapTokens: 200,
  summaryTurnLimit: 20
};

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function getRollingSettings(): RollingSettings {
  const settings = readSettings();

  return {
    captureEnabled: normalizeBoolean(
      settings.rollingCaptureEnabled,
      DEFAULTS.captureEnabled
    ),
    summaryEnabled: normalizeBoolean(
      settings.rollingSummaryEnabled,
      DEFAULTS.summaryEnabled
    ),
    sessionStartEnabled: normalizeBoolean(
      settings.rollingSessionStartEnabled,
      DEFAULTS.sessionStartEnabled
    ),
    chunkTokenLimit: normalizeNumber(
      settings.rollingChunkTokens,
      DEFAULTS.chunkTokenLimit
    ),
    chunkOverlapTokens: normalizeNumber(
      settings.rollingChunkOverlapTokens,
      DEFAULTS.chunkOverlapTokens
    ),
    summaryTurnLimit: normalizeNumber(
      settings.rollingSummaryTurnLimit,
      DEFAULTS.summaryTurnLimit
    )
  };
}

export function isRollingCaptureEnabled(): boolean {
  return getRollingSettings().captureEnabled;
}

export function isRollingSummaryEnabled(): boolean {
  return getRollingSettings().summaryEnabled;
}

export function isRollingSessionStartEnabled(): boolean {
  return getRollingSettings().sessionStartEnabled;
}
