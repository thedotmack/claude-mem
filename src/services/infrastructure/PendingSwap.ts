import { existsSync, readdirSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const SWAP_SUFFIX = '.importing';

export function stagePendingSwap(basename: string, data: Buffer): void {
  const stagedPath = path.join(paths.dataDir(), `${basename}${SWAP_SUFFIX}`);
  writeFileSync(stagedPath, data);
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
    swapped.push(basename);
    logger.info('SYSTEM', 'Applied pending file swap', { basename });
  }

  return swapped;
}
