import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { resolveDataDir } from '../../shared/paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';

export type TelemetryConfig = {
  enabled: boolean;
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

/**
 * Resolves whether telemetry is allowed. Pure function — no I/O.
 *
 * Precedence (first match wins):
 * 1. DO_NOT_TRACK set (truthy) -> always off
 * 2. CLAUDE_MEM_TELEMETRY env: '0'/'false'/'off' -> off, '1'/'true'/'on' -> on
 * 3. telemetry.json config: enabled === true -> on
 * 4. Default: off
 */
export function resolveTelemetryConsent(
  env: NodeJS.ProcessEnv,
  config: TelemetryConfig | null
): boolean {
  if (isDoNotTrackSet(env)) return false;

  const override = env.CLAUDE_MEM_TELEMETRY?.toLowerCase();
  if (override === '0' || override === 'false' || override === 'off') return false;
  if (override === '1' || override === 'true' || override === 'on') return true;

  if (config?.enabled === true) return true;

  return false;
}

function getTelemetryConfigPath(): string {
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
    if (typeof raw.enabled !== 'boolean' || typeof raw.installId !== 'string') return null;
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
 * first use. Preserves any existing consent state; a freshly created config
 * defaults to enabled: false.
 */
export function getOrCreateInstallId(): string {
  const existing = loadTelemetryConfig();
  if (existing?.installId) return existing.installId;

  const installId = randomUUID();
  saveTelemetryConfig({
    enabled: existing?.enabled ?? false,
    installId,
    decidedAt: existing?.decidedAt || new Date().toISOString(),
  });
  return installId;
}
