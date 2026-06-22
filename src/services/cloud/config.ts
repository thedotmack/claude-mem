import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
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

export interface CloudConfig {
  enabled: boolean;
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
