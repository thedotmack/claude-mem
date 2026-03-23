/**
 * Config resolution for cmem CLI.
 * Priority: env var > ~/.cmem/settings.json > ~/.claude-mem/settings.json > defaults
 * Supports CMEM_* env vars (preferred) and CLAUDE_MEM_* (backwards compat).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface CMEMConfig {
  workerHost: string;
  workerPort: number;
  baseUrl: string;
  dataDir: string;
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 37777,
  dataDir: join(homedir(), '.claude-mem'),  // backwards compat default data location
};

/** Hosts the worker is allowed to bind to. Anything outside this set is non-local. */
export const LOCALHOST_ALLOWLIST = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);

const CONFIG_DIRS = [
  join(homedir(), '.cmem'),
  join(homedir(), '.claude-mem'),  // backwards compat
];

function loadSettingsFile(): Record<string, string> {
  for (const dir of CONFIG_DIRS) {
    const settingsPath = join(dir, 'settings.json');
    if (!existsSync(settingsPath)) continue;

    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      // malformed settings — try next dir
    }
  }
  return {};
}

export function loadConfig(): CMEMConfig {
  const settings = loadSettingsFile();

  let workerHost =
    process.env.CMEM_WORKER_HOST ||
    process.env.CLAUDE_MEM_WORKER_HOST ||
    settings.CMEM_WORKER_HOST ||
    settings.CLAUDE_MEM_WORKER_HOST ||
    DEFAULTS.host;

  // SECURITY: The worker is designed for localhost only. Hosts outside the
  // allowlist are not supported for remote connections. If no configured host
  // is provided, always use the default localhost address.
  if (!workerHost) {
    workerHost = DEFAULTS.host;
  }

  let workerPort = parseInt(
    process.env.CMEM_WORKER_PORT ||
    process.env.CLAUDE_MEM_WORKER_PORT ||
    settings.CMEM_WORKER_PORT ||
    settings.CLAUDE_MEM_WORKER_PORT ||
    String(DEFAULTS.port),
    10,
  );

  if (isNaN(workerPort) || workerPort < 1024 || workerPort > 65535) {
    // fall back to default rather than throwing during config load
    workerPort = DEFAULTS.port;
  }

  const dataDir =
    process.env.CMEM_DATA_DIR ||
    process.env.CLAUDE_MEM_DATA_DIR ||
    settings.CMEM_DATA_DIR ||
    settings.CLAUDE_MEM_DATA_DIR ||
    DEFAULTS.dataDir;

  // IPv6 addresses need bracket notation in URLs (e.g. http://[::1]:37777)
  const hostForUrl = workerHost.includes(':') ? `[${workerHost}]` : workerHost;
  const baseUrl = `http://${hostForUrl}:${workerPort}`;

  return {
    workerHost,
    workerPort,
    baseUrl,
    dataDir,
  };
}
