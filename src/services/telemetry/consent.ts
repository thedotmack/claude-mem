import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { resolveDataDir } from '../../shared/paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';

export type TelemetryConfig = {
  /** Explicit user decision. Absent = no decision recorded; the opt-out default applies. */
  enabled?: boolean;
  installId: string;
  decidedAt: string;
};

const TELEMETRY_CONFIG_FILENAME = 'telemetry.json';

/**
 * DO_NOT_TRACK convention (consoledonottrack.com): the variable counts as
 * "set" when it has any non-empty value other than '0' or 'false'.
 */
function isDoNotTrackSet(env: NodeJS.ProcessEnv): boolean {
  const value = env.DO_NOT_TRACK;
  if (value === undefined || value === '') return false;
  return value !== '0' && value !== 'false';
}

/** Which layer of the precedence chain decided the consent outcome. */
export type TelemetryConsentSource = 'DO_NOT_TRACK' | 'env' | 'config' | 'default';

export type TelemetryConsentExplanation = {
  enabled: boolean;
  source: TelemetryConsentSource;
};

/**
 * Resolves whether telemetry is allowed AND which layer decided it.
 * Pure function — no I/O.
 *
 * Precedence (first match wins):
 * 1. DO_NOT_TRACK set (truthy) -> always off
 * 2. CLAUDE_MEM_TELEMETRY env: '0'/'false'/'off' -> off, '1'/'true'/'on' -> on
 * 3. telemetry.json config: enabled === true -> on, enabled === false -> off
 * 4. Default: on (opt-out — anonymous events only; see docs.claude-mem.ai/telemetry)
 */
export function explainTelemetryConsent(
  env: NodeJS.ProcessEnv,
  config: TelemetryConfig | null
): TelemetryConsentExplanation {
  if (isDoNotTrackSet(env)) return { enabled: false, source: 'DO_NOT_TRACK' };

  const override = env.CLAUDE_MEM_TELEMETRY?.toLowerCase();
  if (override === '0' || override === 'false' || override === 'off') {
    return { enabled: false, source: 'env' };
  }
  if (override === '1' || override === 'true' || override === 'on') {
    return { enabled: true, source: 'env' };
  }

  if (config?.enabled === true) return { enabled: true, source: 'config' };
  if (config?.enabled === false) return { enabled: false, source: 'config' };

  return { enabled: true, source: 'default' };
}

/**
 * Resolves whether telemetry is allowed. Pure function — no I/O.
 * Thin wrapper over explainTelemetryConsent.
 */
export function resolveTelemetryConsent(
  env: NodeJS.ProcessEnv,
  config: TelemetryConfig | null
): boolean {
  return explainTelemetryConsent(env, config).enabled;
}

/** Absolute path of telemetry.json inside the claude-mem data dir. */
export function getTelemetryConfigPath(): string {
  return join(resolveDataDir(), TELEMETRY_CONFIG_FILENAME);
}

/**
 * Reads telemetry.json from the data dir. Returns null if the file is
 * missing, corrupt, or malformed — never throws.
 */
export function loadTelemetryConfig(): TelemetryConfig | null {
  try {
    const raw = readJsonSafe<Partial<TelemetryConfig> | null>(getTelemetryConfigPath(), null);
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.installId !== 'string') return null;
    // enabled may be absent (no decision recorded — default applies), but a
    // present non-boolean value means the file is malformed.
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return null;
    return {
      enabled: raw.enabled,
      installId: raw.installId,
      decidedAt: typeof raw.decidedAt === 'string' ? raw.decidedAt : '',
    };
  } catch {
    // Corrupt JSON — treat as no recorded consent
    return null;
  }
}

export function saveTelemetryConfig(config: TelemetryConfig): void {
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, TELEMETRY_CONFIG_FILENAME), JSON.stringify(config, null, 2) + '\n');
}

/**
 * Returns the stable anonymous install ID, generating and persisting one on
 * first use. Records ONLY the ID — never a consent decision — so the opt-out
 * default (and any future default change) still applies to this install.
 */
export function getOrCreateInstallId(): string {
  const existing = loadTelemetryConfig();
  if (existing?.installId) return existing.installId;

  const installId = randomUUID();
  saveTelemetryConfig({
    installId,
    decidedAt: '',
  });
  return installId;
}
