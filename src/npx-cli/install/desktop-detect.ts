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

export type BrowserOpenOutcome =
  | 'opened'
  | 'skipped-no-desktop'
  | 'skipped-flag'
  | 'skipped-marker'
  | 'skipped-arm'
  | 'failed';

/**
 * Whether to auto-open the sign-in page, or why not. `open` means try it;
 * the caller turns that into `opened` or `failed`. Order: the person's own
 * opt-out first, then the experiment arm, the one-tab-ever marker, and
 * finally the desktop rule.
 */
export function decideSigninBrowserOpen(input: {
  armOpensBrowser: boolean;
  noBrowserFlag: boolean;
  markerExists: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): 'open' | Exclude<BrowserOpenOutcome, 'opened' | 'failed'> {
  if (input.noBrowserFlag || input.env.CLAUDE_MEM_NO_BROWSER === '1') return 'skipped-flag';
  if (!input.armOpensBrowser) return 'skipped-arm';
  if (input.markerExists) return 'skipped-marker';
  if (!isDesktopSession(input.platform, input.env)) return 'skipped-no-desktop';
  return 'open';
}
