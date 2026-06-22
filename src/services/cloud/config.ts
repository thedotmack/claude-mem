import { join } from 'path';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { DATA_DIR } from '../../shared/paths.js';

/**
 * Cloud-sync config gate.
 *
 * SAFETY CONTRACT (Wave 1): the local write transaction must add <5ms and ZERO
 * network. The ONLY thing the hot path calls from this module is isCloudEnabled(),
 * which after the first call is a single cached boolean read — no fs, no JSON parse,
 * no network. The config file is read at most once per process (lazily, on first
 * call) and the result is memoized. A missing/corrupt file = disabled (default off).
 *
 * Cloud sync is OFF by default. Wave 1 never enables it.
 */

export const CLOUD_CONFIG_PATH = join(DATA_DIR, 'cloud-config.json');

export const DEFAULT_CLOUD_BASE_URL = 'https://cmem.ai';

/**
 * Persisted cloud config. The ONLY hot-path-relevant field is `enabled`. The
 * rest (identity, token, sync cursors) are read by the Wave-2 sync engine which
 * runs out-of-band of the write hot path.
 *
 * SECURITY: `setupToken` is a secret. It is ONLY ever read from this file (or
 * stdin at connect) and is NEVER logged.
 */
export interface CloudConfig {
  enabled: boolean;
  apiBaseUrl?: string;
  userId?: string;
  deviceId?: string;
  setupToken?: string;
  lastAckAt?: number;
  /** Persisted backfill state (Wave 2). */
  backfillDone?: boolean;
  /** Descending cursor per kind: highest local_id already enqueued for backfill. */
  backfillCursor?: { observation?: number; summary?: number; prompt?: number };
}

let cachedEnabled: boolean | null = null;

function readEnabledFromDisk(): boolean {
  try {
    if (!existsSync(CLOUD_CONFIG_PATH)) {
      return false;
    }
    const raw = JSON.parse(readFileSync(CLOUD_CONFIG_PATH, 'utf-8')) as Partial<CloudConfig>;
    return raw.enabled === true;
  } catch {
    // Missing or corrupt file => disabled. Never throw on the gate check.
    return false;
  }
}

/**
 * Returns whether cloud sync is enabled. The disk read happens at most once per
 * process; every subsequent call returns the cached boolean. This is the ONLY
 * function the write hot path may call, and it must never touch the network or
 * (after the first call) the filesystem.
 */
export function isCloudEnabled(): boolean {
  if (cachedEnabled === null) {
    cachedEnabled = readEnabledFromDisk();
  }
  return cachedEnabled;
}

/**
 * Test/util hook: force the cached value (or clear it with null to re-read on next
 * call). NOT used by production code paths.
 */
export function __setCloudEnabledForTest(value: boolean | null): void {
  cachedEnabled = value;
}

/**
 * Read the full persisted cloud config. Returns a default (disabled) shape when
 * the file is missing/corrupt. NOT on the write hot path — used only by the sync
 * engine and the /api/cloud routes.
 */
export function readCloudConfig(): CloudConfig {
  try {
    if (!existsSync(CLOUD_CONFIG_PATH)) return { enabled: false };
    const raw = JSON.parse(readFileSync(CLOUD_CONFIG_PATH, 'utf-8')) as Partial<CloudConfig>;
    return { enabled: raw.enabled === true, ...raw };
  } catch {
    return { enabled: false };
  }
}

/**
 * Merge `partial` into the on-disk config and persist with mode 0600 (owner R/W
 * only) because it holds the setup token. Also refreshes the cached `enabled`
 * gate so a connect/disconnect takes effect without a process restart.
 */
export function writeCloudConfig(partial: Partial<CloudConfig>): CloudConfig {
  const current = readCloudConfig();
  const next: CloudConfig = { ...current, ...partial };
  const dir = dirname(CLOUD_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Write then chmod 600. (writeFileSync mode arg is masked by umask; chmod is explicit.)
  writeFileSync(CLOUD_CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  try {
    chmodSync(CLOUD_CONFIG_PATH, 0o600);
  } catch {
    // chmod may be unsupported on some filesystems (e.g. Windows) — best effort.
  }
  // Keep the cached gate in sync with what we just persisted.
  cachedEnabled = next.enabled === true;
  return next;
}

/**
 * Stable per-install device id. Minted (uuid) and persisted on first request so
 * every device a user connects gets a distinct X-Device-Id.
 */
export function getDeviceId(): string {
  const cfg = readCloudConfig();
  if (cfg.deviceId) return cfg.deviceId;
  const deviceId = randomUUID();
  writeCloudConfig({ deviceId });
  return deviceId;
}

/**
 * Resolve the cloud API base URL. Precedence:
 *   env CLAUDE_MEM_CLOUD_URL  >  config.apiBaseUrl  >  https://cmem.ai
 * Trailing slash is stripped so callers can concatenate `${base}/api/...`.
 */
export function getApiBaseUrl(): string {
  const fromEnv = process.env.CLAUDE_MEM_CLOUD_URL?.trim();
  const fromConfig = readCloudConfig().apiBaseUrl?.trim();
  const base = fromEnv || fromConfig || DEFAULT_CLOUD_BASE_URL;
  return base.replace(/\/+$/, '');
}
