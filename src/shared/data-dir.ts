import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { readJsonFileWithBom } from './atomic-json.js';
import { settingsTarget } from './settings-document.js';
import { expandHome } from './expand-home.js';

// Shared with standalone harness plugins without loading worker paths/settings.
export function resolveDataDir(): string {
  if (process.env.CLAUDE_MEM_DATA_DIR) {
    return expandHome(process.env.CLAUDE_MEM_DATA_DIR);
  }

  const defaultDataDir = join(homedir(), '.claude-mem');
  const settingsPath = join(defaultDataDir, 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      const raw = readJsonFileWithBom<unknown>(settingsPath);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return defaultDataDir;
      const settings = settingsTarget(raw as Record<string, unknown>);
      if (typeof settings.CLAUDE_MEM_DATA_DIR === 'string' && settings.CLAUDE_MEM_DATA_DIR) {
        return expandHome(settings.CLAUDE_MEM_DATA_DIR);
      }
    }
  } catch {
    // settings file missing or corrupt — fall through to default
  }

  return defaultDataDir;
}

