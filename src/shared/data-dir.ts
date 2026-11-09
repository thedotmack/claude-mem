import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { readJsonFileWithBom } from './atomic-json.js';
import { expandHome } from './expand-home.js';
import { settingsTarget } from './settings-document.js';

/**
 * The data directory: CLAUDE_MEM_DATA_DIR from the environment, else the one
 * ~/.claude-mem/settings.json names, else ~/.claude-mem. The one rule; paths.ts
 * re-exports it and freezes DATA_DIR from it.
 *
 * Its own module, with only node and the JSON and settings-document readers
 * beneath it, so the SessionStart launcher (src/launcher/ensure-launcher.ts,
 * plain node, a small bundle) finds the auto-update state file in the same
 * place as the worker without importing paths.ts, which loads
 * SettingsDefaultsManager.
 */
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
