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

  const workerHost =
    process.env.CMEM_WORKER_HOST ||
    process.env.CLAUDE_MEM_WORKER_HOST ||
    settings.CMEM_WORKER_HOST ||
    settings.CLAUDE_MEM_WORKER_HOST ||
    DEFAULTS.host;

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

  return {
    workerHost,
    workerPort,
    baseUrl: `http://${workerHost}:${workerPort}`,
    dataDir,
  };
}
