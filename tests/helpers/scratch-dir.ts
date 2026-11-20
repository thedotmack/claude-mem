import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

/** A fresh temp folder under the repo's gitignored .scratch/test-runs, never the system temp dir. */
export function scratchDir(prefix: string): string {
  const root = join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${prefix}-`));
}
