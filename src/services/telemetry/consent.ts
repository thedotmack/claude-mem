import { join } from 'path';
import { mkdirSync, rmdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { resolveDataDir } from '../../shared/paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { logger } from '../../utils/logger.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';

export type TelemetryConfig = {
  /** Explicit user decision. Absent = no decision recorded; the opt-out default applies. */
  enabled?: boolean;
  installId: string;
  /**
   * Distinct id for worker and plugin events that must not create a person.
   * Never the install id: that id receives `$set` from install events, and
   * PostHog then bills every later event for it as identified.
   */
  anonymousId?: string;
  decidedAt: string;
  /** First-session disclosure only; displaying it is not a consent decision. */
  noticeShownAt?: string;
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

/**
 * Error-tracking kill-switch, INDEPENDENT of the analytics consent chain above.
 *
 * `CLAUDE_MEM_TELEMETRY_ERRORS=0` (or 'false'/'off') disables real exception
 * capture ($exception with redacted message/stack) WITHOUT touching analytics:
 * an operator who is fine with anonymous counters but not error text can opt out
 * of just the error path. Defaults ON whenever telemetry consent is on — error
 * capture is always additionally gated by the normal consent chain upstream, so
 * "consent off" already implies "no errors". Pure — no I/O.
 */
export function isErrorTelemetryEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.CLAUDE_MEM_TELEMETRY_ERRORS?.toLowerCase();
  if (value === '0' || value === 'false' || value === 'off') return false;
  return true;
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
  let raw: Partial<TelemetryConfig> | null;
  try {
    raw = readJsonSafe<Partial<TelemetryConfig> | null>(getTelemetryConfigPath(), null);
  } catch (error) {
    // Corrupt JSON — treat as no recorded consent
    const err = error instanceof Error ? error : new Error(String(error));
    logger.warn('SYSTEM', 'Telemetry: corrupt telemetry.json; treating as no recorded consent', undefined, err);
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.installId !== 'string') return null;
  // enabled may be absent (no decision recorded — default applies), but a
  // present non-boolean value means the file is malformed.
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return null;
  return {
    enabled: raw.enabled,
    installId: raw.installId,
    ...(typeof raw.anonymousId === 'string' && raw.anonymousId ? { anonymousId: raw.anonymousId } : {}),
    decidedAt: typeof raw.decidedAt === 'string' ? raw.decidedAt : '',
    ...(typeof raw.noticeShownAt === 'string' && raw.noticeShownAt ? { noticeShownAt: raw.noticeShownAt } : {}),
  };
}

/** Serialize the entire read/modify/write, including explicit consent changes. */
function withTelemetryConfigLock<T>(update: () => T): T {
  mkdirSync(resolveDataDir(), { recursive: true });
  const lock = `${getTelemetryConfigPath()}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // As with skill-selection's synchronous lock, never break another
      // process's claim or pretend that an explicit choice was saved.
      throw new Error(`Telemetry configuration is locked at ${lock}. Retry after the other command finishes; if an interrupted command left this empty directory, remove it and retry.`);
    }
    throw error;
  }
  try { return update(); } finally { rmdirSync(lock); }
}

function writeTelemetryConfig(config: TelemetryConfig): void {
  writeJsonFileAtomic(getTelemetryConfigPath(), config);
}

export function saveTelemetryConfig(config: TelemetryConfig): void {
  withTelemetryConfigLock(() => writeTelemetryConfig(config));
}

/**
 * Marketplace installs never run the installer's consent prompt. Disclose the
 * default once in their first user-visible session, using the existing config
 * to remember delivery. An explicit choice already answers the question.
 * Call immediately before returning the hook output, after asynchronous reads.
 */
export function consumeTelemetryNotice(): string | null {
  const eligible = (config: TelemetryConfig | null): boolean => {
    const consent = explainTelemetryConsent(process.env, config);
    return consent.enabled && consent.source === 'default' && !config?.noticeShownAt;
  };
  if (!eligible(loadTelemetryConfig())) return null;

  try {
    const recorded = withTelemetryConfigLock(() => {
      const current = loadTelemetryConfig();
      if (!eligible(current)) return false;
      writeTelemetryConfig({
        ...current,
        installId: current?.installId ?? '',
        decidedAt: current?.decidedAt ?? '',
        noticeShownAt: new Date().toISOString(),
      });
      return true;
    });
    if (!recorded) return null;
  } catch (error) {
    // This records a display, not a choice. A failed write must not discard
    // the session's context or hide the notice; a later session can record it.
    logger.warn('HOOK', 'Could not record the first-session telemetry disclosure', undefined,
      error instanceof Error ? error : new Error(String(error)));
    if (!eligible(loadTelemetryConfig())) return null;
  }
  return '[claude-mem] Telemetry is on by default: anonymous feature-usage, performance and token-count statistics, plus redacted error messages and stack traces. '
    + 'Turn it off: npx claude-mem telemetry disable, DO_NOT_TRACK=1, or CLAUDE_MEM_TELEMETRY=0. '
    + 'Details: https://docs.claude-mem.ai/telemetry';
}

/**
 * Records an explicit opt-in or opt-out and keeps every ID already saved.
 * Enabling creates an install ID when none exists; disabling never does.
 */
export function recordTelemetryDecision(enabled: boolean): void {
  withTelemetryConfigLock(() => {
    const existing = loadTelemetryConfig();
    writeTelemetryConfig({
      ...existing,
      enabled,
      installId: existing?.installId || (enabled ? randomUUID() : ''),
      decidedAt: new Date().toISOString(),
    });
  });
}

/**
 * Returns the stable anonymous install ID, generating and persisting one on
 * first use. Records ONLY the ID — never a consent decision — so the opt-out
 * default (and any future default change) still applies to this install.
 */
export function getOrCreateInstallId(): string {
  const existing = loadTelemetryConfig();
  if (existing?.installId) return existing.installId;
  return withTelemetryConfigLock(() => {
    const current = loadTelemetryConfig();
    if (current?.installId) return current.installId;
    const installId = randomUUID();
    writeTelemetryConfig({ ...current, installId, decidedAt: current?.decidedAt ?? '' });
    return installId;
  });
}

/**
 * Stable id for profile-less worker and plugin events. A second UUID, not the
 * install id, so `$set` on install/auth/trial/checkout/subscription cannot
 * make these events bill as identified.
 */
export function getOrCreateAnonymousDistinctId(): string {
  const existing = loadTelemetryConfig();
  if (existing?.anonymousId && existing.anonymousId !== existing.installId) return existing.anonymousId;
  return withTelemetryConfigLock(() => {
    const current = loadTelemetryConfig();
    if (current?.anonymousId && current.anonymousId !== current.installId) return current.anonymousId;
    const anonymousId = randomUUID();
    writeTelemetryConfig({ ...current, installId: current?.installId || randomUUID(), anonymousId, decidedAt: current?.decidedAt ?? '' });
    return anonymousId;
  });
}
