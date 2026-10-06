import { homedir } from 'os';
import { join } from 'path';

/**
 * Expand a leading home-directory marker without changing valid POSIX paths.
 *
 * Both platforms accept the shell-style `~/`, while only Windows treats `~\`
 * as a separator-prefixed home path. On POSIX, backslash is a legal filename
 * character, so `~\foo` must remain untouched.
 */
export function expandHome(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (typeof filePath !== 'string' || filePath.length === 0) return filePath;
  if (filePath === '~') return home;
  if (filePath.startsWith('~/') || (platform === 'win32' && filePath.startsWith('~\\'))) {
    return join(home, filePath.slice(2));
  }
  // A `~user/...` form is intentionally left untouched — resolving another
  // user's home is out of scope and platform-dependent.
  return filePath;
}
