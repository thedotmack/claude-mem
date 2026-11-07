import { realpathSync, statSync } from 'node:fs';

/**
 * Identity of an executable on disk: its real path, size and modification
 * time. Reinstalling over the same path changes it, so code that remembered a
 * failing executable can tell "the same broken file" from "repaired in place".
 * Falls back to the path itself when the file cannot be read.
 */
export function executableFingerprint(executablePath: string): string {
  try {
    const resolved = realpathSync(executablePath);
    const stat = statSync(resolved);
    return `${resolved}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return executablePath;
  }
}
