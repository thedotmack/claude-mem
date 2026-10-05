/**
 * Expand a leading home-directory marker without changing valid POSIX paths.
 *
 * Both platforms accept the shell-style `~/`, while only Windows treats `~\`
 * as a separator-prefixed home path. On POSIX, backslash is a legal filename
 * character, so `~\foo` must remain untouched.
 */
export { expandHome } from './runtime-settings.cjs';
