/**
 * Whether claude-mem's install looks half-written, by checks the SessionStart
 * launcher can make cheaply with file reads. An automatic update that a reboot
 * cut off is worth a notice only when one of them finds something
 * (auto-update-state-file.ts autoUpdateBrokenInstall); otherwise the worker's
 * check records how the attempt ended (auto-update-check.ts gate 3).
 *
 *  - The folder Claude Code loads claude-mem from, the installPath of each
 *    user-scope entry install.ts registerPlugin writes into
 *    installed_plugins.json, is missing; or has no node_modules (the installer
 *    copies that folder in "Caching plugin version" and installs its
 *    dependencies only in the later "Setting up runtime" step); or carries
 *    .orphaned_at, Claude Code's marker for a folder it replaced, which every
 *    resolver skips (worker-utils.ts cacheWorkerScriptCandidates).
 *  - The marketplace copy exists but has no plugin/scripts/worker-service.cjs.
 *    The installer removes and recopies plugin/ there
 *    (install.ts copyPluginToMarketplace), and that is the script the
 *    resolver, the installer's worker start, Pi and DSH start.
 *
 * Its own module with only node and the light Claude Code paths beneath it,
 * so the launcher (plain node, a small bundle) can include it.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { readUserScopeClaudeMemInstallPaths } from '../../shared/claude-code-plugin-paths.js';

/** Claude Code's marker for a superseded cache version (its content is epoch ms), which every resolver skips. */
export const ORPHANED_MARKER_FILENAME = '.orphaned_at';

/** Where the checks look: the paths in Claude Code's config directory (claude-code-plugin-paths.ts). */
export interface ClaudeMemInstallLocations {
  installedPluginsPath: string;
  marketplaceDirectory: string;
}

export type ClaudeMemInstallShape =
  | { kind: 'looks-whole' }
  /** `what` says, in plain words, the first thing found half-written. */
  | { kind: 'looks-half-written'; what: string }
  /**
   * installed_plugins.json exists but does not parse, so the folder Claude
   * Code loads claude-mem from cannot be checked, and nothing else looked
   * half-written. Not counted as half-written: the installer's registerPlugin
   * refuses that file too (readJsonSafe), so its fix command would not help.
   */
  | { kind: 'registration-unreadable'; problem: string };

export function readClaudeMemInstallShape(locations: ClaudeMemInstallLocations): ClaudeMemInstallShape {
  let registrationProblem: string | null = null;
  let installPaths: string[] = [];
  try {
    installPaths = readUserScopeClaudeMemInstallPaths(locations.installedPluginsPath);
  } catch (error: unknown) {
    registrationProblem = error instanceof Error ? error.message : String(error);
  }
  for (const installPath of installPaths) {
    const loadedFrom = `the folder Claude Code loads claude-mem from (${installPath})`;
    if (!existsSync(installPath)) return { kind: 'looks-half-written', what: `${loadedFrom} is missing` };
    if (!existsSync(join(installPath, 'node_modules'))) return { kind: 'looks-half-written', what: `${loadedFrom} has no node_modules` };
    if (existsSync(join(installPath, ORPHANED_MARKER_FILENAME))) {
      return { kind: 'looks-half-written', what: `${loadedFrom} is marked as replaced (${ORPHANED_MARKER_FILENAME})` };
    }
  }
  const marketplaceWorkerScript = join(locations.marketplaceDirectory, 'plugin', 'scripts', 'worker-service.cjs');
  if (existsSync(locations.marketplaceDirectory) && !existsSync(marketplaceWorkerScript)) {
    return { kind: 'looks-half-written', what: `claude-mem's marketplace copy (${locations.marketplaceDirectory}) has no plugin/scripts/worker-service.cjs` };
  }
  return registrationProblem === null ? { kind: 'looks-whole' } : { kind: 'registration-unreadable', problem: registrationProblem };
}
