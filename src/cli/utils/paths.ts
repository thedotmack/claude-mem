import { join } from 'path';
import { homedir } from 'os';

export const paths = {
  home: homedir(),
  claudeDir: join(homedir(), '.claude'),
  claudeMemDir: join(homedir(), '.claude-mem'),
  claudeSettings: join(homedir(), '.claude', 'settings.json'),
  claudeMemSettings: join(homedir(), '.claude-mem', 'settings.json'),
  database: join(homedir(), '.claude-mem', 'claude-mem.db'),
  logsDir: join(homedir(), '.claude-mem', 'logs'),
  pluginDir: join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack'),
};

export function getWorkerPort(): number {
  try {
    const { existsSync, readFileSync } = require('fs');
    if (existsSync(paths.claudeMemSettings)) {
      const settings = JSON.parse(readFileSync(paths.claudeMemSettings, 'utf-8'));
      return parseInt(settings.CLAUDE_MEM_WORKER_PORT, 10) || 37777;
    }
  } catch { /* ignore */ }
  return 37777;
}
