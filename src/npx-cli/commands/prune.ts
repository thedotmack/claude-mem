/**
 * `npx claude-mem prune` — remove superseded plugin cache versions. Auto-update
 * keeps every version ever installed under the plugin cache, one runnable
 * old-version worker source per release, which wastes disk and lets a stale
 * worker act on the shared database (#4105). The installer prunes on every
 * install; this command exposes the same routine on demand, beside `doctor`.
 *
 * Keeps the newest two versions and whatever version the live worker reports,
 * so it never removes the directory a running worker was launched from.
 * `--dry-run` reports the plan without deleting. `--keep <n>` overrides how many
 * newest versions to retain.
 */

import { styleText } from 'node:util';
import { pluginCacheRootDirectory } from '../utils/paths.js';
import {
  DEFAULT_CACHE_RETENTION,
  fetchLiveWorkerVersion,
  planCachePrune,
  prunePluginCache,
  readCacheVersionDirectories,
} from '../utils/prune-cache.js';

function parseKeepCount(argv: string[]): number {
  const index = argv.indexOf('--keep');
  if (index === -1) return DEFAULT_CACHE_RETENTION;
  const raw = argv[index + 1];
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.error(styleText('red', `Invalid --keep value: ${raw ?? '(missing)'}. Use a positive integer.`));
    process.exit(1);
  }
  return parsed;
}

export async function runPruneCommand(argv: string[] = []): Promise<void> {
  const dryRun = argv.includes('--dry-run');
  const keepCount = parseKeepCount(argv);
  const root = pluginCacheRootDirectory();

  const liveVersion = await fetchLiveWorkerVersion();
  const protectedVersions = liveVersion ? [liveVersion] : [];

  console.log(styleText('bold', '\nclaude-mem prune\n'));
  console.log(`  ${styleText('dim', 'Cache root:')} ${root}`);
  console.log(`  ${styleText('dim', 'Keeping:')}   newest ${keepCount}${liveVersion ? ` + live worker v${liveVersion}` : ''}`);

  if (dryRun) {
    const { keep, prune } = planCachePrune(readCacheVersionDirectories(root), keepCount, protectedVersions);
    console.log(`  ${styleText('dim', 'Keep:')}      ${keep.length > 0 ? keep.join(', ') : '(none)'}`);
    console.log(`  ${styleText('yellow', 'Would remove:')} ${prune.length > 0 ? prune.join(', ') : '(none)'}`);
    console.log(styleText('dim', '\nDry run — nothing was deleted.'));
    return;
  }

  const result = prunePluginCache({ cacheRoot: root, keepCount, protectedVersions });
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
