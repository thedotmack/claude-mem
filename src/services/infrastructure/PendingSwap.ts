import { chmodSync, existsSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const SWAP_SUFFIX = '.importing';

/** The `.env` file holds ANTHROPIC_API_KEY and friends — it must never land on
 * disk world-readable. EnvManager.saveEnvFile() is the canonical writer and
 * chmods 0600; every restore path has to match it, because renameSync carries
 * the STAGED file's mode over to the real target. */
const ENV_BASENAME = '.env';
const ENV_MODE = 0o600;

/** SQLite sidecars for the main database. A `-wal`/`-shm` left over from a
 * different db era is not merely useless, it is dangerous: SQLite will replay
 * its frames into whatever `claude-mem.db` it finds next to it. */
const DB_BASENAME = 'claude-mem.db';
const DB_SIDECARS = [`${DB_BASENAME}-wal`, `${DB_BASENAME}-shm`];

export function stagePendingSwap(basename: string, data: Buffer): void {
  const stagedPath = path.join(paths.dataDir(), `${basename}${SWAP_SUFFIX}`);
  writeFileSync(stagedPath, data, basename === ENV_BASENAME ? { mode: ENV_MODE } : undefined);
  if (basename === ENV_BASENAME) {
    // writeFileSync's `mode` only applies when the file is CREATED — restaging
    // over an existing `.env.importing` would keep the old (possibly 0644)
    // mode. chmod unconditionally so the staged file, and therefore the
    // renamed target, is always 0600.
    chmodSync(stagedPath, ENV_MODE);
  }
  logger.info('SYSTEM', 'Staged pending file swap', { basename });
}

export function applyPendingSwaps(): string[] {
  const dataDir = paths.dataDir();
  if (!existsSync(dataDir)) return [];

  const staged = readdirSync(dataDir).filter(name => name.endsWith(SWAP_SUFFIX));
  const swapped: string[] = [];

  for (const stagedName of staged) {
    const basename = stagedName.slice(0, -SWAP_SUFFIX.length);
    const stagedPath = path.join(dataDir, stagedName);
    const targetPath = path.join(dataDir, basename);
    renameSync(stagedPath, targetPath);
    if (basename === ENV_BASENAME) {
      // Belt-and-braces: rename normally preserves the staged file's mode, but
      // a `.env` that ends up world-readable leaks API keys, so re-assert it on
      // the real target rather than trusting the platform's rename semantics.
      chmodSync(targetPath, ENV_MODE);
    }
    swapped.push(basename);
    logger.info('SYSTEM', 'Applied pending file swap', { basename });
  }

  // A restore that swapped in a fresh `claude-mem.db` but did NOT also bring
  // its own `-wal`/`-shm` (the exporter skips them when there is no checkpoint
  // pending) must not leave the PREVIOUS database's sidecars sitting next to
  // the new file: SQLite would replay those stale/foreign frames into the fresh
  // db on next open, silently corrupting it. Sidecars restored as part of this
  // same batch are consistent with the new db and are kept.
  if (swapped.includes(DB_BASENAME)) {
    for (const sidecar of DB_SIDECARS) {
      if (swapped.includes(sidecar)) continue;
      const sidecarPath = path.join(dataDir, sidecar);
      if (!existsSync(sidecarPath)) continue;
      rmSync(sidecarPath, { force: true });
      logger.info('SYSTEM', 'Removed stale sqlite sidecar orphaned by database restore', {
        basename: sidecar,
      });
    }
  }

  return swapped;
}
