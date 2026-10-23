import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_CONFIG_DIR } from './paths.js';

/**
 * Where Claude Code says the thedotmack marketplace lives. A marketplace added
 * from a local folder (`/plugin marketplace add <path>`) stays at that path, and
 * Claude Code records it as `thedotmack.installLocation` in
 * `plugins/known_marketplaces.json`. Returns null when the file is missing,
 * malformed, or has no such entry, so callers fall back to the fixed paths.
 */
export function knownMarketplaceInstallLocation(claudeConfigDirectory: string = CLAUDE_CONFIG_DIR): string | null {
  try {
    const knownMarketplaces = JSON.parse(
      readFileSync(join(claudeConfigDirectory, 'plugins', 'known_marketplaces.json'), 'utf-8'),
    );
    const installLocation = knownMarketplaces?.thedotmack?.installLocation;
    return typeof installLocation === 'string' && installLocation ? installLocation : null;
  } catch {
    return null;
  }
}

/**
 * Every directory the thedotmack marketplace may live in: the default and XDG
 * marketplace roots, plus the installLocation Claude Code recorded, if any.
 */
export function marketplaceDirectoryCandidates(
  homeDirectory: string = homedir(),
  claudeConfigDirectory: string = CLAUDE_CONFIG_DIR,
): string[] {
  const candidates = [
    join(homeDirectory, '.claude', 'plugins', 'marketplaces', 'thedotmack'),
    join(homeDirectory, '.config', 'claude', 'plugins', 'marketplaces', 'thedotmack'),
  ];
  const installLocation = knownMarketplaceInstallLocation(claudeConfigDirectory);
  if (installLocation) candidates.push(installLocation);
  return candidates;
}
