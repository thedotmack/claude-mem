/**
 * Whether this run can reasonably open a browser tab the person will see.
 * Pure function of (platform, env) so every combination is table-testable.
 *
 * Desktop = macOS or Windows, or Linux with DISPLAY / WAYLAND_DISPLAY set;
 * and not CI, and not an SSH session. WSL is skipped for now: xdg-open is
 * unreliable there and no WSL opener has been verified.
 */
export function isWsl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  return platform === 'linux' && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

export function isDesktopSession(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (env.CI) return false;
  if (env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  if (platform !== 'linux') return false;
  if (isWsl(platform, env)) return false;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
