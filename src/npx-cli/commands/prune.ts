/**
 * `npx claude-mem prune` — remove superseded plugin cache versions. Auto-update
 * keeps every version ever installed under the plugin cache, one runnable
 * old-version worker source per release, which wastes disk and lets a stale
 * worker act on the shared database (#4105). The installer prunes on every
 * install; this command exposes the same routine on demand, beside `doctor`.
 *
 * Keeps the newest two usable versions and whatever version a live worker
 * reports, so it never removes the directory a running worker was launched
 * from. When a worker is present but its version cannot be read, every version
 * is retained. `--dry-run` reports the plan without deleting. `--keep <n>`
 * overrides how many newest usable versions to retain.
 */

import { styleText } from 'node:util';
import { pluginCacheRootDirectory } from '../utils/paths.js';
import {
  DEFAULT_CACHE_RETENTION,
  planPluginCachePrune,
  prunePluginCacheSafely,
  resolveWorkerProtection,
} from '../utils/prune-cache.js';

const USAGE = 'Usage: npx claude-mem prune [--dry-run] [--keep <n>]';

interface PruneArgs {
  dryRun: boolean;
  keepCount: number;
}

/**
 * Parse the argument list strictly: reject any unknown flag and require `--keep`
 * to be a whole positive integer. A permissive parser turned a typo like
 * `--dry-rnu` into a real deletion and let `--keep 2junk` through as 2 (#4105
 * review), so an unrecognized argument must abort before anything is removed.
 */
function parseArgs(argv: string[]): PruneArgs {
  let dryRun = false;
  let keepCount = DEFAULT_CACHE_RETENTION;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--keep') {
      const raw = argv[++i];
      if (raw === undefined || !/^\d+$/.test(raw) || Number.parseInt(raw, 10) < 1) {
        console.error(styleText('red', `Invalid --keep value: ${raw ?? '(missing)'}. Use a whole positive integer.`));
        console.error(USAGE);
        process.exit(1);
      }
      keepCount = Number.parseInt(raw, 10);
    } else {
      console.error(styleText('red', `Unknown argument: ${arg}`));
      console.error(USAGE);
      process.exit(1);
    }
  }

  return { dryRun, keepCount };
}

export async function runPruneCommand(argv: string[] = []): Promise<void> {
  const { dryRun, keepCount } = parseArgs(argv);
  const root = pluginCacheRootDirectory();

  console.log(styleText('bold', '\nclaude-mem prune\n'));
  console.log(`  ${styleText('dim', 'Cache root:')} ${root}`);
  console.log(`  ${styleText('dim', 'Keeping:')}   newest ${keepCount} usable version(s)`);

  if (dryRun) {
    const { protectedVersions, retainAll } = await resolveWorkerProtection();
    if (retainAll) {
      console.log(`  ${styleText('yellow', 'Would remove:')} (none — a worker is running but its version could not be read)`);
      console.log(styleText('dim', '\nDry run — nothing was deleted.'));
      return;
    }
    const { keep, prune } = planPluginCachePrune(root, keepCount, protectedVersions);
    if (protectedVersions.length > 0) {
      console.log(`  ${styleText('dim', 'Live worker:')} protecting v${protectedVersions.join(', ')}`);
    }
    console.log(`  ${styleText('dim', 'Keep:')}      ${keep.length > 0 ? keep.join(', ') : '(none)'}`);
    console.log(`  ${styleText('yellow', 'Would remove:')} ${prune.length > 0 ? prune.join(', ') : '(none)'}`);
    console.log(styleText('dim', '\nDry run — nothing was deleted.'));
    return;
  }

  const result = await prunePluginCacheSafely({ cacheRoot: root, keepCount });
  if (result.retainedForLiveWorker) {
    console.log(styleText('yellow', '\nA worker is running but its version could not be read — retained all versions.'));
    return;
  }
  console.log(`  ${styleText('dim', 'Kept:')}      ${result.kept.length > 0 ? result.kept.join(', ') : '(none)'}`);
  if (result.removed.length > 0) {
    console.log(`  ${styleText('green', 'Removed:')}   ${result.removed.join(', ')}`);
  } else {
    console.log(`  ${styleText('dim', 'Removed:')}   (none)`);
  }
  for (const failure of result.failed) {
    console.log(`  ${styleText('yellow', '!')} Could not remove ${failure.version}: ${failure.reason}`);
  }
  console.log('');
  console.log(styleText('green', `Pruned ${result.removed.length} stale version(s).`));
}
